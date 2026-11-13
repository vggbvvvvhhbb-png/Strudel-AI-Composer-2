// True peak (ITU-R BS.1770-4, приложение 2): реконструкция сигнала с передискретизацией 4×
// и поиск максимума между отсчётами. Потолок приёмки — −1.0 dBTP.
//
// Фильтр интерполятора взят из референсной реализации стандарта — libebur128
// (ebur128.c, `interp_create`): 49 отсчётов, передискретизация 4×, окно Ханнинга
// на синусоидальном интерполяторе:
//
//   c[j] = sinc((j − 24)·π/4) · 0.5·(1 − cos(2πj/48)),  j = 0…48
//   фаза p = j mod 4, задержка отсчёта = j div 4
//
// Почему именно так, а не «идеальная реконструкция»: измеритель true peak
// должен совпадать с тем, чем считают стриминговые платформы (libebur128,
// ffmpeg ebur128). Свой фильтр с другой АЧХ даёт другую цифру — и сравнение
// с эталоном перестаёт быть сравнением, а сравнением двух разных приборов.
//
// Важные детали, которые стоили отладки:
//
//  1. Групповая задержка фильтра — ЦЕЛОЕ число исходных отсчётов (6 при 4×),
//     иначе реконструкция сдвигается на долю отсчёта и пик искажается.
//
//  2. Sample-peak для приёмки не годится: между отсчётами пик выше.

const OVERSAMPLE = 4;
// 49 отсчётов, как в libebur128: этого достаточно для 4×-передискретизации
// и даёт задержку 6 исходных отсчётов (целое число).
const TAPS = 49;
const CENTER = (TAPS - 1) / 2; // 24

function sinc(x) {
  if (Math.abs(x) < 1e-12) return 1;
  return Math.sin(x) / x;
}

/** Окно Ханнинга на отрезке 0…TAPS−1 (как в libebur128). */
function hann(j) {
  return 0.5 * (1 - Math.cos((2 * Math.PI * j) / (TAPS - 1)));
}

/**
 * Полифазные коэффициенты интерполятора: phases[p] — вклад отсчётов в фазу p.
 *
 * @returns {Array<{coeffs:Float64Array, indices:Int32Array, sum:number}>}
 */
export function truePeakFilter() {
  const phases = [];
  for (let p = 0; p < OVERSAMPLE; p += 1) {
    const coeffs = [];
    const indices = [];
    for (let j = p; j < TAPS; j += OVERSAMPLE) {
      coeffs.push(sinc(((j - CENTER) * Math.PI) / OVERSAMPLE) * hann(j));
      indices.push(Math.floor(j / OVERSAMPLE));
    }
    const sum = coeffs.reduce((a, b) => a + b, 0);
    phases.push({
      coeffs: Float64Array.from(coeffs),
      indices: Int32Array.from(indices),
      sum,
    });
  }
  return phases;
}

const FILTER_CACHE = new Map();

function getFilter(sampleRate) {
  if (!FILTER_CACHE.has(sampleRate)) FILTER_CACHE.set(sampleRate, truePeakFilter());
  return FILTER_CACHE.get(sampleRate);
}

/**
 * Потоковый передискретизатель 4×.
 *
 * Режимы:
 *  - потоковый (для worklet): processSample(x) → 4 передискретизированных
 *    значения по одному, без выделения памяти;
 *  - пакетный (для Node-тестов и офлайн-рендера): processChannel(input).
 */
export class TruePeakOversampler {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.phases = getFilter(sampleRate);
    this.history = new Float64Array(TAPS);
    this.historyIndex = 0;
    // Выходные значения 4 фаз текущего отсчёта (без аллокаций).
    this.phaseOut = new Float64Array(OVERSAMPLE);
  }

  reset() {
    this.history.fill(0);
    this.historyIndex = 0;
    this.phaseOut.fill(0);
    return this;
  }

  /** Задержка реконструкции в отсчётах исходного сигнала. */
  get latencySamples() {
    return CENTER / OVERSAMPLE;
  }

  /**
   * Один отсчёт → 4 передискретизированных значения (в this.phaseOut).
   * Память не выделяется: пригодно для аудиопотока.
   * @param {number} x
   * @returns {Float64Array} this.phaseOut
   */
  processSample(x) {
    const phases = this.phases;
    const hist = this.history;
    const zi = this.historyIndex;
    hist[zi] = x;

    for (let p = 0; p < OVERSAMPLE; p += 1) {
      const phase = phases[p];
      const coeffs = phase.coeffs;
      const indices = phase.indices;
      let acc = 0;
      for (let t = 0; t < coeffs.length; t += 1) {
        let i = zi - indices[t];
        if (i < 0) i += TAPS;
        acc += coeffs[t] * hist[i];
      }
      this.phaseOut[p] = acc;
    }

    this.historyIndex = (zi + 1) % TAPS;
    return this.phaseOut;
  }

  /**
   * Обрабатывает один канал, возвращает 4×-передискретизированный сигнал.
   * @param {Float32Array|Float64Array} input
   * @param {Float64Array} [out] буфер для результата (без аллокаций)
   * @returns {Float64Array}
   */
  processChannel(input, out) {
    const result = out ?? new Float64Array(input.length * OVERSAMPLE);
    const phases = this.phases;
    const hist = this.history;
    let zi = this.historyIndex;

    for (let n = 0; n < input.length; n += 1) {
      hist[zi] = input[n];
      for (let p = 0; p < OVERSAMPLE; p += 1) {
        const phase = phases[p];
        const coeffs = phase.coeffs;
        const indices = phase.indices;
        let acc = 0;
        for (let t = 0; t < coeffs.length; t += 1) {
          let i = zi - indices[t];
          if (i < 0) i += TAPS;
          acc += coeffs[t] * hist[i];
        }
        result[n * OVERSAMPLE + p] = acc;
      }
      zi = (zi + 1) % TAPS;
    }

    this.historyIndex = zi;
    return result;
  }
}

/**
 * Измеряет true peak по каналам.
 * @returns {{truePeakDb:number, peakDb:number, oversampledPeak:number, latencySamples:number}}
 */
export function measureTruePeak(channels, sampleRate) {
  let oversampledPeak = 0;
  let samplePeak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      const v = Math.abs(ch[i]);
      if (v > samplePeak) samplePeak = v;
    }
    const os = new TruePeakOversampler(sampleRate).processChannel(ch);
    for (let i = 0; i < os.length; i += 1) {
      const v = Math.abs(os[i]);
      if (v > oversampledPeak) oversampledPeak = v;
    }
  }
  const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return {
    truePeakDb: toDb(oversampledPeak),
    peakDb: toDb(samplePeak),
    oversampledPeak,
    latencySamples: CENTER / OVERSAMPLE,
  };
}
