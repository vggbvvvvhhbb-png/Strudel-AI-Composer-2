// Log-mel спектрограмма и сравнение тембра.
//
// Зачем: режиму «Разбор» нужно честно сказать, насколько двойник похож на
// оригинал ПО ТЕМБРУ. Единственный способ сделать это честно — считать
// спектрограмму одним и тем же кодом для обоих сигналов. Поэтому модуль
// чистый, без зависимостей, и покрыт тестами.
//
// ОПРЕДЕЛЕНИЕ (как в librosa, но без зависимости от него):
//   1. сигнал режется на окна 2048 отсчётов с перекрытием 50 %;
//   2. окно Ханна, FFT, спектр мощности;
//   3. мел-фильтры (треугольные) — 64 полосы от 32 Гц до частоты Найквиста;
//   4. логарифм мощности, нормировка по суммарной энергии кадра;
//   5. сравнение — косинусное расстояние между плоскими векторами.

import { powerSpectrum } from './fft.js';

export const DEFAULT_FFT_SIZE = 2048;
export const DEFAULT_HOP = 1024;
export const DEFAULT_N_MELS = 64;
export const DEFAULT_FMIN = 32;

/** Частота (Гц) → мел. */
export function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

/** Мел → частота (Гц). */
export function melToHz(mel) {
  return 700 * (10 ** (mel / 2595) - 1);
}

/**
 * Треугольные мел-фильтры: для каждой полосы — массив весов по бинам FFT.
 * @returns {{weights: Float64Array[], centers: Float64Array}}
 */
export function melFilterbank({
  sampleRate = 44100,
  fftSize = DEFAULT_FFT_SIZE,
  nMels = DEFAULT_N_MELS,
  fMin = DEFAULT_FMIN,
} = {}) {
  const bins = fftSize / 2 + 1;
  const fMax = sampleRate / 2;
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  const points = new Float64Array(nMels + 2);
  for (let i = 0; i < points.length; i += 1) {
    const mel = melMin + ((melMax - melMin) * i) / (nMels + 1);
    points[i] = (melToHz(mel) * fftSize) / sampleRate;
  }
  const weights = [];
  const centers = new Float64Array(nMels);
  for (let m = 0; m < nMels; m += 1) {
    const left = points[m];
    const center = points[m + 1];
    const right = points[m + 2];
    centers[m] = (center * sampleRate) / fftSize;
    const row = new Float64Array(bins);
    for (let k = 0; k < bins; k += 1) {
      if (k >= left && k <= center && center > left) {
        row[k] = (k - left) / (center - left);
      } else if (k > center && k <= right && right > center) {
        row[k] = (right - k) / (right - center);
      }
    }
    weights.push(row);
  }
  return { weights, centers };
}

/**
 * Log-mel спектрограмма.
 *
 * @param {Float64Array[]|Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {{frames: number, nMels: number, data: Float64Array[], hopSec: number, sampleRate: number}}
 */
export function logMelSpectrogram(channels, sampleRate, options = {}) {
  const {
    fftSize = DEFAULT_FFT_SIZE,
    hop = DEFAULT_HOP,
    nMels = DEFAULT_N_MELS,
    fMin = DEFAULT_FMIN,
  } = options;
  if (!channels?.length) throw new Error('Нет каналов для спектрограммы');
  const frames = Math.max(0, Math.floor((channels[0].length - fftSize) / hop) + 1);
  const { weights } = melFilterbank({ sampleRate, fftSize, nMels, fMin });
  const data = [];
  for (let f = 0; f < frames; f += 1) {
    const frame = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i += 1) {
      let value = 0;
      for (const channel of channels) value += channel[f * hop + i] ?? 0;
      frame[i] = value / channels.length;
    }
    const spectrum = powerSpectrum(frame);
    const mel = new Float64Array(nMels);
    let energy = 0;
    for (let m = 0; m < nMels; m += 1) {
      const row = weights[m];
      let sum = 0;
      for (let k = 0; k < row.length; k += 1) {
        if (row[k] > 0) sum += row[k] * spectrum[k];
      }
      mel[m] = Math.log(sum + 1e-10);
      energy += sum;
    }
    // Нормировка по кадру: убираем общий уровень, оставляем форму спектра.
    const norm = Math.log(energy + 1e-10);
    for (let m = 0; m < nMels; m += 1) mel[m] -= norm;
    data.push(mel);
  }
  return { frames, nMels, data, hopSec: hop / sampleRate, sampleRate, fftSize };
}

/**
 * Косинусное сходство двух log-mel спектрограмм.
 *
 * Сравниваются СРЕДНЕЕ по времени (спектральный профиль) и полная матрица
 * покадрового сходства: у двух треков одинаковый тембр, но разная длительность.
 *
 * @returns {{profile: number, frames: number, meanFrame: number}}
 */
export function cosineSimilarity(a, b) {
  if (!a?.data?.length || !b?.data?.length) return { profile: 0, frames: 0, meanFrame: 0 };
  const nMels = a.nMels;
  // Профиль: среднее по времени.
  const meanA = new Float64Array(nMels);
  const meanB = new Float64Array(nMels);
  for (const frame of a.data) for (let m = 0; m < nMels; m += 1) meanA[m] += frame[m];
  for (const frame of b.data) for (let m = 0; m < nMels; m += 1) meanB[m] += frame[m];
  for (let m = 0; m < nMels; m += 1) {
    meanA[m] /= a.data.length;
    meanB[m] /= b.data.length;
  }
  const profile = cosineOfVectors(meanA, meanB);

  // Покадровое сходство: для каждого кадра более короткого трека ищем лучший
  // кадр в более длинном (по косинусу) — грубое, но честное выравнивание.
  const shorter = a.data.length <= b.data.length ? a : b;
  const longer = a.data.length <= b.data.length ? b : a;
  const frameScores = [];
  for (const frame of shorter.data) {
    let best = -1;
    for (const other of longer.data) {
      const score = cosineOfVectors(frame, other);
      if (score > best) best = score;
    }
    frameScores.push(best);
  }
  const meanFrame = frameScores.reduce((sum, v) => sum + v, 0) / Math.max(1, frameScores.length);
  return { profile, frames: frameScores.length, meanFrame };
}

/** Косинусное сходство двух векторов одинаковой длины. */
export function cosineOfVectors(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return 0;
  return dot / denom;
}
