// DSP режима «Разбор»: FFT, log-mel, атаки и метрики похожести.
//
// Проверяем на СИНТЕТИЧЕСКИХ сигналах, где правильный ответ известен заранее:
//   * синус 1000 Гц -> пик спектра в нужной полосе;
//   * щелчки с заданными интервалами -> атаки в те же моменты;
//   * одинаковый сигнал -> сходство 1.0, сдвинутый -> меньше.
// Так метрики нельзя «подогнать» под удобный результат.

import { describe, it, expect } from 'vitest';
import { fftInPlace, powerSpectrum } from '../../src/audio/dsp/fft.js';
import { logMelSpectrogram, cosineSimilarity, cosineOfVectors, melFilterbank, hzToMel, melToHz } from '../../src/audio/dsp/mel.js';
import { detectOnsets, onsetFMeasure, envelopeCorrelation, rmsEnvelope } from '../../src/audio/dsp/onsets.js';
import { compareNotes, compareRhythm, compareTimbre, compareTwin } from '../../server/deepdive/compare.js';

const SAMPLE_RATE = 44100;

/** Синус заданной частоты. */
function sine(freq, seconds, sampleRate = SAMPLE_RATE, amplitude = 0.5) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return [out];
}

/** Сигнал с щелчками в заданные моменты (экспоненциальный спад). */
function clicks(times, seconds, sampleRate = SAMPLE_RATE) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float64Array(n);
  for (const time of times) {
    const start = Math.round(time * sampleRate);
    for (let i = 0; i < 2000 && start + i < n; i += 1) {
      out[start + i] += 0.8 * Math.exp(-i / 220) * Math.sin((2 * Math.PI * 1800 * i) / sampleRate);
    }
  }
  return [out];
}

describe('FFT', () => {
  it('находит пик в частоте синуса', () => {
    const size = 4096;
    const freq = 1000;
    const frame = new Float64Array(size);
    for (let i = 0; i < size; i += 1) frame[i] = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
    const spectrum = powerSpectrum(frame);
    let peakBin = 0;
    for (let k = 1; k < spectrum.length; k += 1) if (spectrum[k] > spectrum[peakBin]) peakBin = k;
    const peakHz = (peakBin * SAMPLE_RATE) / size;
    expect(Math.abs(peakHz - freq)).toBeLessThan(SAMPLE_RATE / size);
  });

  it('работает на произвольной степени двойки и не падает', () => {
    const re = new Float64Array(64);
    const im = new Float64Array(64);
    for (let i = 0; i < 64; i += 1) re[i] = Math.sin(i);
    expect(() => fftInPlace(re, im)).not.toThrow();
    expect(() => fftInPlace(new Float64Array(63), new Float64Array(63))).toThrow(/степенью двойки/);
  });
});

