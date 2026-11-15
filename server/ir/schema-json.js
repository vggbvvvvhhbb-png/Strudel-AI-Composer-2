// JSON-схема Composition IR для структурированного вывода LLM.
//
// Зачем отдельная схема, если есть Zod:
//   • Zod-схема IR написана на zod v3 (см. src/ir/schema.js), а в JSON Schema
//     для провайдеров нужен другой формат; конвертировать v3-схему в JSON
//     Schema без новой зависимости нечем;
//   • контракт с моделью — это подмножество IR, описанное явно: так видно,
//     что именно модель обязана вернуть, и это видно в одном месте;
//   • правда всё равно проверяет Zod: схема — это подсказка провайдеру и
//     документация, Zod — приёмка. Модель, ответившая не по схеме, чинится
//     ремонтным ретраем (см. server/ir/planner.js), а не падением.
//
// Версионируется отдельно от IR: изменение схемы ломает кэш планировщика,
// поэтому версия входит в ключ кэша.

import { ROLES as STUDIO_ROLES } from '../../src/schemas/parts.js';

/** Версия контракта. Меняется при правке схемы. */
export const IR_SCHEMA_VERSION = 'ir-json-1.0.0';

/** Роли студии — единый источник `src/schemas/parts.js` (D-100). */
const ROLES = STUDIO_ROLES;

const MODES = [
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
];

const GROOVE_TEMPLATES = ['straight', 'swing', 'laidback', 'funk', 'halftime', 'drunken'];

const SECTION_KINDS = [
  'intro', 'verse', 'build', 'peak', 'break', 'outro', 'chorus', 'drop', 'air', 'grow', 'bloom', 'fade',
];

/** Слой партии внутри секции. */
const layer = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'density', 'register', 'weight'],
  properties: {
    plan: { type: 'string', enum: ['drums', 'bassline', 'chords', 'melody', 'arp', 'pad', 'fx', 'texture'] },
    density: { type: 'number', minimum: 0, maximum: 1 },
    register: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'integer', minimum: 24, maximum: 96 },
    },
    gainDb: { type: 'number', minimum: -24, maximum: 6 },
    lpf: { type: 'integer', minimum: 120, maximum: 20000 },
    weight: { type: 'number', minimum: 0, maximum: 1 },
    motifId: { type: 'string', maxLength: 40 },
  },
};

/** Гармонический шаг: римская цифра в ладу тональности. */
const harmonyStep = {
  type: 'object',
  additionalProperties: false,
  required: ['rn', 'bars'],
  properties: {
    rn: { type: 'string', pattern: '^[b#]?[ivIV]+(maj7|min7|7)?$' },
    quality: { type: 'string', enum: ['major', 'minor', 'dim', 'aug'] },
    color: { type: 'string', enum: ['sus', 'add9', '7', 'borrowed', 'picardy', 'pedal'] },
    bars: { type: 'integer', minimum: 1, maximum: 16 },
  },
};

/** Секция формы. */
const section = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'bars', 'energy', 'tension', 'harmony', 'layers'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 40 },
    kind: { type: 'string', enum: SECTION_KINDS },
    bars: { type: 'integer', minimum: 1, maximum: 32 },
    energy: { type: 'number', minimum: 0, maximum: 1 },
    tension: { type: 'number', minimum: 0, maximum: 1 },
    harmony: { type: 'array', minItems: 1, maxItems: 16, items: harmonyStep },
    layers: { type: 'object', additionalProperties: layer },
    enter: { type: 'string', enum: ['riser', 'filter-open', 'fill', 'silence', 'none'] },
  },
};

/** Мотив: степени лада и шаги 16-й сетки. */
const motif = {
  type: 'object',
  additionalProperties: false,
  required: ['degrees', 'steps'],
  properties: {
    degrees: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: { type: ['integer', 'null'], minimum: -14, maximum: 14 },
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: { type: 'integer', minimum: 0, maximum: 15 },
    },
    durations: {
      type: 'array',
      maxItems: 32,
      items: { type: 'number', minimum: 0.25, maximum: 8 },
    },
  },
};

/**
 * Схема IR для structured output.
 * Словари (palette, motifs, layers, pan, orbit) объявлены как объекты с
 * additionalProperties-схемой: набор ключей заранее не известен, а strict-режим
 * OpenAI такие словари не поддерживает. Приёмку всё равно делает Zod.
 */
