// Идентичность партии и роль — единый источник (D-100).
//
// До фазы C ключ записи в `parts.roles` БЫЛ ролью: `parts.roles.kick`.
// Схема ограничивала роли enum'ом из 12 значений, поэтому трек из 100
// дорожек был физически невозможен (проверено: tests/spike/parts-100.probe.mjs
// — IR, TrackSpec и StudioSpec одинаково отклоняли 100 частей).
//
// Теперь: ключ — идентификатор партии (`P001`, `VIOLIN_1`, `HORN_2`), а роль
// (`kick`, `bass`, `violin`) — атрибут партии, а не ключ. Дубли ролей
// разрешены: `VIOLIN_1` и `VIOLIN_2` — две разные дорожки одной роли.
//
// Старая форма не сломана: если поле `role` не указано, роль выводится из
// ключа, а ключи ролей совпадают с именами ролей. Поэтому легаси-спеки
// (corpus, gold-set, промпты) валидируются как раньше.

import { z } from 'zod';

// Библиотечные роли. Это НЕ потолок: роль — строка, а не enum, поэтому
// `violin`, `choir_soprano`, `horn_2` допустимы и проверяются по формату.
export const ROLES = [
  'kick', 'snare', 'hats', 'perc', 'sub',
  'bass', 'pad', 'chords', 'lead', 'arp', 'fx', 'texture',
];

// Имя роли: строчные, буквы/цифры/подчёркивание. «KAZOO» — не роль.
export const ROLE_RE = /^[a-z][a-z0-9_]*$/;

// Идентификатор партии: буква, дальше буквы/цифры/подчёркивание.
// Становится меткой в коде: `VIOLIN_1` -> `$VIOLIN_1:`.
export const PART_ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

// Роли, которые играют сэмплами (ударные/перкуссия), а не ноты.
export const SAMPLED_ROLES = new Set(['kick', 'snare', 'hats', 'perc', 'fx']);

// Транспозиция по роли (полутона). Неизвестная роль — без транспозиции.
export const ROLE_TRANSPOSE = { sub: -24, bass: -24, arp: 12, lead: 12 };

/** Роль из библиотеки знаний? */
export function isRole(value) {
  return ROLES.includes(value);
}

/**
 * Роль партии: явное поле `role`, иначе — вывод из ключа (легаси-форма).
 * Возвращает null, если роль определить нельзя: такая партия невалидна.
 */
export function roleOf(id, part) {
  const declared = part && typeof part.role === 'string' ? part.role : null;
  if (declared) return declared;
  return isRole(id) ? id : null;
}

/** Метка партии в коде: идентификатор в верхнем регистре. */
export function partLabel(id) {
  return String(id).toUpperCase();
}

/** Роль играет сэмплом, а не нотами? */
export function isSampledRole(role) {
  return SAMPLED_ROLES.has(role);
}

/** Транспозиция роли (полутона), 0 для неизвестной роли. */
export function transposeFor(role) {
  return ROLE_TRANSPOSE[role] ?? 0;
}

/**
 * Список партий трека: [{id, label, role, part}].
 * Порядок детерминированный — по идентификатору.
 */
export function listParts(parts) {
  const roles = parts?.roles ?? {};
  return Object.keys(roles).sort((a, b) => a.localeCompare(b, 'en')).map((id) => ({
    id,
    label: partLabel(id),
    role: roleOf(id, roles[id]),
    part: roles[id],
  }));
}

/** Карта «метка -> идентификатор» — чтобы найти партию по метке в коде. */
export function labelIndex(parts) {
  const map = new Map();
  for (const item of listParts(parts)) map.set(item.label, item.id);
  return map;
}

/**
 * Проверка идентичности партий для Zod: у каждой партии определена роль,
 * метки уникальны. Ошибки — с путём до конкретной партии.
 */
export function refinePartIdentity(roles, ctx) {
  const labels = new Map();
  for (const [id, part] of Object.entries(roles ?? {})) {
    const role = roleOf(id, part);
    if (!role) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [id, 'role'],
        message: 'роль партии не определена: добавь поле role (например, role: "bass")',
      });
      continue;
    }
    if (!ROLE_RE.test(role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [id, 'role'],
        message: `роль «${role}» недопустима: строчные буквы, цифры и подчёркивание`,
      });
      continue;
    }
    const label = partLabel(id);
    if (labels.has(label)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [id],
        message: `метка партии не уникальна: «${label}» уже занята партией «${labels.get(label)}»`,
      });
      continue;
    }
    labels.set(label, id);
  }
}
