// Проверка согласованности спеки.
//
// Zod проверяет ФОРМУ (типы, диапазоны). Здесь проверяется СОДЕРЖАНИЕ:
// роли активны только в существующих секциях, степени в ладу, длина трека
// в допустимых границах.
//
// Результат: { ok, errors, warnings, normalized }
// `normalized` — исправленная спека: к ней приводятся ссылки на прогрессии
// и роли, чтобы дальше работать с гарантированно валидными данными.

import { trackSpecSchema, SPEC_ROLES } from './schema.js';
import { progressionById, progressionsForStyle, ROLE_MATRIX } from '../knowledge/index.js';

/** Допустимая длина трека в тактах. */
export const MIN_BARS = 16;
export const MAX_BARS = 96;

/**
 * Разбирает тональность "c:minor" в {root, mode}.
 * @returns {{root: string, mode: string}|null}
 */
export function parseSpecKey(key) {
  const raw = String(key ?? '').trim().toLowerCase().replace(/^["'`]|["'`]$/g, '');
  const m = raw.match(/^([a-g])([#b]?):(.+)$/);
  if (!m) return null;
  return { root: `${m[1]}${m[2]}`, mode: m[3].trim() };
}

/**
 * Проверяет и нормализует спеку.
 * @param {object} raw спека от модели или пользователя
 * @returns {{ok: boolean, errors: string[], warnings: string[], spec: object|null}}
 */
export function checkSpec(raw) {
  const errors = [];
  const warnings = [];

  const parsed = trackSpecSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      errors.push(`${path || 'спека'}: ${issue.message}`);
    }
    return { ok: false, errors, warnings, spec: null };
  }

  const spec = parsed.data;

  // --- тональность ---
  const key = parseSpecKey(spec.meta.key);
  if (!key) {
    errors.push(`meta.key: «${spec.meta.key}» не разбирается как «c:minor»`);
  }

  // --- гармония: прогрессия из библиотеки или своя ---
  const harmony = spec.harmony || {};
  let progression = null;
  if (harmony.progressionId) {
    progression = progressionById(harmony.progressionId);
    if (!progression) {
      errors.push(`harmony.progressionId: «${harmony.progressionId}» нет в библиотеке`);
    } else if (progression.style !== spec.meta.style) {
      warnings.push(
        `harmony.progressionId: «${progression.id}» из стиля ${progression.style}, а трек — ${spec.meta.style}`,
      );
    }
  } else if (harmony.degrees && harmony.degrees.length >= 2) {
    progression = {
      id: 'custom',
      style: spec.meta.style,
      mode: harmony.mode || key?.mode || 'minor',
      degrees: harmony.degrees,
      barsPerChord: harmony.barsPerChord || 2,
      feel: 'custom',
      tags: ['custom'],
      source: 'own',
      verified: true,
    };
  } else {
    errors.push('harmony: нужны progressionId или degrees (минимум 2 степени)');
  }

  // Степени в ладу: 0..6 — ступени семиступенного лада.
  if (progression) {
    for (const d of progression.degrees) {
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        errors.push(`harmony.degrees: степень ${d} вне лада (допустимо 0..6)`);
      }
    }
  }

  // --- форма ---
  const totalBars = spec.form.reduce((sum, s) => sum + s.bars, 0);
  if (totalBars < MIN_BARS) {
    errors.push(`form: ${totalBars} тактов — меньше минимума ${MIN_BARS}`);
  }
  if (totalBars > MAX_BARS) {
    errors.push(`form: ${totalBars} тактов — больше максимума ${MAX_BARS}`);
  }

  const styleRoles = ROLE_MATRIX[spec.meta.style] || {};
  const sectionIndexes = new Set(spec.form.map((_, index) => index));

  spec.form.forEach((section, index) => {
    // Роли существуют и поддерживаются стилем.
    for (const role of Object.keys(section.roles)) {
      if (!SPEC_ROLES.includes(role)) {
        errors.push(`form[${index}].roles: неизвестная роль «${role}»`);
        continue;
      }
      if (!styleRoles[role]) {
        errors.push(`form[${index}].roles: роль «${role}» не поддерживается стилем ${spec.meta.style}`);
      }
    }
    if (Object.keys(section.roles).length === 0) {
      errors.push(`form[${index}].roles: секция без партий`);
    }

    // Переход ведёт в существующую секцию.
    if (section.transition) {
      const target = spec.form.findIndex((s) => s.kind === section.transition.into);
      if (target < 0) {
        errors.push(
          `form[${index}].transition.into: секции «${section.transition.into}» в треке нет`,
        );
      } else if (target <= index) {
        warnings.push(
          `form[${index}].transition.into: ведёт назад (в секцию ${target})`,
        );
      }
    }

    // Переопределение прогрессии в секции тоже должно быть в ладу.
    if (section.progressionOverride?.degrees) {
      for (const d of section.progressionOverride.degrees) {
        if (!Number.isInteger(d) || d < 0 || d > 6) {
          errors.push(`form[${index}].progressionOverride.degrees: степень ${d} вне лада`);
        }
      }
    }
    if (section.progressionOverride?.progressionId && !progressionById(section.progressionOverride.progressionId)) {
      errors.push(
        `form[${index}].progressionOverride.progressionId: «${section.progressionOverride.progressionId}» нет в библиотеке`,
      );
    }
  });

  // --- автоматизация: цели существуют среди ролей трека ---
  const usedRoles = new Set(spec.form.flatMap((s) => Object.keys(s.roles)));
  for (const [index, automation] of (spec.automation || []).entries()) {
    if (!usedRoles.has(automation.target)) {
      warnings.push(
        `automation[${index}].target: роль «${automation.target}» не играет ни в одной секции`,
      );
    }
    if (automation.toBar <= automation.fromBar) {
      errors.push(`automation[${index}]: toBar (${automation.toBar}) должен быть больше fromBar (${automation.fromBar})`);
    }
    if (automation.toBar > totalBars) {
      warnings.push(
        `automation[${index}]: toBar (${automation.toBar}) выходит за длину трека (${totalBars})`,
      );
    }
  }

  if (errors.length) return { ok: false, errors, warnings, spec: null };
  return { ok: true, errors, warnings, spec };
}

/**
 * Прогрессия для секции: своя или общая.
 * @param {object} spec
 * @param {number} index индекс секции
 */
export function progressionForSection(spec, index) {
  const section = spec.form[index];
  const override = section?.progressionOverride;
  if (override?.progressionId) {
    const found = progressionById(override.progressionId);
    if (found) {
      return {
        ...found,
        mode: override.mode || found.mode,
        barsPerChord: override.barsPerChord || found.barsPerChord,
      };
    }
  }
  if (override?.degrees && override.degrees.length >= 2) {
    return {
      id: `custom-${index}`,
      style: spec.meta.style,
      mode: override.mode || spec.harmony.mode || 'minor',
      degrees: override.degrees,
      barsPerChord: override.barsPerChord || spec.harmony.barsPerChord || 2,
      feel: 'custom',
      tags: ['custom'],
      source: 'own',
      verified: true,
    };
  }
  const harmony = spec.harmony || {};
  if (harmony.degrees && harmony.degrees.length >= 2) {
    return {
      id: 'custom',
      style: spec.meta.style,
      mode: harmony.mode || spec.meta.key.split(':')[1] || 'minor',
      degrees: harmony.degrees,
      barsPerChord: harmony.barsPerChord || 2,
      feel: 'custom',
      tags: ['custom'],
      source: 'own',
      verified: true,
    };
  }
  const found = progressionById(harmony.progressionId);
  if (found) return found;
  // Запасной вариант: первая прогрессия стиля.
  const fallback = progressionsForStyle(spec.meta.style)[0];
  if (fallback) return fallback;
  return {
    id: 'fallback',
    style: spec.meta.style,
    mode: 'minor',
    degrees: [0, 5, 2, 6],
    barsPerChord: 2,
    feel: 'fallback',
    tags: ['fallback'],
    source: 'own',
    verified: true,
  };
}
