// Composition IR — типизированный план композиции.
//
// Это слой НАД спекой v2 (`src/schemas/track-spec.schema.js`). Спека описывает
// готовые паттерны и эффекты; IR описывает ЗАМЫСЕЛ: настроение, форму,
// гармонию римскими цифрами, мотивы, грув, палитру.
//
// Зачем промежуточный слой (бриф v2, §5.2):
//   • LLM выдаёт IR, а не сырой код: вывод модели не может стать исполняемым
//     кодом без проверки, а IR проходит Zod;
//   • правка «сделай мрачнее» — это чистая функция IR→IR с объявленным знаком
//     изменения метрик, а не перегенерация;
//   • детерминированный компилятор IR→код даёт одинаковый звук по одному IR.
//
// Схема намеренно строгая: всё, что не прошло Zod, не попадает в компилятор.

import { z } from 'zod';

/** Роли студии. Совпадают с ROLES в `src/studio/model.js`. */
export const IR_ROLES = [
  'kick', 'snare', 'hats', 'perc', 'sub',
  'bass', 'pad', 'chords', 'lead', 'arp', 'fx', 'texture',
];

/** Лады, которые понимает движок Strudel (полные имена, одно слово). */
export const IR_MODES = [
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
];

/** Шаблоны грува. Имена совпадают с картой groove-templates. */
export const IR_GROOVE_TEMPLATES = [
  'straight', 'swing', 'laidback', 'funk', 'halftime', 'drunken',
];

/** Виды плана партии — определяет, как компилятор строит рисунок. */
export const IR_PLANS = [
  'drums', 'bassline', 'chords', 'melody', 'arp', 'pad', 'fx', 'texture',
];

/** Виды секций. Расширяют набор спеки v2: арка из карты arrangement-arcs. */
export const IR_SECTION_KINDS = [
  'intro', 'verse', 'build', 'peak', 'break', 'outro',
  'chorus', 'drop', 'air', 'grow', 'bloom', 'fade',
];

const ModeSchema = z.enum(IR_MODES);
const RoleSchema = z.enum(IR_ROLES);

export const MoodSchema = z.object({
  // Непрерывная шкала, а не четыре коробки: бриф §5.6.
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(-1).max(1),
  // Ярлык настроения может отсутствовать: тогда план строится по вектору.
  label: z.string().max(40).nullish(),
  modifiers: z.array(z.string().max(30)).max(8).default([]),
});

