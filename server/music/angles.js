// Углы разнообразия: операции над спекой, дающие структурно другой вариант.
//
// Это НЕ текстовые подсказки для модели. Угол — чистая функция
// (спека, номер варианта) → спека, и результат обязан оставаться валидной
// (checkSpec → ok). Поэтому углы работают с данными библиотеки знаний:
// формами, прогрессиями, матрицей ролей.
//
// Каждый угол перебирает свои варианты и берёт ПЕРВЫЙ, который реально меняет
// спеку. Иначе угол мог бы вернуть исходную спеку «ничего не изменилось» —
// это молчаливый провал: пользователь нажал «ещё вариант» и получил то же
// самое. Если изменить нечего (исчерпаны варианты) — возвращается копия
// исходной спеки.

import { formsForStyle, progressionsForStyle, rolesForStyle } from './knowledge/index.js';
import { cloneSpec, hashText, sameSpec } from './diversity.js';

/** Рецепты в цикле: смена рецепта всегда даёт новое значение. */
const RECIPE_CYCLE = ['default', 'busy', 'sparse'];

/** Трансформации мотива — те же, что понимает компилятор. */
const MOTIF_TRANSFORMS = ['sequence', 'invert', 'shift', 'reverse', 'transpose'];

/**
 * Первый вариант, дающий отличие от исходной спеки.
 *
 * @param {object} spec исходная спека
 * @param {Array} variants варианты угла
 * @param {number} start с какого варианта начинать
 * @param {(variant: any) => object|null} build сборка спеки из варианта
 * @returns {object|null} новая спека или null, если ни один вариант не меняет спеку
 */
function pickDifferent(spec, variants, start, build) {
  if (!variants.length) return null;
  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[(start + i) % variants.length];
    const result = build(variant);
    if (result && !sameSpec(spec, result)) return result;
  }
  return null;
}

/** Секция формы из библиотеки → секция спеки. */
function formSectionToSpec(section) {
  const roles = {};
  for (const role of section.roles || []) roles[role] = { recipe: 'default' };
  const out = {
    kind: section.kind,
    bars: section.bars,
    energy: section.energy,
    roles,
  };
  if (section.transition) out.transition = { ...section.transition };
  return out;
}

/**
 * Угол «форма»: другая форма трека из библиотеки (или та же форма с
 * переставленными секциями — арка энергии читается иначе).
 *
 * Почему форма — самый сильный угол: она меняет и длину трека, и состав
 * секций, то есть скелет, а не отделку.
 */
export function angleForm(spec, start = 0) {
  const forms = formsForStyle(spec.meta.style);
  if (!forms.length) return cloneSpec(spec);

  const variants = [];
  for (const form of forms) variants.push({ mode: 'replace', form });
  for (const form of forms) variants.push({ mode: 'reverse', form });

  const next = pickDifferent(spec, variants, start, (variant) => {
    const sections = variant.form.sections.map(formSectionToSpec);
    if (variant.mode === 'reverse') sections.reverse();
    const out = cloneSpec(spec);
    out.form = sections;
    return out;
  });
  return next || cloneSpec(spec);
}

/**
 * Угол «прогрессия»: другая гармоническая прогрессия того же стиля.
 *
 * Смена прогрессии меняет аккорды во всех секциях сразу — это самый
 * дешёвый по усилиям и самый заметный по слуху способ сделать вариант
 * другим.
 */
export function angleProgression(spec, start = 0) {
  const all = progressionsForStyle(spec.meta.style);
  if (!all.length) return cloneSpec(spec);
  const current = spec.harmony?.progressionId;
  const others = all.filter((item) => item.id !== current);
  const pool = others.length ? others : all;

  const next = pickDifferent(spec, pool, start, (progression) => {
    const out = cloneSpec(spec);
    out.harmony = {
      progressionId: progression.id,
      mode: progression.mode,
      barsPerChord: progression.barsPerChord,
    };
    return out;
  });
  return next || cloneSpec(spec);
}

/**
 * Угол «роли»: другой состав партий и другие рецепты.
 *
 * Варианты: смена рецептов по циклу, снятие лишней партии, добавление
 * партии, «воздух» (sparse) и «плотно» (busy), явный вариант рисунка (A/B/C).
 */
