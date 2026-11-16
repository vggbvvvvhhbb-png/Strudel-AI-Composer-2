// Паспорт звука: измеренные признаки одного сэмпла (D-115).
//
// ЗАЧЕМ. Найденный в Freesound сэмпл бесполезен, пока о нём известно одно
// название. Паспорт отвечает на вопросы, которые важны при построении бита:
// какой у звука тембр (центроид), насколько он резкий (транзиенты), есть ли в
// нём тон (питч), это луп (темп) и сколько он громкий.
//
// ПРИНЦИП. В паспорте только числа, полученные из сигнала тем же DSP, что и
// в остальном проекте (src/audio/dsp/*). Чего измерить не удалось — там null,
// а не 0: «нет данных» ≠ 0.
//
// ЛИЦЕНЗИОННАЯ ЧИСТОТА. Паспорт описывает ЗВУК, а не источник: ни одна
// последовательность нот в паспорт не пишется. Из источника не переносится
// даже тройка подряд идущих высот — паспорт пригоден для построения нового
// материала, а не для переработки чужого.

import { measureLoudness, measurePeakDbfs, measureCrestDb } from '../../src/audio/dsp/loudness.js';
import { measureBands } from '../../src/audio/dsp/bands.js';
import { detectOnsets } from '../../src/audio/dsp/onsets.js';
import { detectF0Track } from '../../src/audio/dsp/pitch.js';
import { powerSpectrum } from '../../src/audio/dsp/fft.js';
import { pitchClass, PITCH_NAMES } from '../music/notes.js';

/** Окно для спектрального анализа. */
const FFT_SIZE = 2048;

/**
 * Округление: нечисло → null.
 * @param {unknown} value
 * @param {number} [digits]
 * @returns {number|null}
 */
function round(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

/**
 * Спектральный центроид и наклон спектра: усреднённая энергия по окнам.
 *
 * @param {Float64Array} mono
 * @param {number} sampleRate
 * @returns {{centroidHz:number|null, rolloffHz:number|null, flatness:number|null}}
 */
export function spectralShape(mono, sampleRate) {
  if (!mono?.length || mono.length < FFT_SIZE) {
    return { centroidHz: null, rolloffHz: null, flatness: null };
  }
  const hop = Math.max(FFT_SIZE, Math.floor(mono.length / 8));
  let weightSum = 0;
  let centroidSum = 0;
  let rolloffSum = 0;
  let flatnessSum = 0;
  for (let start = 0; start + FFT_SIZE <= mono.length; start += hop) {
    const frame = mono.subarray(start, start + FFT_SIZE);
    let energy = 0;
    for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i];
    if (energy <= 0) continue;
    const spectrum = powerSpectrum(frame);
    let total = 0;
    let weighted = 0;
    let logSum = 0;
    let linearSum = 0;
    for (let k = 1; k < spectrum.length; k += 1) {
      const power = spectrum[k];
      const hz = (k * sampleRate) / FFT_SIZE;
      total += power;
      weighted += power * hz;
      linearSum += power;
      logSum += Math.log(power + 1e-20);
    }
    if (!total) continue;
    centroidSum += weighted / total;
    // Наклон: частота, ниже которой сосредоточено 85 % энергии.
    let accumulated = 0;
    let rolloff = 0;
    for (let k = 1; k < spectrum.length; k += 1) {
      accumulated += spectrum[k];
      if (accumulated >= total * 0.85) {
        rolloff = (k * sampleRate) / FFT_SIZE;
        break;
      }
    }
    rolloffSum += rolloff;
    // Плоскостность спектра: геометрическое и арифметическое средние.
    const geometric = Math.exp(logSum / (spectrum.length - 1));
    const arithmetic = linearSum / (spectrum.length - 1);
    flatnessSum += arithmetic > 0 ? geometric / arithmetic : 0;
    weightSum += 1;
  }
  if (!weightSum) return { centroidHz: null, rolloffHz: null, flatness: null };
  return {
    centroidHz: round(centroidSum / weightSum, 1),
    rolloffHz: round(rolloffSum / weightSum, 1),
    flatness: round(flatnessSum / weightSum, 6),
  };
}

/**
 * Тональность сэмпла: медианная высота и доля голоса.
 *
 * @param {Float64Array} mono
 * @param {number} sampleRate
 * @returns {{f0Hz:number|null, note:string|null, voicedRatio:number|null}}
 */
export function tonalShape(mono, sampleRate) {
  if (!mono?.length) return { f0Hz: null, note: null, voicedRatio: null };
  const frames = detectF0Track(mono, sampleRate, { minFreq: 40, maxFreq: 800 });
  if (!frames.length) return { f0Hz: null, note: null, voicedRatio: null };
  const voiced = frames.filter((frame) => frame.hz !== null && frame.confidence >= 0.6);
  if (voiced.length < 2) return { f0Hz: null, note: null, voicedRatio: 0 };
  const sorted = voiced.map((frame) => frame.hz).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    f0Hz: round(median, 2),
    note: PITCH_NAMES[pitchClass(Math.round(69 + 12 * Math.log2(median / 440)))],
    voicedRatio: round(voiced.length / frames.length, 3),
  };
}

