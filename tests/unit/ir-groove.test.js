// Грув: сетка 1/16, свинг, микротайминг и детерминированный отсев.
import { describe, it, expect } from 'vitest';
import {
  GROOVE_TEMPLATES,
  grooveSteps,
  swingOffset,
  stepMs,
  barMs,
} from '../../src/ir/groove.js';

const TEMPLATES = Object.keys(GROOVE_TEMPLATES);
const ROLES = ['kick', 'snare', 'hats'];

describe('Длительности сетки', () => {
  it('шестнадцатая при 120 BPM равна 125 мс', () => {
    expect(stepMs(120)).toBe(125);
  });

  it('такт при 120 BPM равен 2000 мс', () => {
    expect(barMs(120)).toBe(2000);
  });

  it('длительности сетки обратно пропорциональны темпу', () => {
    expect(stepMs(240)).toBe(62.5);
    expect(barMs(60)).toBe(4000);
  });
});

describe('Свинг', () => {
  it('при доле 0.5 сдвига нет ни на одном шаге', () => {
    for (let step = 0; step < 16; step += 1) {
      expect(swingOffset(step, 0.5, 1)).toBe(0);
      expect(swingOffset(step, 0.5, 2)).toBe(0);
    }
  });

  it('при свинге 16-х (unit = 1) сдвигаются только нечётные шаги', () => {
    for (let step = 0; step < 16; step += 1) {
      const offset = swingOffset(step, 0.56, 1);
      if (step % 2 === 0) expect(offset, String(step)).toBe(0);
      else expect(offset, String(step)).toBeGreaterThan(0);
    }
  });

  it('при свинге 8-х (unit = 2) сдвигаются шаги 2, 6, 10, 14', () => {
    const shifted = [];
    for (let step = 0; step < 16; step += 1) {
      const offset = swingOffset(step, 0.56, 2);
      if (offset !== 0) shifted.push(step);
      // Нечётные шаги не свингуются никогда, чётные — по одному в паре.
      if (step % 2 === 1) expect(offset, String(step)).toBe(0);
      else expect(offset === 0, String(step)).toBe(step % 4 !== 2);
    }
    expect(shifted).toEqual([2, 6, 10, 14]);
  });
});

describe('Сетка роли', () => {
  it.each(TEMPLATES)('шаблон %s: шаги только в сетке 0..15 и без повторов', (template) => {
    for (const role of ROLES) {
      const steps = grooveSteps({
        template, role, bpm: 120, amount: 1, density: 1, seed: 3, address: 'sec:hats',
      });
      expect(steps.length, `${template}/${role}`).toBeGreaterThan(0);
      for (const step of steps) {
        expect(Number.isInteger(step.step)).toBe(true);
        expect(step.step).toBeGreaterThanOrEqual(0);
        expect(step.step).toBeLessThanOrEqual(15);
        expect(Number.isFinite(step.offsetMs)).toBe(true);
        expect(Number.isFinite(step.velocity)).toBe(true);
        expect(step.velocity).toBeGreaterThan(0);
        expect(step.velocity).toBeLessThanOrEqual(1);
      }
      const unique = new Set(steps.map((step) => step.step));
      expect(unique.size, `${template}/${role}`).toBe(steps.length);
    }
  });

  it.each(TEMPLATES)('шаблон %s: сдвиги укладываются в бюджет ±20 мс на любом темпе', (template) => {
    // Бюджет микротайминга действует на ЛЮБОМ темпе: свинг 8-х на 80 BPM
    // сам по себе даёт 45 мс, поэтому он упирается в бюджет — так и должно
    // быть (иначе «разъехавшиеся» удары ломают трек).
    for (const bpm of [70, 80, 120, 174, 200]) {
      for (const role of ROLES) {
        const steps = grooveSteps({
          template, role, bpm, amount: 1, density: 1, seed: 3, address: 'sec:hats',
        });
        for (const step of steps) {
          expect(Math.abs(step.offsetMs), `${template}/${role} ${bpm} BPM шаг ${step.step}`).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  it.each(TEMPLATES)('шаблон %s: якорный кик на шаге 0 остаётся при полной плотности', (template) => {
    const steps = grooveSteps({
      template, role: 'kick', bpm: 120, amount: 1, density: 1, seed: 3, address: 'sec:kick',
    });
    expect(steps.some((step) => step.step === 0)).toBe(true);
  });

  it.each(TEMPLATES)('шаблон %s: при нулевой плотности остаются только якоря (динамика ≥ 0.9)', (template) => {
    const steps = grooveSteps({
      template, role: 'hats', bpm: 120, amount: 1, density: 0, seed: 3, address: 'sec:hats',
    });
    for (const step of steps) expect(step.velocity).toBeGreaterThanOrEqual(0.9);
  });

  it.each(TEMPLATES)('шаблон %s: при нулевой плотности якоря кика и снейра сохраняются', (template) => {
    for (const role of ['kick', 'snare']) {
      const steps = grooveSteps({
        template, role, bpm: 120, amount: 1, density: 0, seed: 3, address: `sec:${role}`,
      });
      const anchors = GROOVE_TEMPLATES[template].steps[role].filter((entry) => entry[1] >= 0.9);
      expect(steps).toHaveLength(anchors.length);
      expect(steps.map((step) => step.step)).toEqual(anchors.map((entry) => entry[0]));
    }
  });
});

describe('Детерминизм грува', () => {
  it('одинаковые входы дают одинаковую сетку', () => {
    const options = {
      template: 'funk', role: 'hats', bpm: 120, amount: 1, density: 0.6, seed: 11, address: 'a:hats',
    };
    expect(grooveSteps(options)).toEqual(grooveSteps(options));
  });

  it('разный адрес при низкой плотности меняет отсев, но остаётся детерминированным', () => {
    const base = { template: 'straight', role: 'hats', bpm: 120, amount: 1, density: 0.5, seed: 7 };
    const first = grooveSteps({ ...base, address: 'sec-a:hats' });
    const second = grooveSteps({ ...base, address: 'sec-b:hats' });
    expect(first).toEqual(grooveSteps({ ...base, address: 'sec-a:hats' }));
    expect(second).toEqual(grooveSteps({ ...base, address: 'sec-b:hats' }));
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
  });

  it('плотность 1 оставляет сетку шаблона целиком', () => {
    const steps = grooveSteps({
      template: 'straight', role: 'hats', bpm: 120, amount: 1, density: 1, seed: 7, address: 'x',
    });
    expect(steps.map((step) => step.step)).toEqual(GROOVE_TEMPLATES.straight.steps.hats.map((entry) => entry[0]));
  });
});
