// Node-слой измерений режима «Разбор».
//
// ЗАЧЕМ. Python-воркер умеет то, чего в Node нет: Demucs, темп, лад, секции,
// питч баса, аккорды. Но громкость, спектральный баланс, стерео и атаки
// считаются ЗДЕСЬ — тем же DSP, что и студия (src/audio/dsp/*). Иначе
// сравнение двойника с оригиналом было бы нечестным: два разных измерителя
// в двух разных местах.
//
// ПРИНЦИП. Ничего не угадываем: каждый вывод — из числа, полученного из
// аудио. Нет данных — поле отсутствует или null, а не «0».
//
// Что здесь НЕ делается: вокал не классифицируется по тональности, аккорды
// считает Python (chroma), слои не «смешиваются» в один — каждый слой
// измеряется отдельно.

import { measureLoudness, measurePeakDbfs } from '../../../src/audio/dsp/loudness.js';
import { measureTruePeak } from '../../../src/audio/dsp/truepeak.js';
import { measureBands } from '../../../src/audio/dsp/bands.js';
import { detectOnsets } from '../../../src/audio/dsp/onsets.js';
import { powerSpectrum } from '../../../src/audio/dsp/fft.js';

// Шкала спектрального баланса в контракте — snake_case.
const BAND_MAP = { sub: 'sub', low: 'low', lowMid: 'low_mid', mid: 'mid', highMid: 'high_mid', high: 'high' };

// Общее число точек сетки, доступных для подбора.
const GRID_CANDIDATES = [
  { step: '1/4', stepsPerBeat: 1 },
  { step: '1/8', stepsPerBeat: 2 },
  { step: '1/16', stepsPerBeat: 4 },
  { step: '1/32', stepsPerBeat: 8 },
];

const GRID_TOLERANCE_S = 0.035; // 35 мс — «уда�� попал в сетку»
const HIT_WINDOW_BEFORE = 0.02;
const HIT_WINDOW_AFTER = 0.08;

/**
 * Смешивает каналы в один моно-сигнал (среднее по каналам).
 * @param {Float64Array[]} channels
 * @returns {Float64Array}
 */
export function toMono(channels) {
  if (!channels?.length) return new Float64Array(0);
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float64Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) out[i] += channel[i];
  }
  for (let i = 0; i < length; i += 1) out[i] /= channels.length;
  return out;
}

/**
 * Громкость, true peak, спектральный баланс и стерео-картина микса.
 *
 * @param {Float64Array[]} channels
 * @param {number} sampleRate
 * @returns {{loudness:{lufs_integrated:number|null,true_peak_dbtp:number|null},
 *            spectral_balance:object, stereo:{correlation:number|null,width:number|null}}}
 */
export function measureMix(channels, sampleRate) {
  const loud = measureLoudness(channels, sampleRate);
  const truePeak = measureTruePeak(channels, sampleRate);
  const bandLevels = measureBands(channels, sampleRate);

  // Полосы нормализуем в доли суммарной энергии: так баланс — распределение,
  // а не абсолютные децибелы (иначе тихий трек выглядит «пустым»).
  const balance = {};
  let total = 0;
  for (const [id, db] of Object.entries(bandLevels)) {
    const power = Number.isFinite(db) ? 10 ** (db / 10) : 0;
    balance[BAND_MAP[id] ?? id] = power;
    total += power;
  }
  const spectralBalance = {};
  for (const [id, power] of Object.entries(balance)) {
    spectralBalance[id] = total > 0 ? Number((power / total).toFixed(4)) : 0;
  }

  return {
    loudness: {
      lufs_integrated: loud.lufsI === null ? null : Number(loud.lufsI.toFixed(2)),
      true_peak_dbtp: Number.isFinite(truePeak.truePeakDb) ? Number(truePeak.truePeakDb.toFixed(2)) : null,
    },
    spectral_balance: spectralBalance,
    stereo: measureStereo(channels),
  };
}

/**
 * Стерео-картина: корреляция каналов и ширина (разница/сумма).
 * @param {Float64Array[]} channels
 */
