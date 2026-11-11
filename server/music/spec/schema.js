// Схема трека v2 — Zod как единственный источник истины.
//
// Из этой же схемы получается JSON Schema для `response_format` провайдера:
// LLM выбирает ИДЕИ, а не пишет код. Код собирает компилятор.
//
// Структура спеки:
//   meta      — стиль, темп, тональность, зерно
//   harmony   — прогрессия: id из библиотеки или свои степени
//   form      — секции: вид, длина, энергия, роли, переход
//   motif     — мелодический материал и его трансформации
//   automation— кривые движения параметров
//   reasoning — короткое объяснение для трейса
//
// Инварианты, которые проверяются отдельно (функция checkSpec):
//   • роли активны только в существующих секциях;
//   • степени в ладу;
//   • суммарная длина 16–96 тактов.

import { z } from 'zod';

// Лады, которые понимает Strudel (полные имена одним словом).
export const SCALE_MODES = [
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian',
  'ionian', 'aeolian', 'pentatonic', 'blues', 'chromatic',
];

// Стили, для которых есть полный набор знаний.
export const SPEC_STYLES = [
  'lofi', 'techno', 'house', 'ambient', 'dnb', 'synthwave', 'trap', 'jazz', 'rock', 'cinematic',
];

// Роли партий.
export const SPEC_ROLES = [
  'kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'pad', 'chords', 'lead', 'arp', 'fx', 'texture',
];

// Виды секций формы.
export const SECTION_KINDS = [
  'intro', 'build', 'drop', 'breakdown', 'fill', 'outro', 'verse', 'chorus', 'bridge',
];

// Типы переходов.
export const TRANSITION_TYPES = ['build', 'drop', 'breakdown', 'riser', 'fill'];

/** Рецепты партии из библиотеки знаний. */
export const RECIPE_NAMES = ['default', 'busy', 'sparse'];

/** Варианты партии в секции. */
export const VARIANT_NAMES = ['A', 'B', 'C'];

/**
 * Степень лада. Ошибка формулируется по-русски: это сообщение уходит
 * обратно модели, которая правит спеку, — поэтому оно должно называть
 * проблему, а не механизм проверки.
 */
const degreeSchema = z
  .number()
  .int('степень должна быть целым числом')
  .min(0, 'степень вне лада (допустимо 0..6)')
  .max(6, 'степень вне лада (допустимо 0..6)');

/** Вариант партии в секции: рецепт из библиотеки + индекс варианта. */
export const roleChoiceSchema = z.object({
  recipe: z.enum(RECIPE_NAMES),
  variant: z.enum(VARIANT_NAMES).optional(),
});

/** Секция трека. */
export const sectionSchema = z.object({
  kind: z.enum(SECTION_KINDS),
  bars: z.number().int().min(4).max(32),
  energy: z.number().min(0).max(1),
  progressionOverride: z
    .object({
      progressionId: z.string().max(80).optional(),
      degrees: z.array(degreeSchema).min(2).max(8).optional(),
      mode: z.enum(SCALE_MODES).optional(),
      barsPerChord: z.number().int().min(1).max(8).optional(),
    })
    .optional(),
  roles: z.record(z.string(), roleChoiceSchema),
  transition: z
    .object({
      into: z.enum(SECTION_KINDS),
      type: z.enum(TRANSITION_TYPES),
    })
    .optional(),
});

/** Гармония трека. */
export const harmonySchema = z.object({
  progressionId: z.string().max(80).optional(),
  degrees: z.array(degreeSchema).min(2).max(8).optional(),
  mode: z.enum(SCALE_MODES).optional(),
  barsPerChord: z.number().int().min(1).max(8).optional(),
});

/** Мелоический материал. */
export const motifSchema = z.object({
  degrees: z.array(z.number().int().min(0).max(11)).min(1).max(16),
  rhythm: z.string().max(80).optional(),
  transforms: z.array(z.enum(['sequence', 'invert', 'shift', 'reverse', 'transpose'])).max(4).optional(),
});