export function angleRoles(spec, start = 0) {
  const styleRoles = rolesForStyle(spec.meta.style);
  const variants = ['cycle', 'strip', 'add', 'sparse', 'busy', 'variant'];

  const next = pickDifferent(spec, variants, start, (variant) => {
    const out = cloneSpec(spec);
    out.form = out.form.map((section) => {
      const next2 = { ...section, roles: { ...section.roles } };
      const roleNames = Object.keys(next2.roles).sort();

      if (variant === 'cycle') {
        for (const role of roleNames) {
          const current = next2.roles[role].recipe || 'default';
          const index = RECIPE_CYCLE.indexOf(current);
          // Следующий по циклу: default → busy → sparse → default.
          // Сдвиг ровно на один — рецепт всегда меняется.
          next2.roles[role] = {
            ...next2.roles[role],
            recipe: RECIPE_CYCLE[(index + 1) % RECIPE_CYCLE.length],
          };
        }
      } else if (variant === 'strip') {
        // Снимаем одну партию, но в секции должен остаться хотя бы один.
        if (roleNames.length > 1) {
          const victim = roleNames[roleNames.length - 1];
          delete next2.roles[victim];
        }
      } else if (variant === 'add') {
        const free = styleRoles.filter((role) => !next2.roles[role]).sort();
        if (free.length) next2.roles[free[0]] = { recipe: 'default' };
      } else if (variant === 'sparse') {
        roleNames.forEach((role, index) => {
          next2.roles[role] = {
            ...next2.roles[role],
            recipe: index === 0 ? 'default' : 'sparse',
          };
        });
      } else if (variant === 'busy') {
        for (const role of roleNames) {
          next2.roles[role] = { ...next2.roles[role], recipe: 'busy' };
        }
      } else if (variant === 'variant') {
        roleNames.forEach((role, index) => {
          next2.roles[role] = {
            ...next2.roles[role],
            variant: ['A', 'B', 'C'][index % 3],
          };
        });
      }
      return next2;
    });
    return out;
  });
  return next || cloneSpec(spec);
}

/**
 * Угол «энергия»: другая арка плотности.
 *
 * Энергия секции — единственное поле спеки, которое напрямую влияет на
 * плотность партий (D-017): интро с энергией 0.8 звучит как дроп. Поэтому
 * перестановка энергий меняет трек без единой новой ноты.
 */
export function angleEnergy(spec, start = 0) {
  const variants = ['rotate', 'invert', 'lift', 'drop', 'contrast', 'peak-swap'];

  const next = pickDifferent(spec, variants, start, (variant) => {
    const out = cloneSpec(spec);
    const energies = out.form.map((section) => Number(section.energy ?? 0.5));
    const count = energies.length;
    if (!count) return out;

    if (variant === 'rotate') {
      out.form.forEach((section, index) => {
        section.energy = Math.round(energies[(index + 1) % count] * 100) / 100;
      });
    } else if (variant === 'invert') {
      out.form.forEach((section, index) => {
        section.energy = Math.round((1 - energies[index]) * 100) / 100;
      });
    } else if (variant === 'lift') {
      out.form.forEach((section, index) => {
        section.energy = Math.round(Math.min(1, energies[index] + 0.15) * 100) / 100;
      });
    } else if (variant === 'drop') {
      out.form.forEach((section, index) => {
        section.energy = Math.round(Math.max(0, energies[index] - 0.15) * 100) / 100;
      });
    } else if (variant === 'contrast') {
      out.form.forEach((section, index) => {
        const value = 0.5 + (energies[index] - 0.5) * 1.6;
        section.energy = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
      });
    } else if (variant === 'peak-swap') {
      let minIndex = 0;
      let maxIndex = 0;
      energies.forEach((value, index) => {
        if (value < energies[minIndex]) minIndex = index;
        if (value > energies[maxIndex]) maxIndex = index;
      });
      const min = energies[minIndex];
      const max = energies[maxIndex];
      out.form[minIndex].energy = max;
      out.form[maxIndex].energy = min;
    }
    return out;
  });
  return next || cloneSpec(spec);
}

/**
 * Угол «мотив»: другой мелодический материал.
 *
 * Если мотива в спеке нет — он появляется (лид получает фразу).
 * Трансформации те же, что компилятор умеет применять к мотиву.
 */
export function angleMotif(spec, start = 0) {
  const variants = MOTIF_TRANSFORMS.concat(['sequence+shift']);

  const next = pickDifferent(spec, variants, start, (variant) => {
    const out = cloneSpec(spec);
    const transforms = variant === 'sequence+shift' ? ['sequence', 'shift'] : [variant];
    const degrees = out.motif?.degrees?.length ? [...out.motif.degrees] : [0, 2, 4];
    if (variant === 'sequence+shift') {
      // Степени мотива живут в 0..11 — сдвиг не должен выйти за пределы.
      for (let i = 0; i < degrees.length; i += 1) {
        degrees[i] = Math.max(0, Math.min(11, degrees[i] + 1));
      }
    }
    out.motif = {
      ...(out.motif || {}),
      degrees,
      transforms,
    };
    return out;
  });
  return next || cloneSpec(spec);
}

/** Все углы: имя → функция. */
export const ANGLES = {
  form: angleForm,
  progression: angleProgression,
  roles: angleRoles,
  energy: angleEnergy,
  motif: angleMotif,
};

/** Имена углов в фиксированном порядке — порядок важен для детерминизма. */
export const ANGLE_NAMES = Object.keys(ANGLES);

/**
 * Применить угол к спеке.
 *
 * @param {object} spec
 * @param {string} angleName имя угла из ANGLE_NAMES
 * @param {number} [seed] зерно: сдвигает выбор варианта внутри угла
 * @returns {object} новая спека (или копия исходной, если угол ничего не меняет)
 */
export function applyAngle(spec, angleName, seed = 0) {
  const angle = ANGLES[angleName];
  if (!angle) return cloneSpec(spec);
  const start = hashText(`${seed}|${angleName}`) % 16;
  return angle(spec, start);
}
