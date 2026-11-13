// Glue-компрессор для мастер-цепочки: порог, отношение, мягкое колено, атака/возврат.
// Стереосвязанный (детектор по максимуму каналов), чтобы стерео-образ не разъезжался.

const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const toLin = (db) => Math.pow(10, db / 20);

export class GlueCompressor {
  constructor(sampleRate, { thresholdDb = -20, ratio = 3, kneeDb = 6, attackMs = 20, releaseMs = 200, makeupDb = 0 } = {}) {
    this.sampleRate = sampleRate;
    this.thresholdDb = thresholdDb;
    this.ratio = ratio;
    this.kneeDb = kneeDb;
    this.makeupDb = makeupDb;
    this.attackCoef = Math.exp(-1 / Math.max(1, (attackMs * sampleRate) / 1000));
    this.releaseCoef = Math.exp(-1 / Math.max(1, (releaseMs * sampleRate) / 1000));
    this.reset();
  }

  reset() {
    this.grDb = 0;
    this.envelopeDb = -Infinity;
    return this;
  }

  /**
   * Целевое ослабление (дБ) для уровня levelDb с учётом мягкого колена.
   * Знак отрицательный: это величина, на которую УМЕНЬШАЕТСЯ усиление
   * (grDb ≤ 0). Положительное значение означало бы усиление наоборот.
   */
  static targetReduction(levelDb, { thresholdDb, ratio, kneeDb }) {
    const over = levelDb - thresholdDb;
    if (kneeDb <= 0) return over > 0 ? -over * (1 - 1 / ratio) : 0;
    if (over <= -kneeDb / 2) return 0;
    if (over >= kneeDb / 2) return -over * (1 - 1 / ratio);
    const x = over + kneeDb / 2;
    return -((1 - 1 / ratio) * x * x) / (2 * kneeDb);
  }

  /**
   * Обрабатывает стерео-блок.
   * @param {Float32Array|Float64Array} left
   * @param {Float32Array|Float64Array} right
   */
  process(left, right) {
    const n = Math.min(left.length, right.length);
    const outL = new Float64Array(n);
    const outR = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      const levelDb = toDb(peak);

      if (levelDb === -Infinity) {
        // Тишина: огибающая сбрасывается в ноль. Без этой ветки на старте
        // (−Infinity − −Infinity = NaN) огибающая уходила в NaN и весь
        // выход становился NaN — то есть тишина в начале файла убивала звук.
        this.envelopeDb = -Infinity;
        this.grDb = 0;
      } else {
        // Пиковый детектор: мгновенная атака, медленный возврат.
        if (this.envelopeDb === -Infinity || levelDb > this.envelopeDb) {
          this.envelopeDb = levelDb;
        } else {
          this.envelopeDb = levelDb + (this.envelopeDb - levelDb) * this.releaseCoef;
        }

        const target = GlueCompressor.targetReduction(this.envelopeDb, this);
        const coef = target < this.grDb ? this.attackCoef : this.releaseCoef;
        this.grDb = target + (this.grDb - target) * coef;
      }

      const gain = toLin(this.grDb + this.makeupDb);
      outL[i] = left[i] * gain;
      outR[i] = right[i] * gain;
    }
    return [outL, outR];
  }
}