/**
 * Темп по атакам: медиана интервалов между ударами, приведённая к BPM.
 *
 * Для одиночного удара темпа нет — это null, а не 0.
 *
 * @param {number[]} times
 * @returns {{bpm:number|null, confidence:number|null}}
 */
export function tempoFromOnsets(times) {
  if (!Array.isArray(times) || times.length < 3) return { bpm: null, confidence: null };
  const intervals = [];
  for (let i = 1; i < times.length; i += 1) {
    const delta = times[i] - times[i - 1];
    if (delta > 0.05 && delta < 2) intervals.push(delta);
  }
  if (!intervals.length) return { bpm: null, confidence: null };
  const sorted = intervals.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bpm = 60 / median;
  // Приводим в диапазон 60..180: одинаковый ритм звучит и в 140, и в 70.
  while (bpm < 60) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  // Уверенность: доля интервалов, близких к медиане (в пределах 10 %).
  const close = intervals.filter((value) => Math.abs(value - median) / median < 0.1).length;
  return {
    bpm: round(bpm, 2),
    confidence: round(close / intervals.length, 3),
  };
}

/**
 * Собирает паспорт звука из каналов сигнала.
 *
 * @param {Float64Array[]} channels
 * @param {number} sampleRate
 * @param {{name?:string, source?:string}} [meta]
 * @returns {object} паспорт
 */
export function buildPassport(channels, sampleRate, meta = {}) {
  const list = (channels ?? []).map((channel) => Float64Array.from(channel));
  if (!list.length || !sampleRate) {
    return {
      name: meta.name ?? null,
      source: meta.source ?? null,
      durationS: null,
      sampleRate: sampleRate ?? null,
      channels: list.length || null,
      loudness: { lufsI: null, peakDbfs: null, crestDb: null },
      spectral: { centroidHz: null, rolloffHz: null, flatness: null, bands: null },
      transients: { count: null, densityPerSec: null, timesS: null },
      tonal: { f0Hz: null, note: null, voicedRatio: null },
      tempo: { bpm: null, confidence: null },
      character: null,
    };
  }

  const length = Math.min(...list.map((channel) => channel.length));
  const durationS = length / sampleRate;
  const mono = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const channel of list) sum += channel[i] ?? 0;
    mono[i] = sum / list.length;
  }

  const loudness = measureLoudness(list, sampleRate);
  const peakDbfs = measurePeakDbfs(list);
  const crestDb = measureCrestDb(list);
  const bands = measureBands(list, sampleRate);
  const spectrum = spectralShape(mono, sampleRate);
  const onsets = detectOnsets(list, sampleRate, { minInterOnsetSec: 0.05 });
  const times = onsets.times ?? [];
  const tonal = tonalShape(mono, sampleRate);
  const tempo = tempoFromOnsets(times);

  const densityPerSec = durationS > 0 ? times.length / durationS : null;
  const character = describeCharacter({
    centroidHz: spectrum.centroidHz,
    densityPerSec,
    voicedRatio: tonal.voicedRatio,
    lufsI: loudness.lufsI,
  });

  return {
    name: meta.name ?? null,
    source: meta.source ?? null,
    durationS: round(durationS, 3),
    sampleRate,
    channels: list.length,
    loudness: {
      lufsI: round(loudness.lufsI, 2),
      peakDbfs: Number.isFinite(peakDbfs) ? round(peakDbfs, 2) : null,
      crestDb: Number.isFinite(crestDb) ? round(crestDb, 2) : null,
    },
    spectral: {
      centroidHz: spectrum.centroidHz,
      rolloffHz: spectrum.rolloffHz,
      flatness: spectrum.flatness,
      bands: Object.fromEntries(
        Object.entries(bands).map(([id, value]) => [id, Number.isFinite(value) ? round(value, 2) : null]),
      ),
    },
    transients: {
      count: times.length,
      densityPerSec: round(densityPerSec, 3),
      timesS: times.slice(0, 32).map((value) => round(value, 4)),
    },
    tonal,
    tempo,
    character,
  };
}

/**
 * Краткое словесное описание характера звука — по измеренным величинам.
 *
 * Это не классификация «стекло/дерево/металл»: слишком грубо и врёт. Это
 * честные диапазоны по центроиду, плотности атак и доле голоса.
 *
 * @param {{centroidHz:number|null, densityPerSec:number|null, voicedRatio:number|null, lufsI:number|null}} input
 * @returns {string[]}
 */
export function describeCharacter({ centroidHz, densityPerSec, voicedRatio, lufsI } = {}) {
  const traits = [];
  if (Number.isFinite(centroidHz)) {
    if (centroidHz < 1200) traits.push('тёмный');
    else if (centroidHz < 3000) traits.push('средний');
    else if (centroidHz < 6000) traits.push('яркий');
    else traits.push('резкий по верхам');
  }
  if (Number.isFinite(densityPerSec)) {
    if (densityPerSec < 1) traits.push('редкие атаки');
    else if (densityPerSec < 4) traits.push('ударный');
    else traits.push('плотный');
  }
  if (Number.isFinite(voicedRatio)) {
    if (voicedRatio < 0.2) traits.push('без выраженного тона');
    else if (voicedRatio > 0.6) traits.push('тональный');
  }
  if (Number.isFinite(lufsI)) {
    if (lufsI < -30) traits.push('тихий');
    else if (lufsI > -8) traits.push('громкий');
  }
  return traits;
}
