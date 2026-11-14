// Детектор атак (onsets) по спектральному потоку.
//
// Зачем: режиму «Разбор» нужно сравнивать ритм двойника с ритмом оригинала
// по атакам (F-measure, допуск ±50 мс). Чтобы сравнение было честным,
// детектор должен быть ОДИН и тот же для обоих сигналов — поэтому он живёт
// здесь, в общем DSP, а не в питоне.
//
// Метод: log-mel спектрограмма -> спектральный поток (сумма положительных
// приращений) -> адаптивный порог (медиана в окне) -> выбор пиков.
// Это классический pipeline (Böck, 2006) в упрощённом виде.

import { logMelSpectrogram } from './mel.js';

/**
 * @param {Float64Array[]|Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{fftSize?:number, hop?:number, nMels?:number, window?:number, delta?:number,
 *          minInterOnsetSec?:number}} [options]
 * @returns {{times:number[], strengths:number[], flux:number[], hopSec:number}}
 */
export function detectOnsets(channels, sampleRate, options = {}) {
  const {
    fftSize = 1024,
    hop = 256,
    nMels = 40,
    window = 8,
    delta = 0.12,
    minInterOnsetSec = 0.05,
  } = options;

  const spec = logMelSpectrogram(channels, sampleRate, { fftSize, hop, nMels });
  const flux = new Float64Array(Math.max(0, spec.frames - 1));
  for (let f = 1; f < spec.frames; f += 1) {
    let sum = 0;
    const current = spec.data[f];
    const previous = spec.data[f - 1];
    for (let m = 0; m < nMels; m += 1) {
      const diff = current[m] - previous[m];
      if (diff > 0) sum += diff;
    }
    flux[f - 1] = sum;
  }

  // Нормировка потока в 0..1 — порог должен быть безразмерным.
  let maxFlux = 0;
  for (const value of flux) if (value > maxFlux) maxFlux = value;
  if (maxFlux > 0) for (let i = 0; i < flux.length; i += 1) flux[i] /= maxFlux;

  const times = [];
  const strengths = [];
  const minGap = Math.max(1, Math.round(minInterOnsetSec / spec.hopSec));
  let lastIndex = -minGap;
  for (let i = 0; i < flux.length; i += 1) {
    const value = flux[i];
    if (value < delta) continue;
    // Локальный максимум в окне.
    let isPeak = true;
    for (let j = Math.max(0, i - window); j <= Math.min(flux.length - 1, i + window); j += 1) {
      if (flux[j] > value || (flux[j] === value && j < i)) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    // Адаптивный порог: медиана в окне.
    const slice = [];
    for (let j = Math.max(0, i - window * 3); j <= Math.min(flux.length - 1, i + window * 3); j += 1) slice.push(flux[j]);
    slice.sort((a, b) => a - b);
    const median = slice[Math.floor(slice.length / 2)] ?? 0;
    if (value < median + delta * 0.5) continue;
    if (i - lastIndex < minGap) continue;
    lastIndex = i;
    times.push(Number(((i + 1) * spec.hopSec).toFixed(6)));
    strengths.push(Number(value.toFixed(4)));
  }
  return { times, strengths, flux: Array.from(flux), hopSec: spec.hopSec };
}

/**
 * F-measure двух списков атак с допуском по времени.
 *
 * @param {number[]} referenceTimes атаки оригинала
 * @param {number[]} candidateTimes атаки двойника
 * @param {{toleranceMs?:number}} [options]
 * @returns {{f1:number, precision:number, recall:number, toleranceMs:number, matched:number}}
 */
export function onsetFMeasure(referenceTimes, candidateTimes, options = {}) {
  const tolerance = (options.toleranceMs ?? 50) / 1000;
  const reference = [...(referenceTimes ?? [])].sort((a, b) => a - b);
  const candidate = [...(candidateTimes ?? [])].sort((a, b) => a - b);
  const used = new Array(candidate.length).fill(false);
  let matched = 0;
  for (const time of reference) {
    let bestIndex = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < candidate.length; i += 1) {
      if (used[i]) continue;
      const delta = Math.abs(candidate[i] - time);
      if (delta <= tolerance && delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      used[bestIndex] = true;
      matched += 1;
    }
  }
  const precision = candidate.length ? matched / candidate.length : 0;
  const recall = reference.length ? matched / reference.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    f1: Number(f1.toFixed(4)),
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    toleranceMs: Math.round(tolerance * 1000),
    matched,
  };
}

/**
 * Корреляция огибающих громкости — грубовая мера «грува» (совпадает ли рисунок
 * нарастаний и спадов).
 *
 * @param {Float64Array[]} a
 * @param {Float64Array[]} b
 * @param {number} sampleRate
 */
export function envelopeCorrelation(a, b, sampleRate, options = {}) {
  const hop = options.hop ?? Math.max(1, Math.round(sampleRate * 0.01)); // 10 мс
  const ea = rmsEnvelope(a, sampleRate, hop);
  const eb = rmsEnvelope(b, sampleRate, hop);
  const n = Math.min(ea.length, eb.length);
  if (!n) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += ea[i];
    mb += eb[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = ea[i] - ma;
    const db = eb[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  if (!denom) return 0;
  return Number((cov / denom).toFixed(4));
}

/** Огибающая RMS с шагом hop (по умолчанию 10 мс). */
export function rmsEnvelope(channels, sampleRate, hop = Math.round(sampleRate * 0.01)) {
  const frames = Math.max(0, Math.floor((channels[0]?.length ?? 0) / hop));
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (const channel of channels) {
      for (let i = f * hop; i < (f + 1) * hop; i += 1) sum += (channel[i] ?? 0) ** 2;
    }
    out[f] = Math.sqrt(sum / (hop * channels.length));
  }
  return out;
}
