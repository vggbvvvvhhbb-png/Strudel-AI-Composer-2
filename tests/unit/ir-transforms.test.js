// Трансформации IR: чистота, локальность и монотонность правок.
import { describe, it, expect } from 'vitest';
import {
  darker,
  brighter,
  energize,
  calm,
  thin,
  thicken,
  shiftRegister,
  setMode,
  scaleTempo,
  swapInstrument,
  addVariation,
  extendSection,
  swing,
  applyTransform,
  BRIGHTNESS_SCALE,
} from '../../src/ir/transforms.js';
import { cloneIR } from '../../src/ir/schema.js';

/** База для проверок трансформаций: роли, мелодический слой и явные фильтры. */
function baseIr() {
  return {
    v: 1,
    seed: 17,
    meta: {
      title: 'База',
      bpm: 100,
      meter: '4/4',
      key: { tonic: 'C', mode: 'major' },
      mood: { valence: 0.4, arousal: 0.2, label: 'hope', modifiers: [] },
      genre: 'lofi',
      style: 'lo-fi',
    },
    palette: { lead: { ref: 'triangle' } },
    motifs: { hook: { degrees: [0, 2, 4, 6], steps: [0, 4, 8, 12] } },
    sections: [
      {
        id: 'sec-verse',
        kind: 'verse',
        bars: 8,
        energy: 0.5,
        tension: 0.4,
        harmony: [{ rn: 'I', bars: 4 }, { rn: 'V', bars: 4 }],
        layers: {
          kick: { plan: 'drums', density: 0.6, register: [36, 48], lpf: 16000, weight: 1 },
          hats: { plan: 'drums', density: 0.6, register: [72, 84], lpf: 12000, weight: 0.6 },
          bass: { plan: 'bassline', density: 0.6, register: [36, 52], lpf: 800, weight: 0.85 },
          chords: { plan: 'chords', density: 0.6, register: [55, 76], lpf: 2400, weight: 0.8 },
          lead: { plan: 'melody', density: 0.6, register: [60, 84], lpf: 3000, weight: 0.6 },
          arp: { plan: 'arp', density: 0.6, register: [60, 84], lpf: 3000, weight: 0.5 },
        },
      },
      {
        id: 'sec-peak',
        kind: 'peak',
        bars: 8,
        energy: 0.9,
        tension: 0.8,
        harmony: [{ rn: 'IV', bars: 8 }],
        layers: {
          kick: { plan: 'drums', density: 0.9, register: [36, 48], lpf: 16000, weight: 1 },
          hats: { plan: 'drums', density: 0.9, register: [72, 84], lpf: 12000, weight: 1 },
          bass: { plan: 'bassline', density: 0.9, register: [36, 52], lpf: 800, weight: 1 },
          chords: { plan: 'chords', density: 0.9, register: [55, 76], lpf: 2400, weight: 1 },
          lead: { plan: 'melody', density: 0.9, register: [60, 84], lpf: 3000, weight: 1 },
          arp: { plan: 'arp', density: 0.9, register: [60, 84], lpf: 3000, weight: 0.8 },
        },
      },
    ],
    groove: { template: 'swing', amount: 1, swing: 0.5, offsetMs: 0 },
    mix: { sidechain: [], pan: {}, orbit: {} },
  };
}

