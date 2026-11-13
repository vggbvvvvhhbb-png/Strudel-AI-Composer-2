// Мастер-цепочка студии как чистое DSP-ядро.
//
// Один и тот же код исполняется:
//   - в мастер-worklet (реалтайм, src/audio/worklet/master-processor.js);
//   - в офлайн-рендерере (метрики и A/B);
//   - в Node-тестах и в сверке с ffmpeg.
//
// Поэтому здесь нет ни DOM, ни Web Audio: только чистые ES-модули.
// Следствие: метрики QA считаются тем же кодом, что звучит в реалтайме, —
// дрейф невозможен, а расхождение видно тестом, а не на слух.
//
// Порядок обработки (стендия по §5 промта):
//   low-shelf → high-shelf → glue-компрессор → lookahead-лимитер → метры.
//
// Задержка конвейера — это задержка лимитера (lookahead). Её компенсирует
// транспорт: heardTime = ctx.currentTime − (baseLatency + outputLatency + latency).

import { Biquad } from './biquad.js';
import { GlueCompressor } from './comp.js';
import { LoudnessMeter } from './loudness-stream.js';
import { LookaheadLimiter } from './limiter.js';
import { TruePeakOversampler } from './truepeak.js';

/** Параметры по умолчанию: нейтральный EQ, мягкий glue, потолок −1 dBTP. */
export const DEFAULT_MASTER = {
  ceilingDb: -1,
  lookaheadMs: 5,
  limiterReleaseMs: 80,
  comp: {
    thresholdDb: -20,
    ratio: 3,
    kneeDb: 6,
    attackMs: 20,
    releaseMs: 200,
    makeupDb: 0,
  },
  eq: {
    lowShelfHz: 120,
    lowShelfDb: 0,
    highShelfHz: 8000,
    highShelfDb: 0,
  },
  measureTruePeak: true,
};

export class MasterChain {
  /**
   * @param {number} sampleRate
   * @param {Partial<typeof DEFAULT_MASTER>} [options]
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.params = {
      ...DEFAULT_MASTER,
      ...options,
      comp: { ...DEFAULT_MASTER.comp, ...(options.comp || {}) },
      eq: { ...DEFAULT_MASTER.eq, ...(options.eq || {}) },
    };

    const { eq } = this.params;
    this.lowShelf = new Biquad('lowshelf', {
      freq: eq.lowShelfHz,
      sr: sampleRate,
      gainDb: eq.lowShelfDb,
      Q: 0.7071067811865476,
    });
    this.highShelf = new Biquad('highshelf', {
      freq: eq.highShelfHz,
      sr: sampleRate,
      gainDb: eq.highShelfDb,
      Q: 0.7071067811865476,
    });

    this.comp = new GlueCompressor(sampleRate, this.params.comp);
    this.limiter = new LookaheadLimiter(sampleRate, {
      ceilingDb: this.params.ceilingDb,
      lookaheadMs: this.params.lookaheadMs,
      releaseMs: this.params.limiterReleaseMs,
    });
    this.meter = new LoudnessMeter(sampleRate);
    this.truePeakL = new TruePeakOversampler(sampleRate);
    this.truePeakR = new TruePeakOversampler(sampleRate);
    this.truePeak = 0;

    // Dry-ветка (Bypass): копия входа, задержанная на ту же величину, что и
    // мастер-цепочка. Задержка реализована внутри worklet, а не отдельным
    // DelayNode в графе: у AudioWorkletNode есть собственный задержка в один
    // рендер-квант (128 отсчётов), и сухая ветка на нативных узлах отставала
    // бы от обработанной ровно на квант — A/B разъезжался бы по времени.
    // Здесь обе ветки проходят один и тот же конвейер, поэтому выравнивание
    // точное по построению, а не «подобрано».
    this.dryDelayL = new Float64Array(Math.max(1, this.limiter.lookaheadSamples));
    this.dryDelayR = new Float64Array(Math.max(1, this.limiter.lookaheadSamples));
    this.dryIndex = 0;

    // Кроссфейд Bypass: фаза 0 = мастер, 1 = сухой сигнал.
    // Равенство мощностей: cos²+sin² = 1, поэтому на переходе громкость не
    // проваливается и щелчка не слышно.
    this.bypassPhase = 0;
    this.bypassTarget = 0;
    this.crossfadeSamples = Math.max(1, Math.round((25 * sampleRate) / 1000));

    this.procL = new Float64Array(0);
    this.procR = new Float64Array(0);
    this.dryL = new Float64Array(0);
    this.dryR = new Float64Array(0);
  }

  /** Задержка конвейера в отсчётах — её компенсирует транспорт. */
  get latencySamples() {
    return this.limiter.latencySamples;
  }

  reset() {
    this.lowShelf.reset();
    this.highShelf.reset();
    this.comp.reset();
    this.limiter.reset();
    this.meter.reset();
    this.truePeakL.reset();
    this.truePeakR.reset();
    this.truePeak = 0;
    this.dryDelayL.fill(0);
    this.dryDelayR.fill(0);
    this.dryIndex = 0;
    this.bypassPhase = this.bypassTarget;
    return this;
  }

