// Быстрое преобразование Фурье (radix-2, Кули-Тюки) для вещественного сигнала.
//
// Зачем в проекте: режиму «Разбор» нужно считать спектральные признаки по
// чужому аудио — log-mel для сравнения тембра, спектральный поток для поиска
// атак. Раньше в проекте FFT не было вообще (спектральный баланс считался
// шестью полосами по biquad-RMS, src/audio/dsp/bands.js).
//
// Особенность: реализация сознательно без внешних зависимостей, потому что
// считать спектр должен ОДИН И ТОТ ЖЕ код для оригинала и для двойника —
// иначе сравнение нечестно.

/**
 * FFT на месте: массив длины 2^n (степень двойки).
 * @param {Float64Array|Float32Array} re
 * @param {Float64Array|Float32Array} im
 */
export function fftInPlace(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('Размер FFT должен быть степенью двойки');
  // Бит-реверс перестановка.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k += 1) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Спектр мощности окна: |X(k)|² для k = 0..n/2.
 *
 * @param {Float64Array|Float32Array} frame окно длины n (степень двойки)
 * @param {Float64Array|Float32Array} [window] оконная функция (по умолчанию Ханна)
 * @returns {Float64Array} n/2+1 значений
 */
export function powerSpectrum(frame, window) {
  const n = frame.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let windowSum = 0;
  for (let i = 0; i < n; i += 1) {
    const w = window ? window[i] : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    windowSum += w;
    re[i] = frame[i] * w;
  }
  fftInPlace(re, im);
  const bins = n / 2 + 1;
  const out = new Float64Array(bins);
  for (let k = 0; k < bins; k += 1) {
    out[k] = (re[k] * re[k] + im[k] * im[k]) / (windowSum * windowSum || 1);
  }
  return out;
}
