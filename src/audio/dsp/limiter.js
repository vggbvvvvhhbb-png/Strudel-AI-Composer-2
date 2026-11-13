// Lookahead-лимитер с гарантированным потолком.
//
// Механизм: вход пишется в линию задержки длиной L (lookahead). Для каждого
// выходного отсчёта m известен максимум |x| на отрезке [m, m+L] — то есть пик
// виден заранее. Требуемое ослабление вычисляется заранее и применяется
// до прихода пика, поэтому потолок не пробивается, а искажений меньше, чем у
// DynamicsCompressorNode (у него нет предпрослушивания — H9).
//
// Стереосвязанный: пик ищется по максимуму каналов, изображение не разъезжается.
//
// В аудиопотоке (AudioWorklet) process() не имеет права выделять память:
// поэтому выходные буферы можно передать снаружи, а очередь максимумов
// хранится в типизированных массивах, а не в массиве объектов.

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
    // Монотонная очередь максимума: значения и индексы в кольцевых массивах.
    this.queueCapacity = this.lookaheadSamples + 8;
    this.queueValues = new Float64Array(this.queueCapacity);
    this.queueIndices = new Float64Array(this.queueCapacity);
    this.queueHead = 0;
    this.queueTail = 0;
    this.grDb = 0;
    return this;
  }

  /** Задержка конвейера в отсчётах — её компенсирует транспорт. */
  get latencySamples() {
    return this.lookaheadSamples;
  }

  /**
   * Обрабатывает стерео-блок.
   *
   * Если outL/outR переданы, результат пишется в них (без аллокаций) —
   * так вызывается мастер-worklet. Если не переданы, возвращаются новые
   * массивы — так вызывают Node-тесты.
   *
   * @param {Float32Array|Float64Array} left
   * @param {Float32Array|Float64Array} right
   * @param {Float32Array|Float64Array} [outL]
   * @param {Float32Array|Float64Array} [outR]
   * @returns {[Float64Array, Float64Array]}
   */
  process(left, right, outL, outR) {
    const n = Math.min(left.length, right.length);
    const resL = outL ?? new Float64Array(n);
    const resR = outR ?? new Float64Array(n);
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
      const outSlot = (((abs - L) % len) + len) % len;
      const delayedL = bufL[outSlot];
      const delayedR = bufR[outSlot];

      // Пик на отрезке [abs-L, abs] — тот, что определит громкость выходного отсчёта.
      const windowPeak = this.queueHead !== this.queueTail ? this.queueValues[this.queueHead] : peak;
      const instantGain = windowPeak > this.ceiling ? this.ceiling / windowPeak : 1;
      const target = Math.min(1, instantGain);

      // Сглаживание: быстрое срабатывание, медленный возврат.
      const coef = target < this.gain ? this.attackCoef : this.releaseCoef;
      this.gain = target + (this.gain - target) * coef;
      // Потолок гарантирован: применяем не более гладкого значения.
      const applied = Math.min(this.gain, target);
      this.grDb = applied < 1 ? 20 * Math.log10(applied) : 0;

      resL[i] = delayedL * applied;
      resR[i] = delayedR * applied;

      this.writeIndex = (w + 1) % len;
      this.sampleIndex += 1;
    }
    return [resL, resR];
  }

  /**
   * Монотонная очередь максимума скользящего окна (индексы — абсолютные).
   * Хранится в кольцевых типизированных массивах: ни одной аллокации на отсчёт.
   */
  pushMax(index, value) {
    const values = this.queueValues;
    const indices = this.queueIndices;
    const capacity = this.queueCapacity;

    // Хвост: убираем всё, что не больше нового значения.
    while (this.queueTail !== this.queueHead) {
      const prev = (this.queueTail - 1 + capacity) % capacity;
      if (values[prev] <= value) this.queueTail = prev;
      else break;
    }

    if ((this.queueTail + 1) % capacity === this.queueHead) {
      // Переполнение невозможно при корректном окне, но лучше потерять старый
      // элемент, чем писать за границу.
      this.queueHead = (this.queueHead + 1) % capacity;
    }
    values[this.queueTail] = value;
    indices[this.queueTail] = index;
    this.queueTail = (this.queueTail + 1) % capacity;

    // Голова: выкидываем всё, что старше окна.
    const oldest = index - this.lookaheadSamples;
    while (this.queueHead !== this.queueTail && indices[this.queueHead] < oldest) {
      this.queueHead = (this.queueHead + 1) % capacity;
    }
  }
}
