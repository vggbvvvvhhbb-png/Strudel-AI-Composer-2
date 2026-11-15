// ProjectModel — модель проекта мини-студии (Zod).
//
// Это продолжение спеки v2 (`src/schemas/track-spec.schema.js`): музыкальное
// содержание (стиль, темп, тональность, форма, партии) остаётся в `spec`,
// а студийный слой (микс, мастер, автоматизация, переходы, seed) добавлен
// сверху. Модель — единственный источник истины: GUI, ассистент, автосмей
// и компилятор работают только с ней.
//
// Модель детерминирована: никаких Date.now()/Math.random() в значениях,
// никаких порядков «как попало» — canonicalJson стабилен, поэтому undo
// возвращает проект бит-в-бит.

import { z } from 'zod';
import { TrackSpecSchema, PartSchema } from '../schemas/track-spec.schema.js';
import { PART_ID_RE, ROLES, refinePartIdentity } from '../schemas/parts.js';

export const PROJECT_VERSION = 'v3';

// Библиотечные роли живут в одном месте (src/schemas/parts.js). Здесь —
// обратная совместимость для потребителей, которые импортируют ROLES отсюда.
export { ROLES };

// Варианты партии: `recipe` — идентификатор ритмического рецепта из
// библиотеки знаний, `notes` — свободные заметки (текст), которые модель
// читает, но которые не влияют на звук сами по себе.
export const VARIANT_KINDS = ['recipe', 'notes'];

const VariantSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(VARIANT_KINDS),
  value: z.string(),
});

// Спека студии = спека v2 + варианты партии.
// Схему v2 нельзя просто переиспользовать: Zod вырезает поля, которых нет
// в схеме, а варианты нужны как часть модели проекта.
const StudioRoleSchema = PartSchema.extend({
  variants: z.array(VariantSchema).max(8).default([]),
});

export const StudioSpecSchema = TrackSpecSchema.extend({
  parts: TrackSpecSchema.shape.parts.extend({
    // Ключ — идентификатор партии (D-100). Роль — атрибут `role`.
    roles: z.record(
      z.string().regex(PART_ID_RE, 'идентификатор партии: латиница, цифры, подчёркивание'),
      StudioRoleSchema
    ).superRefine(refinePartIdentity),
  }),
});

const PartMixSchema = z.object({
  gainDb: z.number().min(-60).max(12).default(0),
  pan: z.number().min(-1).max(1).default(0),
  hpf: z.number().min(0).max(2000).default(0),
  lpf: z.number().min(1000).max(20000).default(20000),
  sends: z.object({
    delay: z.number().min(0).max(1).default(0),
    room: z.number().min(0).max(1).default(0),
  }).default({ delay: 0, room: 0 }),
  duck: z.object({
    // Роль-жертва дакинга (по ней строится gain-огибающая в компиляторе).
    target: z.string().nullable().default(null),
    depth: z.number().min(0).max(1).default(0),
    attackMs: z.number().min(5).max(30).default(10),
    releaseMs: z.number().min(100).max(400).default(200),
  }).default({ target: null, depth: 0, attackMs: 10, releaseMs: 200 }),
});

const MasterSchema = z.object({
  // Целевой уровень проекта и коридор приёмки живут в модели; платформенные
  // цифры (H10) в UI не хардкодятся — это только комментарий со ссылкой.
  targetLufs: z.number().min(-24).max(-9).default(-14),
  ceilingDbtp: z.number().min(-3).max(0).default(-1),
  eq: z.object({
    lowDb: z.number().min(-12).max(12).default(0),
    highDb: z.number().min(-12).max(12).default(0),
  }).default({ lowDb: 0, highDb: 0 }),
  comp: z.object({
    thresholdDb: z.number().min(-24).max(-18).default(-20),
    ratio: z.number().min(2).max(4).default(3),
    attackMs: z.number().min(10).max(50).default(20),
    releaseMs: z.number().min(100).max(300).default(200),
  }).default({ thresholdDb: -20, ratio: 3, attackMs: 20, releaseMs: 200 }),
  limiter: z.object({
    lookaheadMs: z.number().min(4).max(16).default(5),
    ceilingDbtp: z.number().min(-3).max(0).default(-1),
  }).default({ lookaheadMs: 5, ceilingDbtp: -1 }),
  bypass: z.boolean().default(false),
});

