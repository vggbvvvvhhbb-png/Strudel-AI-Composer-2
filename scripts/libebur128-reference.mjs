// Референсная реализация true peak по EBU R 128 — буквальная транскрипция
// libebur128 (ebur128.c: interp_create + interp_process).
//
// Нужна как эталон в тестах и в сверке с ffmpeg. Живёт в scripts/, потому что
// это проверочный код, а не часть приложения.
//
// Почему не ffmpeg: ffmpeg измеряет true peak не фильтром приложения 2
// стандарта, а ресемплером libswresample (до 192 кГц). У ресемплера своя АЧХ,
// и на широкополосных сигналах он завышает пик до +0.7 дБ. libebur128 —
// эталон самого стандарта EBU R 128, поэтому сверка идёт с ним.

const FACTOR = 4;
const TAPS = 49;
const DELAY = (TAPS + FACTOR - 1) / FACTOR; // 13

/**
 * True peak по алгоритму libebur128.
 * @param {Float32Array|Float64Array} input
 * @returns {number} максимум |x| по передискретизированному сигналу
 */
export function libebur128TruePeak(input) {
  const filter = [];
  for (let f = 0; f < FACTOR; f += 1) filter.push({ index: [], coeff: [] });

  for (let j = 0; j < TAPS; j += 1) {
    const m = j - (TAPS - 1) / 2;
    let c = 1;
    if (Math.abs(m) > 1e-6) c = Math.sin((m * Math.PI) / FACTOR) / ((m * Math.PI) / FACTOR);
    c *= 0.5 * (1 - Math.cos((2 * Math.PI * j) / (TAPS - 1)));
    if (Math.abs(c) > 1e-6) {
      const f = j % FACTOR;
      filter[f].index.push(Math.floor(j / FACTOR));
      filter[f].coeff.push(c);
    }
  }

  const z = new Float64Array(DELAY);
  let zi = 0;
  let peak = 0;
  for (let frame = 0; frame < input.length; frame += 1) {
    z[zi] = input[frame];
    for (let f = 0; f < FACTOR; f += 1) {
      let acc = 0;
      for (let t = 0; t < filter[f].coeff.length; t += 1) {
        let i = zi - filter[f].index[t];
        if (i < 0) i += DELAY;
        acc += z[i] * filter[f].coeff[t];
      }
      const v = acc < 0 ? -acc : acc;
      if (v > peak) peak = v;
    }
    zi += 1;
    if (zi === DELAY) zi = 0;
  }
  return peak;
}

/** То же в децибелах. */
export function libebur128TruePeakDb(input) {
  const peak = libebur128TruePeak(input);
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}
