// Lookahead-лимитер с гарантированным потолком.
//
// Механизм: вход пишется в линию задержки длиной L (lookahead). Для каждого
// выходного отсчёта m известен максимум |x| на отрезке [m, m+L] — то есть пик
// виден заранее. Требуемое ослабление вычисляется заранее и применяется
// до прихода пика, поэтому потолок не пробивается, а искажений меньше, чем у
// DynamicsCompressorNode (у него нет предпрослушивания — H9).
//
// Стереосвязанный: пик ищется по максимуму каналов, изображение не разъезжается.

export class LookaheadLimiter {
  constructor(sampleRate, { ceilingDb = -1, lookaheadMs = 5, releaseMs = 80, attackMs = 0.5 } = {}) {
    this.sampleRate = sampleRate;
    this.ceiling = Math.pow(10, ceilingDb / 20);
    this.lookaheadSamples = Math.max(1, Math.round((lookaheadMs * sampleRate) / 1000));
    this.releaseCoef = Math.exp(-1 / Math.max(1, (releaseMs * sampleRate) / 1000));
    this.attackCoef = Math.exp(-1 / Math.max(1, (attackMs * sampleRate) / 1000));
    this.bufferLength = this.lookaheadSamples + 1;
    this.reset();
  }

  reset() {
    this.bufL = new Float64Array(this.bufferLength);
    this.bufR = new Float64Array(this.bufferLength);
    this.writeIndex = 0;
    this.sampleIndex = 0;
    this.gain = 1;
    this.maxQueue = [];
    this.grDb = 0;
    return this;
  }

  /** Задержка конвейера в отсчётах — её компенсирует транспорт. */
  get latencySamples() {
    return this.lookaheadSamples;
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
    const bufL = this.bufL;
    const bufR = this.bufR;
    const len = this.bufferLength;
    const L = this.lookaheadSamples;

    for (let i = 0; i < n; i += 1) {
      const w = this.writeIndex;
      bufL[w] = left[i];
      bufR[w] = right[i];

      const abs = this.sampleIndex;
      const peak = Math.max(Math.abs(bufL[w]), Math.abs(bufR[w]));
      this.pushMax(abs, peak);

      // Выходной отсчёт задержан на L: абсолютный индекс abs - L.
      const outSlot = ((abs - L) % len + len) % len;
      const delayedL = bufL[outSlot];
      const delayedR = bufR[outSlot];

      // Пик на отрезке [abs-L, abs] — тот, что определит громкость выходного отсчёта.
      const windowPeak = this.maxQueue.length ? this.maxQueue[0].value : peak;
      const instantGain = windowPeak > this.ceiling ? this.ceiling / windowPeak : 1;
      const target = Math.min(1, instantGain);

      // Сглаживание: быстрое срабатывание, медленный возврат.
      const coef = target < this.gain ? this.attackCoef : this.releaseCoef;
      this.gain = target + (this.gain - target) * coef;
      // Потолок гарантирован: применяем не более гладкого значения.
      const applied = Math.min(this.gain, target);
      this.grDb = applied < 1 ? 20 * Math.log10(applied) : 0;

      outL[i] = delayedL * applied;
      outR[i] = delayedR * applied;

      this.writeIndex = (w + 1) % len;
      this.sampleIndex += 1;
    }
    return [outL, outR];
  }

  /** Монотонная очередь максимума скользящего окна (индексы — абсолютные). */
  pushMax(index, value) {
    const queue = this.maxQueue;
    while (queue.length && queue[queue.length - 1].value <= value) queue.pop();
    queue.push({ index, value });
    const oldest = index - this.lookaheadSamples;
    while (queue.length && queue[0].index < oldest) queue.shift();
  }
}