export function measureStereo(channels) {
  if (!channels?.length || channels.length < 2) {
    return { correlation: null, width: null };
  }
  const [left, right] = channels;
  const length = Math.min(left.length, right.length);
  let ll = 0;
  let rr = 0;
  let lr = 0;
  let sum = 0;
  let diff = 0;
  for (let i = 0; i < length; i += 1) {
    ll += left[i] * left[i];
    rr += right[i] * right[i];
    lr += left[i] * right[i];
    sum += (left[i] + right[i]) ** 2;
    diff += (left[i] - right[i]) ** 2;
  }
  const correlation = ll > 0 && rr > 0 ? Number((lr / Math.sqrt(ll * rr)).toFixed(4)) : null;
  const width = sum > 0 ? Number(Math.sqrt(diff / sum).toFixed(4)) : null;
  return { correlation, width };
}

/**
 * Активность слоя по секциям: доля от максимальной RMS-энергии секции.
 * Нормировка на глобальный максимум, поэтому «тихая» секция честно тихая,
 * а не «полная» (как было бы при нормировке на сам слой).
 *
 * @param {Float64Array[]} channels
 * @param {number} sampleRate
 * @param {Array<{index:number,start_s:number,end_s:number}>} sections
 * @returns {Record<string, number>} ключ — индекс секции (строка)
 */
export function measureActivity(channels, sampleRate, sections) {
  const mono = toMono(channels);
  if (!mono.length || !sections?.length) return {};
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const rms = [];
  for (let start = 0; start + hop <= mono.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < hop; i += 1) sum += mono[start + i] ** 2;
    rms.push(Math.sqrt(sum / hop));
  }
  let maxRms = 0;
  for (const value of rms) if (value > maxRms) maxRms = value;

  const activity = {};
  for (const section of sections) {
    const from = Math.max(0, Math.floor(section.start_s * sampleRate));
    const to = Math.min(mono.length, Math.ceil(section.end_s * sampleRate));
    if (to <= from) {
      activity[String(section.index)] = 0;
      continue;
    }
    let sum = 0;
    let count = 0;
    for (let i = from; i < to; i += 1) {
      sum += mono[i] ** 2;
      count += 1;
    }
    const sectionRms = count ? Math.sqrt(sum / count) : 0;
    activity[String(section.index)] = maxRms > 0 ? Number(Math.min(1, sectionRms / maxRms).toFixed(4)) : 0;
  }
  return activity;
}

/**
 * Спектральный профиль одного удара: энергия по полосам + центроид.
 * Окно: от начала удара минус 20 мс до плюс 80 мс.
 */
function hitSpectrum(mono, sampleRate, timeS) {
  const size = 1024;
  const center = Math.round(timeS * sampleRate);
  const from = Math.max(0, center - Math.round(HIT_WINDOW_BEFORE * sampleRate));
  const to = Math.min(mono.length, center + Math.round(HIT_WINDOW_AFTER * sampleRate));
  const frame = new Float64Array(size);
  const usable = Math.max(0, to - from);
  for (let i = 0; i < usable; i += 1) frame[i] = mono[from + i];
  const spectrum = powerSpectrum(frame);
  const binHz = sampleRate / size;
  let weighted = 0;
  let total = 0;
  const bandEnergy = { sub: 0, low: 0, mid: 0, high: 0, air: 0 };
  for (let k = 1; k < spectrum.length; k += 1) {
    const hz = k * binHz;
    const power = spectrum[k];
    weighted += hz * power;
    total += power;
    if (hz < 90) bandEnergy.sub += power;
    else if (hz < 300) bandEnergy.low += power;
    else if (hz < 2200) bandEnergy.mid += power;
    else if (hz < 8000) bandEnergy.high += power;
    else bandEnergy.air += power;
  }
  const centroid = total > 0 ? weighted / total : 0;
  const norm = total > 0 ? total : 1;
  return {
    centroid,
    sub: bandEnergy.sub / norm,
    low: bandEnergy.low / norm,
    mid: bandEnergy.mid / norm,
    high: bandEnergy.high / norm,
    air: bandEnergy.air / norm,
  };
}

/**
 * Затухание удара: доля энергии окна «после 60 мс» относительно пика.
 * Короткое затухание — признак закрытого хэта, длинное — открытого/тарелки.
 */