export const IR_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['v', 'seed', 'meta', 'sections', 'groove'],
  properties: {
    v: { type: 'integer', enum: [1] },
    seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'bpm', 'meter', 'key', 'mood'],
      properties: {
        title: { type: 'string', maxLength: 120 },
        bpm: { type: 'number', minimum: 40, maximum: 200 },
        meter: { type: 'string', enum: ['4/4', '3/4', '6/8'] },
        key: {
          type: 'object',
          additionalProperties: false,
          required: ['tonic', 'mode'],
          properties: {
            tonic: { type: 'string', pattern: '^[A-G][#b]?$' },
            mode: { type: 'string', enum: MODES },
          },
        },
        mood: {
          type: 'object',
          additionalProperties: false,
          required: ['valence', 'arousal', 'modifiers'],
          properties: {
            valence: { type: 'number', minimum: -1, maximum: 1 },
            arousal: { type: 'number', minimum: -1, maximum: 1 },
            label: { type: 'string', maxLength: 40 },
            modifiers: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 30 } },
          },
        },
        genre: { type: 'string', maxLength: 40 },
        style: { type: 'string', maxLength: 40 },
      },
    },
    palette: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['ref'],
        properties: {
          ref: { type: 'string', minLength: 1, maxLength: 80 },
          gainDb: { type: 'number', minimum: -24, maximum: 6 },
        },
      },
    },
    motifs: { type: 'object', additionalProperties: motif },
    sections: { type: 'array', minItems: 1, maxItems: 12, items: section },
    groove: {
      type: 'object',
      additionalProperties: false,
      required: ['template', 'amount'],
      properties: {
        template: { type: 'string', enum: GROOVE_TEMPLATES },
        amount: { type: 'number', minimum: 0, maximum: 1 },
        swing: { type: 'number', minimum: 0.5, maximum: 0.68 },
        bassRhythm: { type: 'string', maxLength: 32 },
        offsetMs: { type: 'number', minimum: -20, maximum: 20 },
      },
    },
    mix: {
      type: 'object',
      additionalProperties: false,
      required: ['sidechain', 'pan', 'orbit'],
      properties: {
        sidechain: {
          type: 'array',
          maxItems: 16,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['src', 'dst', 'depth'],
            properties: {
              src: { type: 'string', enum: ROLES },
              dst: { type: 'string', enum: ROLES },
              depth: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
        pan: { type: 'object', additionalProperties: { type: 'number', minimum: -1, maximum: 1 } },
        orbit: { type: 'object', additionalProperties: { type: 'integer', minimum: 1, maximum: 8 } },
      },
    },
  },
};

/** Компактное описание схемы для промта (не весь JSON — экономия токенов). */
export const IR_SCHEMA_BRIEF = [
  'v: 1, seed: целое число.',
  'meta: { title, bpm 40..200, meter "4/4"|"3/4"|"6/8", key {tonic "A".."G" с #/b, mode}, mood {valence -1..1, arousal -1..1, modifiers: []}, genre?, style? }.',
  'sections: массив 1..12 объектов { id, kind, bars 1..32, energy 0..1, tension 0..1, harmony: [{rn, bars, quality?, color?}], layers: {роль: {plan, density 0..1, register [MIDI,MIDI], weight 0..1, gainDb?, lpf?, motifId?}}, enter? }.',
  'Роли слоёв: kick, snare, hats, perc, sub, bass, pad, chords, lead, arp, fx, texture.',
  'plan — ОДНО слово из списка (тип партии): drums | bassline | chords | melody | arp | pad | fx | texture. Это НЕ описание партии: описание сюда не пишется.',
  'rn — римская цифра лада, ОДНО слово: I, V, vi, IV, i, iv, bII, V7, Imaj7, ii (строчные — минорные).',
  'kind секции — ОДНО слово: intro, verse, build, peak, break, outro, chorus, drop, air, grow, bloom, fade.',
  'motifs: { id: { degrees: [целые или null], steps: [0..15], durations? } } — степени лада от тоники, null = пауза.',
  'groove: { template: straight|swing|laidback|funk|halftime|drunken, amount 0..1, swing?, bassRhythm?, offsetMs? }.',
  'mix: { sidechain: [{src, dst, depth}], pan: {роль: -1..1}, orbit: {роль: 1..8} }.',
  'palette: {роль: {ref: "имя паспорта"}} — только из палитры; палитра пуста — ставь {}.',
].join('\n');
