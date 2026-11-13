// Громкость по ITU-R BS.1770-4 / EBU R 128: LUFS (мгновенная, кратковременная, интегральная).
// Реализация следует стандарту: блоки 400 мс с шагом 100 мс,
// абсолютный гейт −70 LUFS, относительный гейт −10 LU.

import { KWeighting } from './k-weighting.js';

// Каналы L, R, C — вес 1.0; боковые (Ls, Rs) — 1.41 (BS.1770-4, таблица 2).
const CHANNEL_WEIGHTS = [1, 1, 1, 1.41, 1.41];

/** -0.691 — константа смещения из BS.1770-4 (гарантирует 0 LUFS для сигнала постоянной амплитуды). */
export const LOUDNESS_OFFSET = -0.691;

export const ABSOLUTE_GATE_LUFS = -70;
export const RELATIVE_GATE_LU = -10;

function blockMeanSquare(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
  return sum / Math.max(1, to - from);
}

/**
 * Измеряет громкость набора каналов (Float32Array/Float64Array).
 * @param {Array<Float32Array|Float64Array>} channels
 * @param {number} sampleRate
 * @returns {{lufsI:number|null, lufsM:number|null, lufsS:number|null, blockLufs:number[], gatedBlocks:number}}
 */
export function measureLoudness(channels, sampleRate, { blockMs = 400, hopMs = 100 } = {}) {
  // У каждого канала своя пара фильтров: состояние biquad общее на каналы использовать нельзя.
  const kw = new KWeighting(sampleRate);
  const weightedChannels = kw.processChannels(channels);

  const length = Math.min(...weightedChannels.map((c) => c.length));
  const blockSize = Math.max(1, Math.round((blockMs * sampleRate) / 1000));
  const hop = Math.max(1, Math.round((hopMs * sampleRate) / 1000));
  if (length < blockSize) {
    return { lufsI: null, lufsM: null, lufsS: null, blockLufs: [], gatedBlocks: 0 };
  }

  const blocks = [];
  const powers = [];
  for (let start = 0; start + blockSize <= length; start += hop) {
    let z = 0;
    for (let c = 0; c < weightedChannels.length; c += 1) {
      const weight = CHANNEL_WEIGHTS[c] ?? 1;
      z += weight * blockMeanSquare(weightedChannels[c], start, start + blockSize);
    }
    powers.push(z);
    blocks.push(z > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(z) : -Infinity);
  }

  // Абсолютный гейт.
  const absGated = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i] > ABSOLUTE_GATE_LUFS) absGated.push(i);
  }

  // Относительный гейт: −10 LU относительно средней мощности прошедших блоков.
  let relThreshold = -Infinity;
  if (absGated.length > 0) {
    let sum = 0;
    for (const i of absGated) sum += powers[i];
    const meanPower = sum / absGated.length;
    relThreshold = LOUDNESS_OFFSET + 10 * Math.log10(meanPower) + RELATIVE_GATE_LU;
  }

  const kept = absGated.filter((i) => blocks[i] > relThreshold);
  let lufsI = null;
  if (kept.length > 0) {
    let sum = 0;
    for (const i of kept) sum += powers[i];
    lufsI = LOUDNESS_OFFSET + 10 * Math.log10(sum / kept.length);
  }

  const lufsM = blocks.length ? blocks[blocks.length - 1] : null;

  // Кратковременная: последнее окно 3 с (усреднение по той же схеме блоков, но без гейта).
  const shortWindow = Math.round((3000 * sampleRate) / 1000);
  let lufsS = null;
  if (length >= shortWindow) {
    let z = 0;
    for (let c = 0; c < weightedChannels.length; c += 1) {
      const weight = CHANNEL_WEIGHTS[c] ?? 1;
      z += weight * blockMeanSquare(weightedChannels[c], length - shortWindow, length);
    }
    lufsS = z > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(z) : -Infinity;
  }

  return { lufsI, lufsM, lufsS, blockLufs: blocks, gatedBlocks: kept.length };
}

/** Пиковый уровень (sample peak) в dBFS по всем каналам. */
export function measurePeakDbfs(channels) {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Crest factor: разница между пиком и среднеквадратичным уровнем, дБ. */
export function measureCrestDb(channels) {
  const peakDb = measurePeakDbfs(channels);
  let sum = 0;
  let count = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) sum += ch[i] * ch[i];
    count += ch.length;
  }
  const rmsDb = count > 0 && sum > 0 ? 10 * Math.log10(sum / count) : -Infinity;
  return peakDb - rmsDb;
}
