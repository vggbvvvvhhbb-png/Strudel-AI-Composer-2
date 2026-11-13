// Спектральный анализ по 6 полосам: sub / low / lowMid / mid / highMid / high.
// Каждая полоса — каскад highpass + lowpass (4-й порядок), измеряется энергия (RMS).
// Границы полос — проектные ориентиры; «коридоры» для приёмки измеряются на эталонном
// корпусе, а не взяты из этого файла (H11 в рисерче — не подтверждённая гипотеза).

import { Biquad } from './biquad.js';

export const BANDS = [
  { id: 'sub', low: 20, high: 60 },
  { id: 'low', low: 60, high: 150 },
  { id: 'lowMid', low: 150, high: 400 },
  { id: 'mid', low: 400, high: 1500 },
  { id: 'highMid', low: 1500, high: 4000 },
  { id: 'high', low: 4000, high: 16000 },
];

export class BandAnalyzer {
  constructor(sampleRate, bands = BANDS) {
    this.sampleRate = sampleRate;
    this.bands = bands;
    this.filters = bands.map((band) => ({
      id: band.id,
      hp: new Biquad('highpass', { freq: band.low, sr: sampleRate, Q: 0.7071067811865476 }),
      lp: new Biquad('lowpass', { freq: Math.min(band.high, sampleRate * 0.49), sr: sampleRate, Q: 0.7071067811865476 }),
      sum: 0,
      count: 0,
    }));
  }

  reset() {
    for (const f of this.filters) {
      f.hp.reset();
      f.lp.reset();
      f.sum = 0;
      f.count = 0;
    }
    return this;
  }

  /** Обрабатывает канал (на месте не мутирует). */
  processChannel(channel) {
    for (const f of this.filters) {
      for (let i = 0; i < channel.length; i += 1) {
        const y = f.lp.processSample(f.hp.processSample(channel[i]));
        f.sum += y * y;
        f.count += 1;
      }
    }
    return this;
  }

  /** Уровни полос в дБ относительно полной шкалы. */
  levels() {
    const out = {};
    for (const f of this.filters) {
      const meanSquare = f.count > 0 ? f.sum / f.count : 0;
      out[f.id] = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -Infinity;
    }
    return out;
  }
}

/** Уровни полос по набору каналов (среднее по каналам). */
export function measureBands(channels, sampleRate, bands = BANDS) {
  const analyzer = new BandAnalyzer(sampleRate, bands);
  for (const ch of channels) analyzer.processChannel(Float64Array.from(ch));
  return analyzer.levels();
}