/** Средняя частота среза мелодических слоёв. */
function meanMelodicLpf(ir) {
  const values = [];
  for (const section of ir.sections) {
    for (const [role, layer] of Object.entries(section.layers)) {
      if (layer.plan !== 'melody' && layer.plan !== 'arp') continue;
      values.push(layer.lpf);
    }
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const CASES = [
  ['darker', (ir) => darker(ir, 0.6)],
  ['brighter', (ir) => brighter(ir, 0.6)],
  ['energize', (ir) => energize(ir, 0.6)],
  ['calm', (ir) => calm(ir, 0.6)],
  ['thin', (ir) => thin(ir, 'hats', 0.8)],
  ['thicken', (ir) => thicken(ir, 'hats', 0.8)],
  ['shiftRegister', (ir) => shiftRegister(ir, 'lead', 1)],
  ['setMode', (ir) => setMode(ir, 'dorian')],
  ['scaleTempo', (ir) => scaleTempo(ir, 1.1)],
  ['swapInstrument', (ir) => swapInstrument(ir, 'lead', 'sine')],
  ['addVariation', (ir) => addVariation(ir, 'sec-verse')],
  ['extendSection', (ir) => extendSection(ir, 'sec-verse', 4)],
  ['swing', (ir) => swing(ir, 1)],
];

describe('Чистота трансформаций', () => {
  it.each(CASES)('%s возвращает новый объект и не мутирует исходный IR', (name, apply) => {
    const ir = baseIr();
    const snapshot = cloneIR(ir);
    const result = apply(ir);
    expect(result).not.toBe(ir);
    expect(ir).toEqual(snapshot);
  });

  it('исходный IR остаётся валидным после всех правок подряд', () => {
    const ir = baseIr();
    const snapshot = cloneIR(ir);
    darker(ir, 0.5);
    brighter(ir, 0.5);
    energize(ir, 0.5);
    calm(ir, 0.5);
    thin(ir, 'hats', 0.5);
    thicken(ir, 'hats', 0.5);
    shiftRegister(ir, 'lead', 1);
    setMode(ir, 'dorian');
    scaleTempo(ir, 1.2);
    swing(ir, 0.5);
    expect(ir).toEqual(snapshot);
  });
});

describe('Монотонность «темнее» и «светлее»', () => {
  it('сильнее темнее — темнее по шкале яркости', () => {
    const ir = baseIr();
    const weak = darker(ir, 0.1);
    const strong = darker(ir, 0.9);
    const indexWeak = BRIGHTNESS_SCALE.indexOf(weak.meta.key.mode);
    const indexStrong = BRIGHTNESS_SCALE.indexOf(strong.meta.key.mode);
    expect(indexStrong).toBeGreaterThan(indexWeak);
    expect(BRIGHTNESS_SCALE.indexOf(strong.meta.key.mode))
      .toBeGreaterThan(BRIGHTNESS_SCALE.indexOf(ir.meta.key.mode));
  });

  it('на дне шкалы лад остаётся самым тёмным', () => {
    const ir = baseIr();
    ir.meta.key.mode = 'locrian';
    const result = darker(ir, 0.9);
    expect(result.meta.key.mode).toBe('locrian');
  });

  it('темнее снижает средний срез мелодических слоёв, светлее — повышает', () => {
    const ir = baseIr();
    const before = meanMelodicLpf(ir);
    expect(meanMelodicLpf(darker(ir, 0.9))).toBeLessThan(before);
    expect(meanMelodicLpf(brighter(ir, 0.9))).toBeGreaterThan(before);
  });

  it('светлее поднимает лад по шкале яркости', () => {
    const ir = baseIr();
    const result = brighter(ir, 0.9);
    expect(BRIGHTNESS_SCALE.indexOf(result.meta.key.mode))
      .toBeLessThan(BRIGHTNESS_SCALE.indexOf(ir.meta.key.mode));
  });
});

describe('Энергия и темп', () => {
  it('energize поднимает темп и плотность', () => {
    const ir = baseIr();
    const result = energize(ir, 0.9);
    expect(result.meta.bpm).toBeGreaterThan(ir.meta.bpm);
    expect(result.sections[0].layers.kick.density).toBeGreaterThan(ir.sections[0].layers.kick.density);
  });

  it('calm опускает темп и плотность', () => {
    const ir = baseIr();
    const result = calm(ir, 0.9);
    expect(result.meta.bpm).toBeLessThan(ir.meta.bpm);
    expect(result.sections[0].layers.kick.density).toBeLessThan(ir.sections[0].layers.kick.density);
  });

  it('scaleTempo умножает темп и удерживает его в 40..200', () => {
    const ir = baseIr();
    expect(scaleTempo(ir, 1.25).meta.bpm).toBe(125);
    expect(scaleTempo(ir, 1.25).meta.bpm).toBe(Math.round(ir.meta.bpm * 1.25));
    expect(scaleTempo(ir, 5).meta.bpm).toBe(200);
    expect(scaleTempo(ir, 0.1).meta.bpm).toBe(40);
  });

  it('swing повышает долю свинга', () => {
    const ir = baseIr();
    const result = swing(ir, 1);
    expect(result.groove.swing).toBeGreaterThan(ir.groove.swing);
    expect(result.groove.swing).toBeLessThanOrEqual(0.68);
  });
});

describe('Смена лада и инструмента', () => {
  it('setMode ставит лад и пересчитывает настроение', () => {
    const ir = baseIr();
    const result = setMode(ir, 'phrygian');
    expect(result.meta.key.mode).toBe('phrygian');
    expect(result.meta.mood.valence).toBeLessThan(ir.meta.mood.valence);
  });

  it('setMode бросает ошибку на неизвестном ладу', () => {
    expect(() => setMode(baseIr(), 'blues')).toThrow(/Неизвестный лад/);
  });

  it('swapInstrument меняет звук роли на известный', () => {
    const ir = baseIr();
    const result = swapInstrument(ir, 'lead', 'square');
    expect(result.palette.lead.ref).toBe('square');
  });

  it('swapInstrument бросает ошибку на неизвестном звуке', () => {
    expect(() => swapInstrument(baseIr(), 'lead', 'нет-такого-звука')).toThrow(/Неизвестный звук/);
  });
});

describe('Локальность ролевых правок', () => {
  function otherRoles(ir, role) {
    const out = [];
    for (const section of ir.sections) {
      for (const [name, layer] of Object.entries(section.layers)) {
        if (name === role) continue;
        out.push([section.id, name, layer]);
      }
    }
    return out;
  }

  it('thin меняет только роль hats', () => {
    const ir = baseIr();
    const result = thin(ir, 'hats', 0.8);
    expect(result.sections[0].layers.hats.density)
      .toBeLessThan(ir.sections[0].layers.hats.density);
    expect(otherRoles(result, 'hats')).toEqual(otherRoles(ir, 'hats'));
  });

  it('thicken меняет только роль hats', () => {
    const ir = baseIr();
    const result = thicken(ir, 'hats', 0.8);
    expect(result.sections[0].layers.hats.density)
      .toBeGreaterThan(ir.sections[0].layers.hats.density);
    expect(otherRoles(result, 'hats')).toEqual(otherRoles(ir, 'hats'));
  });

  it('shiftRegister меняет только регистр выбранной роли', () => {
    const ir = baseIr();
    const result = shiftRegister(ir, 'lead', 1);
    expect(result.sections[0].layers.lead.register).toEqual([72, 96]);
    expect(otherRoles(result, 'lead')).toEqual(otherRoles(ir, 'lead'));
  });
});

describe('Реестр трансформаций', () => {
  it('applyTransform вызывает трансформацию по имени', () => {
    const ir = baseIr();
    const result = applyTransform(ir, 'darker', 0.5);
    expect(result.meta.key.mode).toBe(darker(ir, 0.5).meta.key.mode);
  });

  it('applyTransform бросает ошибку на неизвестном имени', () => {
    expect(() => applyTransform(baseIr(), 'несуществует')).toThrow(/Неизвестная трансформация/);
  });
});

describe('Вариация и длина секций', () => {
  it('addVariation держит степени в ладу и не меняет число мотивов', () => {
    const ir = baseIr();
    const result = addVariation(ir, 'sec-verse');
    expect(Object.keys(result.motifs)).toHaveLength(Object.keys(ir.motifs).length);
    for (const motif of Object.values(result.motifs)) {
      expect(motif.degrees).toHaveLength(ir.motifs.hook.degrees.length);
      for (const degree of motif.degrees) {
        if (degree === null) continue;
        expect(degree).toBeGreaterThanOrEqual(0);
        expect(degree).toBeLessThanOrEqual(6);
      }
    }
  });

  it('addVariation бросает ошибку на неизвестной секции', () => {
    expect(() => addVariation(baseIr(), 'нет-секции')).toThrow(/Секция не найдена/);
  });

  it('extendSection увеличивает только указанную секцию', () => {
    const ir = baseIr();
    const result = extendSection(ir, 'sec-verse', 4);
    expect(result.sections[0].bars).toBe(ir.sections[0].bars + 4);
    expect(result.sections[1].bars).toBe(ir.sections[1].bars);
  });

  it('extendSection бросает ошибку на неизвестной секции', () => {
    expect(() => extendSection(baseIr(), 'нет-секции', 4)).toThrow(/Секция не найдена/);
  });
});
