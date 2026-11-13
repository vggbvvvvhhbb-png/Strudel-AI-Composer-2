// Потоковый измеритель громкости по ITU-R BS.1770-4 / EBU R 128.
//
// Нужен мастер-worklet: метры должны считаться в реальном времени, блок за
// блоком, без выделения памяти и без доступа к целому сигналу.
//
// Схема повторяет пакетный `measureLoudness` из loudness.js:
//   K-взвешивание → средний квадрат по блокам 400 мс с шагом 100 мс →
//   абсолютный гейт −70 LUFS → относительный гейт −10 LU.
//
// Реализация через кольцевой буфер «сумма взвешенных квадратов на отсчёт»:
// по стандарту z = Σ_i G_i · z_i, где z_i — средний квадрат канала i на блоке,
// поэтому z блока = среднее по отсчётам величины Σ_i G_i · x_i[t]². Это
// позволяет считать всё одним проходом по отсчётам.

import { biquadFromRaw } from './biquad.js';
import { ituHighpassCoefficients, ituShelfCoefficients } from './k-weighting.js';
import { ABSOLUTE_GATE_LUFS, LOUDNESS_OFFSET, RELATIVE_GATE_LU } from './loudness.js';

// Веса каналов по BS.1770-4, таблица 2: L, R, C — 1.0; Ls, Rs — 1.41.
const CHANNEL_WEIGHTS = [1, 1, 1, 1.41, 1.41];

const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

export class LoudnessMeter {
  /**
   * @param {number} sampleRate
   * @param {{blockMs?:number, hopMs?:number, shortMs?:number, maxBlocks?:number}} [options]
   */
  constructor(sampleRate, { blockMs = 400, hopMs = 100, shortMs = 3000, maxBlocks = 12000 } = {}) {
    this.sampleRate = sampleRate;
    this.blockSamples = Math.max(1, Math.round((blockMs * sampleRate) / 1000));
    this.hopSamples = Math.max(1, Math.round((hopMs * sampleRate) / 1000));
    this.shortSamples = Math.max(1, Math.round((shortMs * sampleRate) / 1000));

    const shelf = ituShelfCoefficients(sampleRate);
    const hpf = ituHighpassCoefficients(sampleRate);
    // Своя пара фильтров на канал: общее состояние смешивает каналы по фазе.
    this.shelfL = biquadFromRaw(shelf);
    this.shpfL = biquadFromRaw(hpf);
    this.shelfR = biquadFromRaw(shelf);
    this.shpfR = biquadFromRaw(hpf);

    // Кольцо «сумма взвешенных квадратов» длинной shortSamples: из него берутся
    // и окно 400 мс, и окно 3 с.
    this.ringSize = Math.max(this.blockSamples, this.shortSamples);
    this.ring = new Float64Array(this.ringSize);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.sumBlock = 0;
    this.sumShort = 0;

    // Накопленные блоки (мощности и их LUFS) — кольцо фиксированного размера,
    // чтобы в аудиопотоке не появлялись аллокации.
    this.maxBlocks = maxBlocks;
    this.blockPowers = new Float64Array(maxBlocks);
    this.blockLufs = new Float64Array(maxBlocks);
    this.blockCount = 0;
    this.blockWriteIndex = 0;
    this.samplesToHop = 0;

    this.momentaryLufs = null;
    this.shortLufs = null;
    this.integratedLufs = null;
    this.clipCount = 0;
    this.peak = 0;
  }

  reset() {
    this.ring.fill(0);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.sumBlock = 0;
    this.sumShort = 0;
    this.blockPowers.fill(0);
    this.blockLufs.fill(0);
    this.blockCount = 0;
    this.blockWriteIndex = 0;
    this.samplesToHop = 0;
    this.shelfL.reset();
    this.shpfL.reset();
    this.shelfR.reset();
    this.shpfR.reset();
    this.momentaryLufs = null;
    this.shortLufs = null;
    this.integratedLufs = null;
    this.clipCount = 0;
    this.peak = 0;
    return this;
  }

