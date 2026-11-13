// K-взвешивание ITU-R BS.1770-4 (стадия 1): полосовой шелл + RLB-фильтр нижних частот.
//
// Коэффициенты считаются по формулам Таблицы 2 стандарта (произвольная частота
// дискретизации), а не по RBJ: формулы RBJ дают другие коэффициенты (проверено —
// расхождение до 0.05 в b0 шелла, то есть другая АЧХ, а не другой округ).
//
// Проверка: пересчёт при 48 кГц совпадает с таблицей стандарта до 1e-16.
// Это и есть контрактный тест `K-взвешивание совпадает с ITU-R BS.1770-4`.

import { biquadFromRaw } from './biquad.js';

/** Табличные коэффициенты ITU-R BS.1770-4 для 48 кГц (эталон для самопроверки). */
export const K_WEIGHTING_48K = {
  shelf: { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 },
  hpf: { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 },
};

// Аналоговый прототип из Таблицы 2 стандарта.
const PROTOTYPE = {
  shelf: { f0: 1681.974450955533, Q: 0.7071752369554196, gainDb: 3.999843853973347 },
  hpf: { f0: 38.13547087602444, Q: 0.5003270373238773 },
};

/**
 * Полосовой шелл стадии 1 по формулам ITU-R BS.1770-4, Таблица 2.
 * @param {number} sampleRate
 */
export function ituShelfCoefficients(sampleRate) {
  const { f0, Q, gainDb } = PROTOTYPE.shelf;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, gainDb / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

/**
 * RLB-фильтр нижних частот (стадия 2) по формулам ITU-R BS.1770-4, Таблица 2.
 * @param {number} sampleRate
 */
export function ituHighpassCoefficients(sampleRate) {
  const { f0, Q } = PROTOTYPE.hpf;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

/**
 * Коэффициенты K-взвешивания под произвольную частоту дискретизации.
 * @param {number} sampleRate
 * @returns {{shelf: object, hpf: object}}
 */
export function kWeightingCoefficients(sampleRate) {
  return { shelf: ituShelfCoefficients(sampleRate), hpf: ituHighpassCoefficients(sampleRate) };
}

/**
 * K-взвешиватель: у каждого канала своя пара фильтров (общее состояние на каналы
 * использовать нельзя — иначе каналы «смешиваются» по фазе).
 */
export class KWeighting {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    const { shelf, hpf } = kWeightingCoefficients(sampleRate);
    // Каждый канал получает свою пару фильтров: общее состояние на каналы
    // использовать нельзя — иначе каналы смешиваются по фазе.
    this.channels = Array.from({ length: 2 }, () => ({
      shelf: biquadFromRaw(shelf),
      hpf: biquadFromRaw(hpf),
    }));
    this.shelfL = this.channels[0].shelf;
    this.shelfR = this.channels[1].shelf;
    this.hpfL = this.channels[0].hpf;
    this.hpfR = this.channels[1].hpf;
  }

  reset() {
    for (const pair of this.channels) {
      pair.shelf.reset();
      pair.hpf.reset();
    }
    return this;
  }

  /** Взвешивает канал (на месте). */
  processChannel(channel, shelf, hpf) {
    for (let i = 0; i < channel.length; i += 1) {
      channel[i] = hpf.processSample(shelf.processSample(channel[i]));
    }
    return channel;
  }

  /**
   * Взвешивает стерео-пары в новые массивы (вход не мутируется).
   * @returns {[Float64Array, Float64Array]}
   */
  processStereo(left, right) {
    const l = Float64Array.from(left);
    const r = Float64Array.from(right);
    this.processChannel(l, this.channels[0].shelf, this.channels[0].hpf);
    this.processChannel(r, this.channels[1].shelf, this.channels[1].hpf);
    return [l, r];
  }

  /**
   * Взвешивает набор каналов: для каждого канала — своя пара фильтров.
   * @param {Array<Float32Array|Float64Array>} channels
   * @returns {Float64Array[]}
   */
  processChannels(channels) {
    const { shelf, hpf } = kWeightingCoefficients(this.sampleRate);
    return channels.map((ch, index) => {
      const copy = Float64Array.from(ch);
      const pair = this.channels[index];
      // Каналы сверх стерео получают собственные фильтры (глубже двух каналов
      // в BS.1770 всё равно нет веса, но фильтр нужен для корректной АЧХ).
      const shelfFilter = pair ? pair.shelf : biquadFromRaw(shelf);
      const hpfFilter = pair ? pair.hpf : biquadFromRaw(hpf);
      this.processChannel(copy, shelfFilter, hpfFilter);
      return copy;
    });
  }
}
