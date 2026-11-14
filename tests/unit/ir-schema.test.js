// Схема Composition IR: строгая валидация, безопасная проверка, копирование.
import { describe, it, expect } from 'vitest';
import {
  CompositionIRSchema,
  validateIR,
  safeValidateIR,
  cloneIR,
  irBars,
  irSectionIds,
  IR_ROLES,
  IR_MODES,
  IR_GROOVE_TEMPLATES,
  IR_PLANS,
  IR_SECTION_KINDS,
} from '../../src/ir/schema.js';

/** Минимальный валидный IR — база для проверок мутаций. */
function validIr() {
  return {
    v: 1,
    seed: 42,
    meta: {
      title: 'Проверка схемы',
      bpm: 90,
      meter: '4/4',
      key: { tonic: 'D', mode: 'minor' },
      mood: { valence: -0.4, arousal: 0.1, label: 'dark', modifiers: [] },
      genre: 'lofi',
      style: 'lo-fi',
    },
    palette: { kick: { ref: 'bd' } },
    motifs: { hook: { degrees: [0, 2, 4], steps: [0, 4, 8] } },
    sections: [
      {
        id: 'sec-intro',
        kind: 'intro',
        bars: 4,
        energy: 0.3,
        tension: 0.2,
        harmony: [{ rn: 'i', bars: 2 }, { rn: 'V', bars: 2 }],
        layers: {
          kick: { plan: 'drums', density: 0.8, register: [36, 48], weight: 1 },
          chords: { plan: 'chords', density: 0.5, register: [55, 76], weight: 0.7 },
        },
      },
      {
        id: 'sec-peak',
        kind: 'peak',
        bars: 8,
        energy: 0.9,
        tension: 0.9,
        harmony: [{ rn: 'VI', bars: 8 }],
        layers: {
          kick: { plan: 'drums', density: 1, register: [36, 48], weight: 1 },
          snare: { plan: 'drums', density: 0.9, register: [48, 60], weight: 0.8 },
        },
      },
    ],
    groove: { template: 'swing', amount: 1, swing: 0.56, offsetMs: 0 },
    mix: { sidechain: [{ src: 'kick', dst: 'bass', depth: 0.5 }], pan: {}, orbit: {} },
  };
}

describe('Схема Composition IR', () => {
  it('корректный IR принимается без изменения полей', () => {
    const ir = validIr();
    const parsed = validateIR(ir);
    expect(parsed.meta.bpm).toBe(90);
    expect(parsed.meta.key).toEqual({ tonic: 'D', mode: 'minor' });
    expect(parsed.sections).toHaveLength(2);
  });

  it('IR без meta отклоняется', () => {
    const ir = validIr();
    delete ir.meta;
    expect(() => validateIR(ir)).toThrow();
  });

  it.each([39, 201, 0, -10])('темп %i вне диапазона 40..200 отклоняется', (bpm) => {
    const ir = validIr();
    ir.meta.bpm = bpm;
    expect(() => validateIR(ir)).toThrow();
  });

  it('неизвестная роль в layers отклоняется', () => {
    const ir = validIr();
    ir.sections[0].layers.guitar = { plan: 'melody', density: 0.5, register: [40, 80], weight: 1 };
    expect(() => validateIR(ir)).toThrow();
  });

  it('неизвестный лад отклоняется', () => {
    const ir = validIr();
    ir.meta.key.mode = 'blues';
    expect(() => validateIR(ir)).toThrow();
  });

  it('пустой список секций отклоняется', () => {
    const ir = validIr();
    ir.sections = [];
    expect(() => validateIR(ir)).toThrow();
  });

  it.each([0, 33, -2])('число тактов %i вне 1..32 отклоняется', (bars) => {
    const ir = validIr();
    ir.sections[0].bars = bars;
    expect(() => validateIR(ir)).toThrow();
  });

  it('кривая римская цифра отклоняется', () => {
    const ir = validIr();
    ir.sections[0].harmony[0].rn = 'H';
    expect(() => validateIR(ir)).toThrow();
  });

  it('перечисления схемы совпадают с контрактом слоя', () => {
    expect(IR_ROLES).toContain('kick');
    expect(IR_ROLES).toContain('texture');
    expect(IR_MODES).toContain('phrygian');
    expect(IR_GROOVE_TEMPLATES).toContain('drunken');
    expect(IR_PLANS).toContain('bassline');
    expect(IR_SECTION_KINDS).toContain('bloom');
    expect(IR_SECTION_KINDS).toContain('drop');
  });

  it('схема доступна напрямую и принимает тот же IR', () => {
    const ir = validIr();
    expect(CompositionIRSchema.safeParse(ir).success).toBe(true);
  });
});

describe('Безопасная проверка IR', () => {
  it('корректный IR даёт {ok:true, data}', () => {
    const result = safeValidateIR(validIr());
    expect(result.ok).toBe(true);
    expect(result.data.meta.bpm).toBe(90);
    expect(result.error).toBeUndefined();
  });

  it('битый IR даёт {ok:false, error} и не бросает исключение', () => {
    const ir = validIr();
    ir.meta.bpm = 999;
    const result = safeValidateIR(ir);
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it.each([[undefined], [null], ['строка'], [42], [[]], [{}]])(
    'значение %s проверяется без исключения',
    (value) => {
      let result;
      expect(() => { result = safeValidateIR(value); }).not.toThrow();
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    },
  );
});

describe('Копирование и сводки по IR', () => {
  it('cloneIR делает глубокую копию: правка копии не трогает оригинал', () => {
    const ir = validIr();
    const copy = cloneIR(ir);

    copy.meta.bpm = 150;
    copy.meta.key.tonic = 'C';
    copy.sections[0].bars = 99;
    copy.sections[0].layers.kick.density = 0.01;
    copy.sections[0].harmony[0].rn = 'VII';
    copy.motifs.hook.degrees[0] = 6;
    copy.groove.swing = 0.68;

    expect(ir.meta.bpm).toBe(90);
    expect(ir.meta.key.tonic).toBe('D');
    expect(ir.sections[0].bars).toBe(4);
    expect(ir.sections[0].layers.kick.density).toBe(0.8);
    expect(ir.sections[0].harmony[0].rn).toBe('i');
    expect(ir.motifs.hook.degrees[0]).toBe(0);
    expect(ir.groove.swing).toBe(0.56);
  });

  it('cloneIR даёт равную по содержимому структуру', () => {
    const ir = validIr();
    expect(cloneIR(ir)).toEqual(ir);
  });

  it('irBars суммирует такты всех секций', () => {
    expect(irBars(validIr())).toBe(12);
    const ir = validIr();
    ir.sections[0].bars = 7;
    expect(irBars(ir)).toBe(15);
  });

  it('irSectionIds сохраняет порядок секций', () => {
    expect(irSectionIds(validIr())).toEqual(['sec-intro', 'sec-peak']);
  });
});