  /**
   * Включает/выключает Bypass. Переход — равномощностный кроссфейд 25 мс,
   * выполняемый по отсчётам внутри цепочки (без щелчков).
   * @param {boolean} on
   */
  setBypass(on) {
    this.bypassTarget = on ? 1 : 0;
    return this;
  }

  /** Текущее положение кроссфейда: 0 — мастер, 1 — сухой сигнал. */
  get bypassPosition() {
    return this.bypassPhase;
  }

  /** Обновляет параметры на ходу (EQ, компрессор, потолок лимитера). */
  setParams(patch = {}) {
    const next = {
      ...this.params,
      ...patch,
      comp: { ...this.params.comp, ...(patch.comp || {}) },
      eq: { ...this.params.eq, ...(patch.eq || {}) },
    };
    this.params = next;

    if (patch.eq) {
      this.lowShelf.set('lowshelf', {
        freq: next.eq.lowShelfHz,
        sr: this.sampleRate,
        gainDb: next.eq.lowShelfDb,
        Q: 0.7071067811865476,
      });
      this.highShelf.set('highshelf', {
        freq: next.eq.highShelfHz,
        sr: this.sampleRate,
        gainDb: next.eq.highShelfDb,
        Q: 0.7071067811865476,
      });
    }
    if (patch.comp) {
      this.comp = new GlueCompressor(this.sampleRate, next.comp);
    }
    if (patch.ceilingDb !== undefined || patch.lookaheadMs !== undefined || patch.limiterReleaseMs !== undefined) {
      this.limiter = new LookaheadLimiter(this.sampleRate, {
        ceilingDb: next.ceilingDb,
        lookaheadMs: next.lookaheadMs,
        releaseMs: next.limiterReleaseMs,
      });
    }
    return this;
  }

  /**
   * Обрабатывает стерео-блок.
   *
   * Если outL/outR переданы, результат пишется в них — без аллокаций
   * (так вызывается worklet). Иначе возвращаются новые массивы.
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
    if (this.procL.length < n) {
      this.procL = new Float64Array(n);
      this.procR = new Float64Array(n);
      this.dryL = new Float64Array(n);
      this.dryR = new Float64Array(n);
    }
    const procL = this.procL;
    const procR = this.procR;
    const dryL = this.dryL;
    const dryR = this.dryR;

    // 1. EQ: полочные фильтры, работают на месте.
    for (let i = 0; i < n; i += 1) {
      procL[i] = left[i];
      procR[i] = right[i];
    }
    this.lowShelf.processBlock(procL, procL);
    this.highShelf.processBlock(procL, procL);
    this.lowShelf.processBlock(procR, procR);
    this.highShelf.processBlock(procR, procR);

    // 2. Glue-компрессор.
    this.comp.process(procL, procR, procL, procR);

    // 3. Lookahead-лимитер: потолок гарантирован, выход задержан на lookahead.
    this.limiter.process(procL, procR, procL, procR);

    // 4. Сухая ветка: та же задержка, что и у мастера, — для честного A/B.
    const delayLen = this.dryDelayL.length;
    let dryIndex = this.dryIndex;
    for (let i = 0; i < n; i += 1) {
      dryL[i] = this.dryDelayL[dryIndex];
      dryR[i] = this.dryDelayR[dryIndex];
      this.dryDelayL[dryIndex] = left[i];
      this.dryDelayR[dryIndex] = right[i];
      dryIndex = (dryIndex + 1) % delayLen;
    }
    this.dryIndex = dryIndex;

    // 5. Кроссфейд мастер ↔ сухой сигнал (равная мощность, 25 мс).
    const step = 1 / this.crossfadeSamples;
    const target = this.bypassTarget;
    let phase = this.bypassPhase;
    for (let i = 0; i < n; i += 1) {
      if (phase !== target) {
        const diff = target - phase;
        phase += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
      }
      const angle = phase * (Math.PI / 2);
      const masterGain = Math.cos(angle);
      const dryGain = Math.sin(angle);
      resL[i] = procL[i] * masterGain + dryL[i] * dryGain;
      resR[i] = procR[i] * masterGain + dryR[i] * dryGain;
    }
    this.bypassPhase = phase;

    // 6. Метры по итоговому сигналу.
    this.meter.process(resL, resR);
    if (this.params.measureTruePeak) this.measureTruePeak(resL, resR, n);

    return [resL, resR];
  }

  measureTruePeak(left, right, n) {
    let peak = this.truePeak;
    for (let i = 0; i < n; i += 1) {
      const outL = this.truePeakL.processSample(left[i]);
      for (let p = 0; p < outL.length; p += 1) {
        const v = Math.abs(outL[p]);
        if (v > peak) peak = v;
      }
      const outR = this.truePeakR.processSample(right[i]);
      for (let p = 0; p < outR.length; p += 1) {
        const v = Math.abs(outR[p]);
        if (v > peak) peak = v;
      }
    }
    this.truePeak = peak;
  }

  /** Снимок метрик мастера. */
  snapshot() {
    const meters = this.meter.snapshot();
    return {
      ...meters,
      truePeakDb: this.truePeak > 0 ? 20 * Math.log10(this.truePeak) : -Infinity,
      compGrDb: this.comp.grDb,
      limiterGrDb: this.limiter.grDb,
      latencySamples: this.latencySamples,
    };
  }
}