  /**
   * Обрабатывает стерео-блок. Память не выделяется.
   * @param {Float32Array|Float64Array} left
   * @param {Float32Array|Float64Array} right
   */
  process(left, right) {
    const n = Math.min(left.length, right.length);
    const ring = this.ring;
    const size = this.ringSize;
    const blockSamples = this.blockSamples;
    const shortSamples = this.shortSamples;
    const weightL = CHANNEL_WEIGHTS[0] ?? 1;
    const weightR = CHANNEL_WEIGHTS[1] ?? 1;

    let idx = this.writeIndex;
    let sumBlock = this.sumBlock;
    let sumShort = this.sumShort;
    let clipCount = this.clipCount;
    let peak = this.peak;

    for (let i = 0; i < n; i += 1) {
      const l = this.shpfL.processSample(this.shelfL.processSample(left[i]));
      const r = this.shpfR.processSample(this.shelfR.processSample(right[i]));

      const absL = Math.abs(left[i]);
      const absR = Math.abs(right[i]);
      if (absL > peak) peak = absL;
      if (absR > peak) peak = absR;
      if (absL >= 1 || absR >= 1) clipCount += 1;

      const s = weightL * l * l + weightR * r * r;

      // Значение, выходящее из окна 400 мс.
      sumBlock += s - ring[(idx - blockSamples + size) % size];
      // Значение, выходящее из окна 3 с.
      sumShort += s - ring[(idx - shortSamples + size) % size];

      ring[idx] = s;
      idx = (idx + 1) % size;

      this.totalSamples += 1;
      this.samplesToHop += 1;
      if (this.samplesToHop >= this.hopSamples) {
        this.samplesToHop = 0;
        this.pushBlock(sumBlock / blockSamples);
      }
    }

    this.writeIndex = idx;
    this.sumBlock = sumBlock;
    this.sumShort = sumShort;
    this.clipCount = clipCount;
    this.peak = peak;

    // Кратковременная (3 с) — среднее по окну, без гейта.
    this.shortLufs =
      this.totalSamples >= shortSamples && sumShort > 0
        ? LOUDNESS_OFFSET + 10 * Math.log10(sumShort / shortSamples)
        : null;

    return this;
  }

  /** Записывает блок 400 мс в кольцо блоков. */
  pushBlock(power) {
    const lufs = power > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(power) : -Infinity;
    this.blockPowers[this.blockWriteIndex] = power;
    this.blockLufs[this.blockWriteIndex] = lufs;
    this.blockWriteIndex = (this.blockWriteIndex + 1) % this.maxBlocks;
    if (this.blockCount < this.maxBlocks) this.blockCount += 1;
    this.momentaryLufs = Number.isFinite(lufs) ? lufs : null;
    this.integratedLufs = this.computeIntegrated();
  }

  /**
   * Интегральная громкость: абсолютный гейт −70 LUFS, затем относительный
   * гейт −10 LU относительно средней мощности прошедших блоков.
   * @returns {number|null}
   */
  computeIntegrated() {
    if (!this.blockCount) return null;
    const count = this.blockCount;
    const start = this.blockCount < this.maxBlocks ? 0 : this.blockWriteIndex;

    let absSum = 0;
    let absCount = 0;
    for (let i = 0; i < count; i += 1) {
      const power = this.blockPowers[(start + i) % this.maxBlocks];
      const lufs = this.blockLufs[(start + i) % this.maxBlocks];
      if (lufs > ABSOLUTE_GATE_LUFS) {
        absSum += power;
        absCount += 1;
      }
    }
    if (!absCount) return null;

    const relThreshold =
      LOUDNESS_OFFSET + 10 * Math.log10(absSum / absCount) + RELATIVE_GATE_LU;

    let keptSum = 0;
    let keptCount = 0;
    for (let i = 0; i < count; i += 1) {
      const power = this.blockPowers[(start + i) % this.maxBlocks];
      const lufs = this.blockLufs[(start + i) % this.maxBlocks];
      if (lufs > ABSOLUTE_GATE_LUFS && lufs > relThreshold) {
        keptSum += power;
        keptCount += 1;
      }
    }
    if (!keptCount) return null;
    return LOUDNESS_OFFSET + 10 * Math.log10(keptSum / keptCount);
  }

  /** Пиковый уровень (sample peak) в dBFS. */
  get peakDbfs() {
    return toDb(this.peak);
  }

  /** Снимок метрик — то, что уходит в порт worklet и в отчёты. */
  snapshot() {
    return {
      lufsM: this.momentaryLufs,
      lufsS: this.shortLufs,
      lufsI: this.integratedLufs,
      peakDbfs: this.peakDbfs,
      clipCount: this.clipCount,
    };
  }
}
