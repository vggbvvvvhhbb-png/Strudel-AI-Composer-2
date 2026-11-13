import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  TrackSpecSchema,
  validateTrackSpec,
  safeValidateTrackSpec
} from '../../src/schemas/track-spec.schema.js';

// Независимый mock по общему контракту: key='Cmin' (regex не допускает 'C:min'),
// две секции, неполный словарь ролей (kick и bass), без требования остальных ролей.
const validSpec = {
  meta: {
    style: 'techno',
    bpm: 128,
    key: 'Cmin',
    schemaVersion: '1.0'
  },
  structure: {
    sections: [
      { name: 'intro', cycles: 8, energy: 0.3, harmony: '<C:min!4>' },
      { name: 'drop', cycles: 32, energy: 1.0, harmony: '<C:min!2 G:maj!2>' }
    ]
  },
  parts: {
    roles: {
      kick: { activeIn: ['intro', 'drop'], pattern: 'bd', sound: 's' },
      bass: {
        activeIn: ['drop'],
        pattern: '[<a0 c1> <a0 g0>]',
        sound: 'sawtooth',
        effects: [{ name: 'room', params: [0.7] }]
      }
    }
  },
  reasoning: 'Test specification'
};

const clone = (spec) => JSON.parse(JSON.stringify(spec));

