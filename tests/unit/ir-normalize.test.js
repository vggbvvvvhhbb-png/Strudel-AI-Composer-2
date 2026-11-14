// Детерминированная починка ответа модели.
//
// Тесты построены на РЕАЛЬНЫХ ответах модели (живой прогон 14.11.2026):
// модель пишет в enum-поле описание вместо значения, выдумывает роли,
// забывает регистр. Это и есть класс ошибок, который починка обязана
// закрывать, не тратя вызовы модели.

import { describe, it, expect } from 'vitest';

import { normalizeIR, normalizeRoman } from '../../server/ir/normalize.js';
import { safeValidateIR } from '../../src/ir/schema.js';
import { planForRole } from '../../src/ir/arrangement.js';

/** Ответ модели, как пришёл с живого сервера (сокращённый). */
const MODEL_ANSWER = {
  v: 1,
  seed: 42,
  meta: {
    title: 'Дождь',
    bpm: 78,
    meter: '4/4',
    key: { tonic: 'D', mode: 'minor' },
    mood: { valence: -0.6, arousal: -0.2, modifiers: ['dust'] },
  },
  palette: {},
  motifs: {},
  sections: [
    {
      id: 'intro',
      kind: 'intro',
      bars: 8,
      energy: 0.3,
      tension: 0.4,
      harmony: [{ rn: 'i', bars: 8 }],
      layers: {
        texture: {
          plan: 'тихий виниловый шум и тёмная атмосфера',
          density: 0.4,
          register: [50, 70],
          weight: 0.8,
        },
        pad: {
          plan: 'разреженный тёмный педальный слой',
          density: 0.5,
          register: [48, 72],
          weight: 0.7,
        },
        guitar: {
          plan: 'lead',
          density: 0.5,
          register: [60, 84],
          weight: 1,
        },
      },
    },
  ],
  groove: { template: 'drunken', amount: 0.5 },
  mix: { sidechain: [], pan: {}, orbit: {} },
};

describe('починка ответа модели', () => {
  it('заменяет описание в enum-поле планом по роли', () => {
    const { ir, notes } = normalizeIR(MODEL_ANSWER);
    expect(ir.sections[0].layers.texture.plan).toBe(planForRole('texture'));
    expect(ir.sections[0].layers.pad.plan).toBe(planForRole('pad'));
    expect(notes.join(' ')).toMatch(/plan/);
  });

  it('выбрасывает выдуманную роль, но не роняет план', () => {
    const { ir, notes } = normalizeIR(MODEL_ANSWER);
    expect(ir.sections[0].layers.guitar).toBeUndefined();
    expect(notes.join(' ')).toMatch(/guitar/);
    expect(Object.keys(ir.sections[0].layers)).toEqual(['texture', 'pad']);
  });

  it('после починки план принимается Zod без ремонтного ретрая', () => {
    const { ir } = normalizeIR(MODEL_ANSWER);
    const validation = safeValidateIR(ir);
    expect(validation.ok).toBe(true);
  });

  it('дописывает недостающий регистр по роли', () => {
    const { ir } = normalizeIR({
      ...MODEL_ANSWER,
      sections: [{
        ...MODEL_ANSWER.sections[0],
        layers: { lead: { plan: 'melody', density: 0.5, weight: 1 } },
      }],
    });
    expect(ir.sections[0].layers.lead.register).toHaveLength(2);
    expect(ir.sections[0].layers.lead.register[0]).toBeGreaterThanOrEqual(24);
  });

  it('обрезает числа вне диапазона', () => {
    const { ir } = normalizeIR({
      ...MODEL_ANSWER,
      meta: { ...MODEL_ANSWER.meta, bpm: 240 },
      sections: [{
        ...MODEL_ANSWER.sections[0],
        bars: 400,
        energy: 5,
        layers: {
          bass: { plan: 'bassline', density: 3, weight: -1, register: [10, 200], gainDb: 40 },
        },
      }],
    });
    expect(ir.meta.bpm).toBe(200);
    expect(ir.sections[0].bars).toBe(32);
    expect(ir.sections[0].energy).toBe(1);
    expect(ir.sections[0].layers.bass.density).toBe(1);
    expect(ir.sections[0].layers.bass.weight).toBe(0);
    expect(ir.sections[0].layers.bass.register).toEqual([24, 96]);
    expect(ir.sections[0].layers.bass.gainDb).toBe(6);
  });

  it('чинит римскую цифру и не оставляет секцию без гармонии', () => {
    const { ir } = normalizeIR({
      ...MODEL_ANSWER,
      sections: [{
        ...MODEL_ANSWER.sections[0],
        harmony: [{ rn: 'IV/3', bars: 4 }, { rn: 'что-то', bars: 4 }],
      }],
    });
    expect(ir.sections[0].harmony[0].rn).toBe('IV');
    expect(ir.sections[0].harmony).toHaveLength(1);
    const empty = normalizeIR({
      ...MODEL_ANSWER,
      sections: [{ ...MODEL_ANSWER.sections[0], harmony: [{ rn: '???', bars: 4 }] }],
    });
    expect(empty.ir.sections[0].harmony.length).toBeGreaterThan(0);
  });

  it('не выдумывает то, чего модель не сказала: пустой план остаётся пустым', () => {
    const { ir } = normalizeIR({ v: 1, seed: 1, meta: {}, sections: [], groove: {} });
    expect(ir.sections).toEqual([]);
    expect(safeValidateIR(ir).ok).toBe(false);
  });

  it('умеет разбирать римские цифры', () => {
    expect(normalizeRoman('bVII')).toBe('bVII');
    expect(normalizeRoman('Imaj7')).toBe('Imaj7');
    expect(normalizeRoman('IV/3')).toBe('IV');
    expect(normalizeRoman('что-то')).toBeNull();
  });
});