function decayRatio(mono, sampleRate, timeS) {
  const center = Math.round(timeS * sampleRate);
  const peakEnd = Math.min(mono.length, center + Math.round(0.02 * sampleRate));
  let peak = 0;
  for (let i = Math.max(0, center - Math.round(0.01 * sampleRate)); i < peakEnd; i += 1) {
    const v = Math.abs(mono[i]);
    if (v > peak) peak = v;
  }
  if (peak <= 0) return 0;
  const tailStart = center + Math.round(0.06 * sampleRate);
  const tailEnd = Math.min(mono.length, center + Math.round(0.25 * sampleRate));
  let tail = 0;
  for (let i = tailStart; i < tailEnd; i += 1) tail += mono[i] ** 2;
  const tailPeak = Math.sqrt((tail / Math.max(1, tailEnd - tailStart)) / (peak ** 2));
  return Math.min(1, tailPeak);
}

/**
 * Классификация удара в General MIDI.
 *
 * ПРАВИЛА (измеримые, не «на глаз»):
 *   кик       — энергия в полосе < 300 Гц преобладает, центроид < 400 Гц;
 *   малый     — широкополосный удар: заметная энергия 300..8000 Гц и
 *               центроид 700..6000 Гц;
 *   закрытый хэт — энергия > 5 кГц преобладает, затухание быстрое;
 *   открытый хэт — энергия > 3 кГц преобладает, затухание длинное;
 *   тарелка   — очень широкополосно и очень длинный хвост.
 *
 * Уверенность — нормированный отрыв победителя от второго места.
 */