describe('TrackSpecSchema', () => {
  it('validateTrackSpec возвращает распарсенные данные для корректного mock (Cmin, 2 секции, kick+bass)', () => {
    expect(TrackSpecSchema.safeParse(validSpec).success).toBe(true);
    const parsed = validateTrackSpec(validSpec);
    expect(parsed).toEqual(validSpec);
    expect(parsed.meta.key).toBe('Cmin');
    expect(parsed.structure.sections).toHaveLength(2);
    expect(Object.keys(parsed.parts.roles).sort()).toEqual(['bass', 'kick']);
  });

  it('safeValidateTrackSpec возвращает распарсенные данные для того же mock', () => {
    const parsed = safeValidateTrackSpec(validSpec);
    expect(parsed).toEqual(validSpec);
    expect(parsed.parts.roles.kick.pattern).toBe('bd');
  });

  it('validateTrackSpec бросает ZodError на некорректных данных', () => {
    const spec = clone(validSpec);
    delete spec.meta.bpm;
    expect(() => validateTrackSpec(spec)).toThrow(ZodError);
  });

  it('safeValidateTrackSpec бросает Error с префиксом "Invalid track spec: " (не ZodError)', () => {
    const spec = clone(validSpec);
    delete spec.meta.bpm;
    let caught = null;
    try {
      safeValidateTrackSpec(spec);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ZodError);
    expect(caught.message.startsWith('Invalid track spec: ')).toBe(true);
    const issues = JSON.parse(caught.message.slice('Invalid track spec: '.length));
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['meta', 'bpm'] })
    ]));
  });

  it.each([
    ['bpm отсутствует', (s) => { delete s.meta.bpm; }],
    ['sections отсутствует', (s) => { delete s.structure.sections; }],
    ['roles отсутствует', (s) => { delete s.parts.roles; }]
  ])('обязательные поля: %s отклоняется', (_label, mutate) => {
    const spec = clone(validSpec);
    mutate(spec);
    expect(() => validateTrackSpec(spec)).toThrow(ZodError);
    expect(() => safeValidateTrackSpec(spec)).toThrow(/^Invalid track spec: /);
  });

  it.each([
    ['неверный style', (s) => { s.meta.style = 'invalid-style'; }],
    ['key="C:min" противоречит regex', (s) => { s.meta.key = 'C:min'; }],
    ['неизвестная роль', (s) => { s.parts.roles.kazoo = { activeIn: [], pattern: 'x', sound: 's' }; }]
  ])('недопустимые значения: %s отклоняются', (_label, mutate) => {
    const spec = clone(validSpec);
    mutate(spec);
    expect(() => validateTrackSpec(spec)).toThrow(ZodError);
    expect(() => safeValidateTrackSpec(spec)).toThrow(/^Invalid track spec: /);
  });

  it.each([
    ['bpm=60 (нижняя граница)', 60, true],
    ['bpm=180 (верхняя граница)', 180, true],
    ['bpm=59', 59, false],
    ['bpm=181', 181, false]
  ])('%s', (_label, bpm, shouldBeValid) => {
    const spec = clone(validSpec);
    spec.meta.bpm = bpm;
    if (shouldBeValid) {
      expect(validateTrackSpec(spec).meta.bpm).toBe(bpm);
    } else {
      expect(() => validateTrackSpec(spec)).toThrow(ZodError);
    }
  });

  it.each([
    ['cycles=1 (минимум)', 1, true],
    ['cycles=0', 0, false],
    ['cycles=1.5 (не целое)', 1.5, false]
  ])('%s', (_label, cycles, shouldBeValid) => {
    const spec = clone(validSpec);
    spec.structure.sections[0].cycles = cycles;
    if (shouldBeValid) {
      expect(validateTrackSpec(spec).structure.sections[0].cycles).toBe(cycles);
    } else {
      expect(() => validateTrackSpec(spec)).toThrow(ZodError);
    }
  });

  it.each([
    ['energy=0 (нижняя граница)', 0, true],
    ['energy=1 (верхняя граница)', 1, true],
    ['energy=-0.1', -0.1, false],
    ['energy=1.1', 1.1, false]
  ])('%s', (_label, energy, shouldBeValid) => {
    const spec = clone(validSpec);
    spec.structure.sections[0].energy = energy;
    if (shouldBeValid) {
      expect(validateTrackSpec(spec).structure.sections[0].energy).toBe(energy);
    } else {
      expect(() => validateTrackSpec(spec)).toThrow(ZodError);
    }
  });

  it.each([
    ['cutoff-кортеж из двух чисел допустим', (p) => { p.cutoff = [100, 2000]; }, true],
    ['gain-кортеж из двух чисел допустим', (p) => { p.gain = [0.2, 0.8]; }, true],
    ['кортеж из одного числа отклоняется', (p) => { p.cutoff = [100]; }, false],
    ['кортеж из трёх чисел отклоняется', (p) => { p.gain = [0.2, 0.5, 0.8]; }, false],
    ['нечисловое значение кортежа отклоняется', (p) => { p.cutoff = ['100', 2000]; }, false]
  ])('parameters: %s', (_label, mutate, shouldBeValid) => {
    const spec = clone(validSpec);
    spec.structure.sections[0].parameters = {};
    mutate(spec.structure.sections[0].parameters);
    if (shouldBeValid) {
      expect(() => validateTrackSpec(spec)).not.toThrow();
    } else {
      expect(() => validateTrackSpec(spec)).toThrow(ZodError);
    }
  });

  it('пустые sections и roles допустимы', () => {
    const spec = clone(validSpec);
    spec.structure.sections = [];
    spec.parts.roles = {};
    const parsed = validateTrackSpec(spec);
    expect(parsed.structure.sections).toEqual([]);
    expect(parsed.parts.roles).toEqual({});
    expect(safeValidateTrackSpec(spec)).toEqual(parsed);
  });

  it('необязательные поля (schemaVersion, parameters, effects, reasoning) можно опустить', () => {
    const spec = clone(validSpec);
    delete spec.meta.schemaVersion;
    delete spec.parts.roles.bass.effects;
    delete spec.reasoning;
    spec.structure.sections[0].parameters = undefined;
    const parsed = validateTrackSpec(spec);
    expect(parsed.meta.schemaVersion).toBeUndefined();
    expect(parsed.parts.roles.bass.effects).toBeUndefined();
    expect(parsed.reasoning).toBeUndefined();
    expect(safeValidateTrackSpec(spec)).toEqual(parsed);
  });
});