const AutomationSchema = z.object({
  id: z.string().min(1),
  target: z.union([
    // Секция адресуется именем: в спеке v2 у секций нет собственных id,
    // а партии ссылаются на секции именно по имени (activeIn).
    z.object({ kind: z.literal('section'), id: z.string().min(1) }),
    // Партия адресуется идентификатором (`VIOLIN_1`), а не ролью (D-100):
    // правка «скрипка №3» должна попадать в конкретную дорожку.
    z.object({ kind: z.literal('part'), id: z.string().min(1) }),
  ]),
  param: z.enum(['gain', 'cutoff', 'energy']),
  curve: z.object({
    type: z.enum(['ramp', 'sine', 'step']).default('ramp'),
    from: z.number(),
    to: z.number(),
    bars: z.number().int().min(1).max(64),
  }),
});

const TransitionSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(['fill', 'riser', 'cut', 'none']).default('none'),
  amount: z.number().min(0).max(1).default(0.5),
});

export const ProjectModelSchema = z.object({
  version: z.literal(PROJECT_VERSION).default(PROJECT_VERSION),
  id: z.string().min(1),
  seed: z.number().int().min(0).max(2147483647),
  spec: StudioSpecSchema,
  mix: z.object({
    // Ключи — идентификаторы партий из spec.parts.roles; проверка ниже.
    parts: z.record(z.string(), PartMixSchema),
    masterGainDb: z.number().min(-24).max(6).default(0),
  }),
  master: MasterSchema,
  automation: z.array(AutomationSchema).max(64).default([]),
  transitions: z.array(TransitionSchema).max(32).default([]),
}).superRefine((model, ctx) => {
  // Микс и автоматизация адресуют партии, а не роли: ключ микса должен
  // существовать в спеке, иначе правка уйдёт «в никуда» (D-100).
  const ids = new Set(Object.keys(model.spec.parts.roles));
  for (const id of Object.keys(model.mix.parts)) {
    if (!ids.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mix', 'parts', id],
        message: `неизвестная партия «${id}»: такой партии нет в spec.parts.roles`,
      });
    }
  }
  model.automation.forEach((item, index) => {
    if (item.target.kind !== 'part') return;
    if (!ids.has(item.target.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['automation', index, 'target', 'id'],
        message: `неизвестная партия «${item.target.id}»: такой партии нет в spec.parts.roles`,
      });
    }
  });
});

/** Валидирует модель; бросает ZodError с понятным сообщением. */
export function validateProjectModel(data) {
  return ProjectModelSchema.parse(data);
}

/** Безопасная валидация: { ok, data } | { ok:false, error }. */
export function safeValidateProjectModel(data) {
  const result = ProjectModelSchema.safeParse(data);
  return result.success ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

/**
 * Канонический JSON: ключи отсортированы, порядок массивов значим.
 * От него зависят хеш компилированного кода и round-trip, поэтому формат
 * менять нельзя без миграции версий.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** Дефолтная микс-карта для набора ролей. */
export function defaultMix(roles) {
  const parts = {};
  for (const role of roles) parts[role] = PartMixSchema.parse({});
  return { parts, masterGainDb: 0 };
}

/**
 * Проект из спеки v2: студийный слой заполняется дефолтами.
 * seed по умолчанию — детерминированный, от id проекта.
 */
export function projectFromSpec(spec, { id = 'project', seed } = {}) {
  const validated = StudioSpecSchema.parse(spec);
  const roles = Object.keys(validated.parts.roles);
  const project = {
    version: PROJECT_VERSION,
    id,
    seed: seed ?? hashToSeed(id),
    spec: validated,
    mix: defaultMix(roles),
    master: MasterSchema.parse({}),
    automation: [],
    transitions: [],
  };
  return ProjectModelSchema.parse(project);
}

/** Стабильный seed из строки (FNV-1a 32-bit) — без случайности. */
export function hashToSeed(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // 31 значащих бит: старший бит отбрасывается, чтобы seed помещался в
  // знаковый 32-битный диапазон (иначе проекты с id давали бы разные зёрна
  // в разных рантаймах из-за разницы в представлении чисел).
  return (hash & 0x7fffffff) >>> 0;
}

/** Общее число тактов проекта. */
export function totalBars(model) {
  return model.spec.structure.sections.reduce((sum, section) => sum + section.cycles, 0);
}

/** Плейлист секций с их тактовыми границами. */
export function sectionTimeline(model) {
  let bar = 0;
  return model.spec.structure.sections.map((section) => {
    const startBar = bar;
    bar += section.cycles;
    return { ...section, startBar, endBar: bar };
  });
}