describe('log-mel', () => {
  it('мел и частота ходят туда-обратно', () => {
    expect(Math.abs(melToHz(hzToMel(1000)) - 1000)).toBeLessThan(1);
  });

  it('строит спектрограмму ожидаемого размера', () => {
    const spec = logMelSpectrogram(sine(1000, 1), SAMPLE_RATE, { fftSize: 1024, hop: 512, nMels: 32 });
    expect(spec.nMels).toBe(32);
    expect(spec.frames).toBeGreaterThan(10);
    expect(spec.data[0]).toHaveLength(32);
  });

  it('фильтр-банк покрывает полосу до Найквиста', () => {
    const bank = melFilterbank({ sampleRate: SAMPLE_RATE, nMels: 40 });
    expect(bank.weights).toHaveLength(40);
    expect(bank.centers[39]).toBeGreaterThan(bank.centers[0]);
    expect(bank.centers[39]).toBeLessThan(SAMPLE_RATE / 2 + 1);
  });

  it('одинаковый сигнал даёт сходство 1, другой — меньше', () => {
    const a = logMelSpectrogram(sine(1000, 1), SAMPLE_RATE);
    const b = logMelSpectrogram(sine(1000, 1), SAMPLE_RATE);
    const c = logMelSpectrogram(sine(4000, 1), SAMPLE_RATE);
    const same = cosineSimilarity(a, b);
    const different = cosineSimilarity(a, c);
    expect(same.profile).toBeGreaterThan(0.99);
    expect(different.profile).toBeLessThan(same.profile);
  });

  it('косинус векторов считается верно', () => {
    expect(cosineOfVectors([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineOfVectors([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineOfVectors([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
});

describe('детектор атак', () => {
  it('находит щелчки в заданные моменты', () => {
    const times = [0.5, 1.0, 1.5, 2.0];
    const detected = detectOnsets(clicks(times, 2.5), SAMPLE_RATE);
    expect(detected.times.length).toBeGreaterThanOrEqual(times.length - 1);
    for (const expected of times) {
      const nearest = detected.times.reduce((best, t) => (Math.abs(t - expected) < Math.abs(best - expected) ? t : best), 999);
      expect(Math.abs(nearest - expected)).toBeLessThan(0.05);
    }
  });

  it('F-measure считается по допуску времени', () => {
    const score = onsetFMeasure([1, 2, 3], [1.02, 2.5, 3.01], { toleranceMs: 50 });
    expect(score.matched).toBe(2);
    expect(score.recall).toBeCloseTo(2 / 3, 3);
    expect(score.precision).toBeCloseTo(2 / 3, 3);
    expect(score.f1).toBeCloseTo((2 * (2 / 3) * (2 / 3)) / (2 / 3 + 2 / 3), 3);
  });

  it('одинаковые сигналы дают корреляцию огибающих 1', () => {
    const signal = clicks([0.5, 1.0, 1.5], 2);
    const correlation = envelopeCorrelation(signal, signal, SAMPLE_RATE);
    expect(correlation).toBeGreaterThan(0.99);
  });

  it('огибающая RMS короче сигнала', () => {
    const signal = clicks([0.5], 2);
    const envelope = rmsEnvelope(signal, SAMPLE_RATE, 4410);
    // 2 с = 88200 отсчётов, шаг 4410 => 20 кадров.
    expect(envelope.length).toBe(20);
    expect(envelope.length).toBeLessThan(signal[0].length / 100);
  });
});

describe('сравнение нот баса', () => {
  it('совпавшие ноты дают долю 1', () => {
    const notes = [
      { time_s: 0, midi: 40 },
      { time_s: 0.5, midi: 43 },
      { time_s: 1.0, midi: 45 },
    ];
    const score = compareNotes(notes, notes);
    expect(score.note_match_ratio).toBe(1);
    expect(score.matched).toBe(3);
    expect(score.f0_rmse_cents).toBe(0);
  });

  it('октавовая разница не считается ошибкой', () => {
    const reference = [{ time_s: 0, midi: 40 }];
    const candidate = [{ time_s: 0, midi: 52 }]; // ровно октава выше
    const score = compareNotes(reference, candidate);
    expect(score.note_match_ratio).toBe(1);
  });

  it('промах по высоте уменьшает долю', () => {
    const reference = [{ time_s: 0, midi: 40 }];
    const candidate = [{ time_s: 0, midi: 43 }]; // 300 центов
    const score = compareNotes(reference, candidate);
    expect(score.note_match_ratio).toBe(0);
  });
});

describe('сравнение слоёв', () => {
  it('ритм: одинаковые атаки дают F1 = 1', () => {
    const times = [0.5, 1.0, 1.5, 2.0];
    const signal = clicks(times, 2.5);
    const score = compareRhythm(
      { channels: signal, sampleRate: SAMPLE_RATE },
      { channels: signal, sampleRate: SAMPLE_RATE },
    );
    expect(score.f1).toBeGreaterThan(0.95);
  });

  it('ритм: сдвинутые атаки ухудшают F1', () => {
    const reference = clicks([0.5, 1.0, 1.5, 2.0], 2.5);
    const candidate = clicks([0.55, 1.05, 1.55, 2.05], 2.5);
    const score = compareRhythm(
      { channels: reference, sampleRate: SAMPLE_RATE },
      { channels: candidate, sampleRate: SAMPLE_RATE },
    );
    expect(score.f1).toBeLessThan(0.9);
  });

  it('тембр: одинаковый сигнал даёт косинус 1', () => {
    const signal = sine(1000, 1);
    const score = compareTimbre(
      { channels: signal, sampleRate: SAMPLE_RATE },
      { channels: signal, sampleRate: SAMPLE_RATE },
    );
    expect(score.cosine).toBeGreaterThan(0.99);
  });
});

describe('полное сравнение двойника', () => {
  it('одинаковые слои дают высокую общую оценку', () => {
    const times = [0.5, 1.0, 1.5, 2.0];
    const signal = clicks(times, 2.5);
    const notes = [{ time_s: 0.5, midi: 40 }, { time_s: 1.0, midi: 43 }];
    const result = compareTwin({
      reference: { drums: { channels: signal, sampleRate: SAMPLE_RATE }, mix: { channels: signal, sampleRate: SAMPLE_RATE } },
      candidate: { drums: { channels: signal, sampleRate: SAMPLE_RATE }, mix: { channels: signal, sampleRate: SAMPLE_RATE } },
      referenceBassNotes: notes,
      candidateBassNotes: notes,
      referenceSwing: 0.56,
      candidateSwing: 0.56,
    });
    expect(result.overall).toBeGreaterThan(0.9);
    expect(result.layers.rhythm.f1).toBeGreaterThan(0.95);
    expect(result.layers.bass.note_match_ratio).toBe(1);
    expect(result.layers.groove.swing_delta).toBe(0);
    expect(result.missing_layers).toHaveLength(0);
  });

  it('отсутствующий слой — это «нет данных», а не ноль', () => {
    const result = compareTwin({
      reference: { mix: { channels: sine(200, 1), sampleRate: SAMPLE_RATE } },
      candidate: { mix: { channels: sine(200, 1), sampleRate: SAMPLE_RATE } },
    });
    expect(result.missing_layers).toContain('rhythm');
    expect(result.layers.rhythm).toBeUndefined();
    expect(result.overall).toBeGreaterThan(0);
  });

  it('метрики помечены версией метода', () => {
    const result = compareTwin({});
    expect(result.method).toMatch(/compare@/);
    expect(result.iteration).toBe(0);
  });
});