export function classifyDrumHit(profile) {
  const { centroid, sub, low, mid, high, air, decay } = profile;
  const lowEnergy = sub + low;
  const highEnergy = high + air;
  const scores = {};

  // Кик: низа доминируют.
  scores[36] = lowEnergy > 0.5 && centroid < 400 ? 0.55 + 0.4 * (1 - centroid / 400) : lowEnergy * 0.25;
  // Малый барабан: середина + верх, но не «шум хэта».
  scores[38] = mid > 0.18 && centroid >= 500 ? 0.45 + 0.3 * Math.min(1, mid) : mid * 0.3;
  // Закрытый хэт: верх доминирует, хвост короткий.
  scores[42] = highEnergy > 0.45 && decay < 0.45 ? 0.5 + 0.4 * (1 - decay) : highEnergy * 0.2;
  // Открытый хэт: верх доминирует, хвост длинный.
  scores[46] = highEnergy > 0.4 && decay >= 0.45 ? 0.45 + 0.35 * Math.min(1, decay) : highEnergy * 0.2;
  // Тарелка: очень широко и очень длинный хвост.
  scores[49] = highEnergy > 0.5 && decay > 0.7 && centroid > 5000 ? 0.4 + 0.3 * Math.min(1, decay) : 0.05;

  const ranked = Object.entries(scores)
    .map(([gm, score]) => ({ gm: Number(gm), score }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const runnerUp = ranked[1]?.score ?? 0;
  const confidence = Math.max(0, Math.min(1, (best.score - runnerUp) * 1.5 + best.score * 0.4));
  const labels = { 36: 'bd', 38: 'sd', 42: 'hh', 46: 'oh', 49: 'cr' };
  return {
    gm: best.gm,
    label: labels[best.gm] ?? 'unknown',
    confidence: Number(confidence.toFixed(3)),
    spectral_centroid_hz: Math.round(centroid),
  };
}

/**
 * Подбор сетки: шаг, к которому лучше всего ложатся атаки.
 * @param {number[]} times
 * @param {number} bpm
 */
export function fitGrid(times, bpm) {
  if (!times?.length || !Number.isFinite(bpm) || bpm <= 0) {
    return { step: '1/8', fit_ratio: 0 };
  }
  const beat = 60 / bpm;
  // Сетки перебираются от крупной к мелкой. Удар на 1/8 лежит и на сетке 1/16,
  // поэтому «лучшая» сетка всегда самая мелкая — а это неверно: разрешение
  // должно быть минимально достаточным. Правило: берём САМУЮ КРУПНУЮ сетку,
  // на которой атаки ложатся хорошо; если ни одна не ложится — берём лучшую.
  const GOOD_FIT = 0.9;
  let best = { step: '1/8', fit_ratio: 0 };
  for (const candidate of GRID_CANDIDATES) {
    const stepDur = beat / candidate.stepsPerBeat;
    let hits = 0;
    for (const time of times) {
      const nearest = Math.round(time / stepDur) * stepDur;
      if (Math.abs(time - nearest) <= GRID_TOLERANCE_S) hits += 1;
    }
    const fit = hits / times.length;
    if (fit > best.fit_ratio) best = { step: candidate.step, fit_ratio: fit };
    if (fit >= GOOD_FIT) {
      best = { step: candidate.step, fit_ratio: fit };
      break;
    }
  }
  return { step: best.step, fit_ratio: Number(best.fit_ratio.toFixed(4)) };
}

/**
 * Свинг сетки: 0.5 — ровно, больше — вторая доля опаздывает.
 * Считается по атакам на «и» (нечётные восьмые): их систематическое
 * опоздание относительно сетки 1/8 и есть свинг.
 */
export function measureSwing(times, bpm) {
  if (!times?.length || !Number.isFinite(bpm) || bpm <= 0) return 0.5;
  const eighth = 30 / bpm; // длительность восьмой при bpm
  const offsets = [];
  for (const time of times) {
    const position = time / eighth;
    const nearest = Math.round(position);
    // Чётные доли (0, 2, 4...) — «сильные» восьмые, нечётные — слабые.
    if (Math.abs(nearest) % 2 !== 1) continue;
    const offset = (position - nearest) * eighth;
    if (Math.abs(offset) <= eighth * 0.4) offsets.push(offset);
  }
  if (offsets.length < 2) return 0.5;
  const mean = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
  const swing = 0.5 + mean / eighth;
  return Number(Math.max(0, Math.min(1, swing)).toFixed(4));
}

/**
 * Полное описание слоя ударных: атаки, сетка, свинг, динамика, GM-классификация.
 *
 * @param {Float64Array[]} channels
 * @param {number} sampleRate
 * @param {{bpm?:number, sections?:Array}} [options]
 */
export function measureDrums(channels, sampleRate, options = {}) {
  const mono = toMono(channels);
  if (!mono.length) return { onsets: { count: 0 }, activity: {} };

  const onsets = detectOnsets(channels, sampleRate, { delta: options.onsetDelta ?? 0.12 });
  const times = onsets.times;

  // Пиковая громкость каждого удара — основа динамики.
  const peaks = times.map((time) => {
    const center = Math.round(time * sampleRate);
    const to = Math.min(mono.length, center + Math.round(0.02 * sampleRate));
    let peak = 0;
    for (let i = Math.max(0, center - Math.round(0.005 * sampleRate)); i < to; i += 1) {
      const v = Math.abs(mono[i]);
      if (v > peak) peak = v;
    }
    return peak;
  });
  // 95-й перцентиль как «100 % динамики»: единичные выбросы не сжимают шкалу.
  const sorted = [...peaks].sort((a, b) => a - b);
  const reference = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;

  const hits = [];
  for (let i = 0; i < times.length; i += 1) {
    const profile = hitSpectrum(mono, sampleRate, times[i]);
    profile.decay = decayRatio(mono, sampleRate, times[i]);
    const classified = classifyDrumHit(profile);
    hits.push({
      time_s: times[i],
      gm: classified.gm,
      label: classified.label,
      confidence: classified.confidence,
      velocity: reference > 0 ? Number(Math.min(1, peaks[i] / reference).toFixed(3)) : 0,
      spectral_centroid_hz: classified.spectral_centroid_hz,
    });
  }

  const velocities = hits.map((hit) => hit.velocity);
  const mean = velocities.length ? velocities.reduce((s, v) => s + v, 0) / velocities.length : 0;
  const variance = velocities.length
    ? velocities.reduce((s, v) => s + (v - mean) ** 2, 0) / velocities.length
    : 0;

  const bpm = options.bpm;
  const grid = fitGrid(times, bpm);
  const swing = measureSwing(times, bpm);

  return {
    onsets: {
      count: hits.length,
      grid,
      swing,
      velocity: {
        mean: Number(mean.toFixed(4)),
        std: Number(Math.sqrt(variance).toFixed(4)),
        curve: velocities,
      },
      hits,
    },
    activity: options.sections ? measureActivity(channels, sampleRate, options.sections) : {},
  };
}

/**
 * Пик громкости микса в dBFS — нужен для выравнивания A/B-плеера.
 */
export function peakDbfs(channels) {
  return measurePeakDbfs(channels);
}
