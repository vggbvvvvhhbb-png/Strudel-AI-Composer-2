// Biquad-фильтры (RBJ Audio EQ Cookbook) — чистый JS, без Web Audio.
// Один и тот же код исполняется в Node-тестах, в AudioWorklet и в офлайн-рендерере,
// поэтому здесь не должно быть ни DOM, ни Node-специфичных API.

/**
 * Коэффициенты biquad-фильтра по форме RBJ.
 * @param {'highpass'|'lowpass'|'highshelf'|'lowshelf'|'peaking'} type
 * @param {{freq:number, sr:number, Q?:number, gainDb?:number}} p
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}} нормированные (a0 = 1)
 */
export function biquadCoeffs(type, { freq, sr, Q = 0.7071067811865476, gainDb = 0 }) {
  const f = Math.min(Math.max(freq, 1e-6), sr * 0.499);
  const w0 = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  const twoSqrtAalpha = 2 * Math.sqrt(A) * alpha;

  switch (type) {
    case 'highpass': {
      const b0 = (1 + cw) / 2;
      return { b0, b1: -(1 + cw), b2: (1 + cw) / 2, a1: -2 * cw, a2: 1 - alpha, _a0: 1 + alpha };
    }
    case 'lowpass': {
      const b0 = (1 - cw) / 2;
      return { b0, b1: 1 - cw, b2: (1 - cw) / 2, a1: -2 * cw, a2: 1 - alpha, _a0: 1 + alpha };
    }
    case 'highshelf': {
      const b0 = A * (A + 1 + (A - 1) * cw + twoSqrtAalpha);
      const b1 = -2 * A * (A - 1 + (A + 1) * cw);
      const b2 = A * (A + 1 + (A - 1) * cw - twoSqrtAalpha);
      const a0 = A + 1 - (A - 1) * cw + twoSqrtAalpha;
      const a1 = 2 * (A - 1 - (A + 1) * cw);
      const a2 = A + 1 - (A - 1) * cw - twoSqrtAalpha;
      return { b0, b1, b2, a1, a2, _a0: a0 };
    }
    case 'lowshelf': {
      const b0 = A * (A + 1 - (A - 1) * cw + twoSqrtAalpha);
      const b1 = 2 * A * (A - 1 - (A + 1) * cw);
      const b2 = A * (A + 1 - (A - 1) * cw - twoSqrtAalpha);
      const a0 = A + 1 + (A - 1) * cw + twoSqrtAalpha;
      const a1 = -2 * (A - 1 + (A + 1) * cw);
      const a2 = A + 1 + (A - 1) * cw - twoSqrtAalpha;
      return { b0, b1, b2, a1, a2, _a0: a0 };
    }
    case 'peaking': {
      const b0 = 1 + alpha * A;
      const b1 = -2 * cw;
      const b2 = 1 - alpha * A;
      const a0 = 1 + alpha / A;
      const a1 = -2 * cw;
      const a2 = 1 - alpha / A;
      return { b0, b1, b2, a1, a2, _a0: a0 };
    }
    case 'bandpass': {
      // Constant peak gain: для измерения энергии в полосе.
      const b0 = alpha;
      const b1 = 0;
      const b2 = -alpha;
      const a0 = 1 + alpha;
      return { b0, b1, b2, a1: -2 * cw, a2: 1 - alpha, _a0: a0 };
    }
    default:
      throw new Error(`Неизвестный тип biquad: ${type}`);
  }
}

/** Biquad в транспонированной форме direct form II: устойчив и без аллокаций в process(). */
export class Biquad {
  constructor(type, params) {
    this.set(type, params);
  }

  set(type, params) {
    const c = biquadCoeffs(type, params);
    const a0 = c._a0 ?? 1;
    this.b0 = c.b0 / a0;
    this.b1 = c.b1 / a0;
    this.b2 = c.b2 / a0;
    this.a1 = c.a1 / a0;
    this.a2 = c.a2 / a0;
    this.z1 = 0;
    this.z2 = 0;
    return this;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
    return this;
  }

  processSample(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** Обрабатывает блок на месте: input -> output (разные массивы допустимы). */
  processBlock(input, output = input) {
    const n = input.length;
    for (let i = 0; i < n; i += 1) {
      output[i] = this.processSample(input[i]);
    }
    return output;
  }
}

/** Копирует коэффициенты в готовый Biquad без пересчёта (для ручных таблиц). */
export function biquadFromRaw({ b0, b1, b2, a1, a2 }) {
  const f = new Biquad('highpass', { freq: 1000, sr: 48000 });
  f.b0 = b0;
  f.b1 = b1;
  f.b2 = b2;
  f.a1 = a1;
  f.a2 = a2;
  f.z1 = 0;
  f.z2 = 0;
  return f;
}