export const KeySchema = z.object({
  tonic: z.string().regex(/^[A-G][#b]?$/),
  mode: ModeSchema,
});

/**
 * Палитра: ссылка на источник звука для роли.
 * ref — либо имя сэмпла из паспорта, либо `gm:program`, либо `synth:name`.
 */
export const PaletteEntrySchema = z.object({
  ref: z.string().min(1).max(80),
  gainDb: z.number().min(-24).max(6).optional(),
});

export const GrooveSchema = z.object({
  template: z.enum(IR_GROOVE_TEMPLATES),
  // Насколько сильно применяется шаблон: 0 — прямая сетка, 1 — полный.
  amount: z.number().min(0).max(1).default(1),
  // Доля свинга 0.5 — ровно, 0.66 — треоль. Заполняется компилятором грува.
  swing: z.number().min(0.5).max(0.68).optional(),
  // Ритм баса: слоты на 1/8 такта, 'x' — удар, '~' — пауза.
  // Если не задан — берётся из жанра и настроения (см. bassRhythm).
  bassRhythm: z.string().max(32).optional(),
  // Общий сдвиг роли в миллисекундах (поздний/ранний).
  offsetMs: z.number().min(-20).max(20).default(0),
});

export const LayerSchema = z.object({
  plan: z.enum(IR_PLANS),
  // Плотность партии в долях от максимума роли (0…1).
  density: z.number().min(0).max(1).default(0.5),
  // Регистр партии в MIDI-нотах: [низ, верх].
  register: z.tuple([z.number().int().min(24).max(96), z.number().int().min(24).max(96)]),
  gainDb: z.number().min(-24).max(6).optional(),
  // Частота среза фильтра роли в Гц: «мрачнее» — это в том числе она.
  lpf: z.number().int().min(120).max(20000).optional(),
  // Множитель роли в секции: 1 — как есть, 0 — роли нет.
  weight: z.number().min(0).max(1).default(1),
  motifId: z.string().max(40).optional(),
});

/**
 * Гармонический шаг: римская цифра в ладу тональности.
 * Числовые цифры (7, 9, 13) и цвет (sus/add9/borrowed) хранятся отдельно,
 * чтобы компилятор мог собрать символ аккорда для движка.
 */
export const HarmonyStepSchema = z.object({
  // Римская цифра с необязательным «хвостом» качества: I, vi, bII, Imaj7, V7.
  rn: z.string().regex(/^[b#]?[ivIV]+(maj7|min7|7)?$/),
  quality: z.enum(['major', 'minor', 'dim', 'aug']).optional(),
  color: z.enum(['sus', 'add9', '7', 'borrowed', 'picardy', 'pedal']).optional(),
  bars: z.number().int().min(1).max(16),
});

export const SectionSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(IR_SECTION_KINDS),
  bars: z.number().int().min(1).max(32),
  energy: z.number().min(0).max(1),
  tension: z.number().min(0).max(1),
  harmony: z.array(HarmonyStepSchema).min(1).max(16),
  layers: z.record(RoleSchema, LayerSchema),
  enter: z.enum(['riser', 'filter-open', 'fill', 'silence', 'none']).optional(),
});

export const MotifSchema = z.object({
  // Степени лада (0 — тоника). null означает паузу.
  degrees: z.array(z.number().int().min(-14).max(14).nullable()).min(1).max(32),
  // Шаги 16-й сетки, на которых стоят степени.
  steps: z.array(z.number().int().min(0).max(15)).min(1).max(32),
  durations: z.array(z.number().min(0.25).max(8)).max(32).optional(),
});

export const MixSchema = z.object({
  sidechain: z.array(z.object({
    src: RoleSchema,
    dst: RoleSchema,
    depth: z.number().min(0).max(1),
  })).max(16).default([]),
  pan: z.record(RoleSchema, z.number().min(-1).max(1)).default({}),
  // Orbit — реверберация/дилей по ролям: один delay/reverb на orbit.
  orbit: z.record(RoleSchema, z.number().int().min(1).max(8)).default({}),
});

export const MetaSchema = z.object({
  title: z.string().max(120).default('Без названия'),
  bpm: z.number().min(40).max(200),
  meter: z.enum(['4/4', '3/4', '6/8']).default('4/4'),
  key: KeySchema,
  mood: MoodSchema,
  genre: z.string().max(40).optional(),
  // Стиль студии (lo-fi, techno, …) — нужен библиотеке знаний и палитре.
  style: z.string().max(40).optional(),
});

export const CompositionIRSchema = z.object({
  v: z.literal(1),
  seed: z.number().int().min(0).max(2147483647),
  meta: MetaSchema,
  palette: z.record(RoleSchema, PaletteEntrySchema).default({}),
  motifs: z.record(z.string().max(40), MotifSchema).default({}),
  sections: z.array(SectionSchema).min(1).max(12),
  groove: GrooveSchema,
  mix: MixSchema.default({ sidechain: [], pan: {}, orbit: {} }),
});

/** Строгая проверка: бросает ZodError с понятным сообщением. */
export function validateIR(data) {
  return CompositionIRSchema.parse(data);
}

/** Безопасная проверка: { ok, data } | { ok: false, error }. */
export function safeValidateIR(data) {
  const result = CompositionIRSchema.safeParse(data);
  return result.success ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

/**
 * Глубокая копия IR.
 * JSON достаточно: IR состоит только из чисел, строк и массивов.
 * @param {object} ir
 */
export function cloneIR(ir) {
  return JSON.parse(JSON.stringify(ir));
}

/** Общее число тактов трека. */
export function irBars(ir) {
  return ir.sections.reduce((sum, section) => sum + section.bars, 0);
}

/** Список id секций в порядке следования. */
export function irSectionIds(ir) {
  return ir.sections.map((section) => section.id);
}