/** Кривая автоматизации. */
export const automationSchema = z.object({
  target: z.enum(['pad', 'bass', 'chords', 'lead', 'arp', 'hats', 'sub', 'texture']),
  curve: z.enum(['sweep', 'swell', 'fade', 'motion']),
  fromBar: z.number().int().min(0).max(96),
  toBar: z.number().int().min(0).max(96),
  range: z.array(z.number()).length(2).optional(),
});

/** Метаданные трека. */
export const metaSchema = z.object({
  style: z.enum(SPEC_STYLES),
  bpm: z.number().int().min(50).max(190),
  key: z.string().min(2).max(20),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
});

/** Полная спека трека. */
export const trackSpecSchema = z.object({
  meta: metaSchema,
  harmony: harmonySchema,
  form: z.array(sectionSchema).min(2).max(12),
  motif: motifSchema.optional(),
  automation: z.array(automationSchema).max(8).optional(),
  reasoning: z.string().max(600).optional(),
});

/**
 * JSON Schema для `response_format` провайдера.
 * Строится из Zod-схемы, чтобы контракт с LLM и валидация не расходились.
 */
export function jsonSchemaForSpec() {
  const roleChoice = {
    type: 'object',
    additionalProperties: false,
    properties: {
      recipe: {
        type: 'string',
        enum: RECIPE_NAMES,
        description:
          'default — обычная плотность роли; busy — плотнее; sparse — реже. Рисунок выбирается из библиотеки знаний.',
      },
      variant: { type: 'string', enum: VARIANT_NAMES },
    },
    required: ['recipe'],
  };
  const section = {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: SECTION_KINDS },
      bars: { type: 'integer', minimum: 4, maximum: 32 },
      energy: { type: 'number', minimum: 0, maximum: 1 },
      progressionOverride: {
        type: 'object',
        additionalProperties: false,
        properties: {
          progressionId: { type: 'string' },
          degrees: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
          mode: { type: 'string', enum: SCALE_MODES },
          barsPerChord: { type: 'integer', minimum: 1, maximum: 8 },
        },
      },
      roles: { type: 'object', additionalProperties: roleChoice },
      transition: {
        type: 'object',
        additionalProperties: false,
        properties: {
          into: { type: 'string', enum: SECTION_KINDS },
          type: { type: 'string', enum: TRANSITION_TYPES },
        },
        required: ['into', 'type'],
      },
    },
    required: ['kind', 'bars', 'energy', 'roles'],
  };
  return {
    name: 'track_spec_v2',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        meta: {
          type: 'object',
          additionalProperties: false,
          properties: {
            style: { type: 'string', enum: SPEC_STYLES },
            bpm: { type: 'integer', minimum: 50, maximum: 190 },
            key: { type: 'string', description: 'Тональность в формате "c:minor"' },
            seed: { type: 'integer', minimum: 0 },
          },
          required: ['style', 'bpm', 'key'],
        },
        harmony: {
          type: 'object',
          additionalProperties: false,
          properties: {
            progressionId: { type: 'string' },
            degrees: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
            mode: { type: 'string', enum: SCALE_MODES },
            barsPerChord: { type: 'integer', minimum: 1, maximum: 8 },
          },
        },
        form: { type: 'array', items: section },
        motif: {
          type: 'object',
          additionalProperties: false,
          properties: {
            degrees: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 11 } },
            rhythm: { type: 'string' },
            transforms: {
              type: 'array',
              items: { type: 'string', enum: ['sequence', 'invert', 'shift', 'reverse', 'transpose'] },
            },
          },
          required: ['degrees'],
        },
        automation: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              target: { type: 'string', enum: ['pad', 'bass', 'chords', 'lead', 'arp', 'hats', 'sub', 'texture'] },
              curve: { type: 'string', enum: ['sweep', 'swell', 'fade', 'motion'] },
              fromBar: { type: 'integer', minimum: 0, maximum: 96 },
              toBar: { type: 'integer', minimum: 0, maximum: 96 },
              range: { type: 'array', items: { type: 'number' } },
            },
            required: ['target', 'curve', 'fromBar', 'toBar'],
          },
        },
        reasoning: { type: 'string' },
      },
      required: ['meta', 'harmony', 'form'],
    },
  };
}
