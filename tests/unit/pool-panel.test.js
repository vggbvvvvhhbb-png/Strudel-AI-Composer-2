// Логика панели пула сэмплов: строка паспорта — только измеренное.
// DOM-карточки проверяются в браузере (гейт F), здесь — чистая функция.

import { describe, expect, it } from 'vitest';

import { passportLine } from '../../src/pool-panel.js';

describe('строка паспорта сэмпла', () => {
  it('полный паспорт: длительность, нота, центроид, темп, характер', () => {
    const line = passportLine({
      durationS: 1.234,
      tonal: { note: 'A2', f0Hz: 110 },
      spectral: { centroidHz: 2500.4 },
      tempo: { bpm: 120.2 },
      character: ['тёмный', 'ударный'],
    });
    expect(line).toContain('1.23 с');
    expect(line).toContain('нота A2');
    expect(line).toContain('центроид 2500 Гц');
    expect(line).toContain('120 BPM');
    expect(line).toContain('тёмный, ударный');
  });

  it('отсутствующий паспорт — честно «не снят», а не пустая строка', () => {
    expect(passportLine(null)).toBe('паспорт не снят');
    expect(passportLine(undefined)).toBe('паспорт не снят');
  });

  it('частичный паспорт показывает только измеренное', () => {
    const line = passportLine({ durationS: 0.5, tonal: { note: null }, spectral: {}, character: [] });
    expect(line).toBe('0.50 с');
  });

  it('пустой паспорт не притворяется измеренным', () => {
    expect(passportLine({})).toMatch(/признаков не измерено/);
  });
});