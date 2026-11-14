// Измерения режима «Разбор»: громкость, баланс, стерео, активность, сетка,
// свинг и GM-классификация ударов.
//
// Проверяем на СИНТЕТИЧЕСКИХ сигналах с заранее известным ответом:
// истинный ответ не «примерно похоже на», а вычислен заранее.

import { describe, it, expect } from 'vitest';
import {
  measureMix,
  measureStereo,
  measureActivity,
  measureDrums,
  fitGrid,
  measureSwing,
  classifyDrumHit,
  toMono,
} from '../../server/deepdive/audio/measure.js';

const SR = 44100;

/** Синусоида заданной частоты и амплитуды. */
function sine(freq, seconds, amplitude = 0.5, sampleRate = SR) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/** Короткий удар: затухающая синусоида (похоже на бочку/малый). */
function click(timeS, freq, seconds = 2, sampleRate = SR, decay = 40) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float64Array(n);
  const start = Math.round(timeS * sampleRate);
  for (let i = 0; i < n; i += 1) {
    const index = start + i;
    if (index < 0 || index >= out.length) continue;
    out[index] = 0.8 * Math.exp(-i / decay) * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

/** Складывает сигналы в один канал. */
function mix(...signals) {
  const length = Math.max(...signals.map((signal) => signal.length));
  const out = new Float64Array(length);
  for (const signal of signals) {
    for (let i = 0; i < signal.length; i += 1) out[i] += signal[i];
  }
  return out;
}

describe('измерения микса', () => {
  it('считает громкость и пик числом, а не нулём', () => {
    const { loudness } = measureMix([sine(1000, 3, 0.5)], SR);
    expect(loudness.lufs_integrated).toBeTypeOf('number');
    expect(loudness.lufs_integrated).toBeLessThan(0);
    expect(loudness.true_peak_dbtp).toBeTypeOf('number');
  });

  it('спектральный баланс — доли, и в сумме дают единицу', () => {
    const { spectral_balance } = measureMix([sine(100, 3, 0.5)], SR);
    const values = Object.values(spectral_balance);
    expect(values.length).toBeGreaterThanOrEqual(6);
    const sum = values.reduce((acc, value) => acc + value, 0);
    expect(sum).toBeCloseTo(1, 3);
    // Низкая частота должна попасть в нижние полосы.
    expect(spectral_balance.sub + spectral_balance.low).toBeGreaterThan(0.5);
  });

  it('одинаковые каналы дают корреляцию 1 и нулевую ширину', () => {
    const stereo = measureStereo([sine(440, 1, 0.4), sine(440, 1, 0.4)]);
    expect(stereo.correlation).toBeCloseTo(1, 3);
    expect(stereo.width).toBeCloseTo(0, 3);
  });

  it('инвертированный канал даёт корреляцию −1', () => {
    const left = sine(440, 1, 0.4);
    const inverted = new Float64Array(left.length);
    for (let i = 0; i < left.length; i += 1) inverted[i] = -left[i];
    const stereo = measureStereo([left, inverted]);
    expect(stereo.correlation).toBeCloseTo(-1, 3);
  });

  it('моно-сигнал: стерео-метрики недоступны, а не нули', () => {
    const stereo = measureStereo([sine(440, 1, 0.4)]);
    expect(stereo.correlation).toBeNull();
    expect(stereo.width).toBeNull();
  });
});

describe('активность по секциям', () => {
  it('тихая секция честно тише громкой', () => {
    const loud = sine(200, 2, 0.6);
    const quiet = sine(200, 2, 0.05);
    const signal = new Float64Array(loud.length + quiet.length);
    signal.set(loud, 0);
    signal.set(quiet, loud.length);
    const sections = [
      { index: 0, start_s: 0, end_s: 2 },
      { index: 1, start_s: 2, end_s: 4 },
    ];
    const activity = measureActivity([signal], SR, sections);
    expect(activity['0']).toBeGreaterThan(activity['1']);
    expect(activity['1']).toBeGreaterThanOrEqual(0);
    expect(activity['1']).toBeLessThanOrEqual(1);
  });
});

describe('сетка и свинг', () => {
  it('удары на восьмых при 120 BPM дают сетку 1/8 с идеальной посадкой', () => {
    const eighth = 0.25; // 120 BPM => 1/8 = 0.25 с
    const times = [];
    for (let i = 0; i < 16; i += 1) times.push(i * eighth);
    const grid = fitGrid(times, 120);
    expect(grid.step).toBe('1/8');
    expect(grid.fit_ratio).toBeCloseTo(1, 3);
  });

  it('удары на шестнадцатых при 120 BPM дают сетку 1/16, а не 1/8', () => {
    const sixteenth = 0.125;
    const times = [];
    for (let i = 0; i < 32; i += 1) times.push(i * sixteenth);
    const grid = fitGrid(times, 120);
    expect(grid.step).toBe('1/16');
    expect(grid.fit_ratio).toBeCloseTo(1, 3);
  });

  it('ровная сетка даёт свинг 0.5, а опоздавшие «и» — больше', () => {
    const eighth = 0.25;
    const straight = [];
    for (let i = 0; i < 16; i += 1) straight.push(i * eighth);
    expect(measureSwing(straight, 120)).toBeCloseTo(0.5, 2);

    const swung = straight.map((time, index) => (index % 2 === 1 ? time + 0.05 : time));
    expect(measureSwing(swung, 120)).toBeGreaterThan(0.5);
  });
});

describe('классификация ударов', () => {
  it('низкий удар — бочка', () => {
    const classified = classifyDrumHit({
      centroid: 120, sub: 0.7, low: 0.2, mid: 0.05, high: 0.03, air: 0.02, decay: 0.2,
    });
    expect(classified.gm).toBe(36);
    expect(classified.label).toBe('bd');
    expect(classified.confidence).toBeGreaterThan(0.3);
  });

  it('средний широкополосный удар — малый барабан', () => {
    const classified = classifyDrumHit({
      centroid: 2200, sub: 0.05, low: 0.1, mid: 0.45, high: 0.3, air: 0.1, decay: 0.3,
    });
    expect(classified.gm).toBe(38);
  });

  it('верхний короткий удар — закрытый хэт', () => {
    const classified = classifyDrumHit({
      centroid: 9000, sub: 0.01, low: 0.02, mid: 0.08, high: 0.35, air: 0.54, decay: 0.1,
    });
    expect(classified.gm).toBe(42);
  });
});

describe('слой ударных целиком', () => {
  it('находит удары и распределяет их по ролям', () => {
    const bpm = 120;
    const eighth = 0.25;
    const parts = [];
    for (let i = 0; i < 8; i += 1) {
      parts.push(click(i * eighth, 120)); // бочка на каждой восьмой
      if (i % 2 === 0) parts.push(click(i * eighth + 0.001, 3000, 2, SR, 12)); // хэт
    }
    const signal = mix(...parts);
    const drums = measureDrums([signal], SR, { bpm });
    expect(drums.onsets.count).toBeGreaterThanOrEqual(8);
    expect(drums.onsets.hits.length).toBe(drums.onsets.count);
    for (const hit of drums.onsets.hits) {
      expect(typeof hit.gm).toBe('number');
      expect(hit.velocity).toBeGreaterThanOrEqual(0);
      expect(hit.velocity).toBeLessThanOrEqual(1);
      expect(hit.time_s).toBeGreaterThanOrEqual(0);
    }
    expect(drums.onsets.velocity.mean).toBeGreaterThan(0);
    expect(drums.onsets.velocity.std).toBeGreaterThanOrEqual(0);
  });
});

describe('моно-смешивание', () => {
  it('среднее по каналам', () => {
    const mono = toMono([new Float64Array([1, 1]), new Float64Array([0, 2])]);
    expect(mono[0]).toBeCloseTo(0.5, 6);
    expect(mono[1]).toBeCloseTo(1.5, 6);
  });
});
