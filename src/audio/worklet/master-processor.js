// Мастер-worklet: EQ → glue → lookahead-лимитер → метры.
//
// Worklet — единственное место, где мастер-цепочка работает в реалтайме.
// DSP берётся из того же ядра, что и в офлайн-рендерере и в тестах, поэтому
// метрики реалтайма и метрики CI считаются одним кодом.
//
// Ограничения аудиопотока, которые здесь соблюдаются:
//   - в process() нет выделений памяти: все буферы созданы заранее;
//   - метры уходят в порт 10 раз в секунду (не чаще — порт не должен быть
//     узким местом);
//   - никаких исключений в process(): сбой метров не должен рвать звук.

import { MasterChain } from '../dsp/master.js';

const METRICS_INTERVAL_SEC = 0.1; // 10 Гц

class MasterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const params = options?.processorOptions?.master ?? {};
    this.chain = new MasterChain(sampleRate, params);
    this.samplesSincePost = 0;
    this.samplesPerPost = Math.max(1, Math.round(sampleRate * METRICS_INTERVAL_SEC));
    this.alive = true;

    this.port.onmessage = (event) => this.handleMessage(event.data);

    // Задержку конвейера сообщаем сразу: граф на её основании строит
    // dry-путь для Bypass (иначе A/B разъедутся по времени).
    this.port.postMessage({
      type: 'ready',
      latencySamples: this.chain.latencySamples,
      sampleRate,
    });
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'params':
        this.chain.setParams(message.params || {});
        break;
      case 'bypass':
        this.chain.setBypass(Boolean(message.on));
        break;
      case 'reset':
        this.chain.reset();
        break;
      case 'stop':
        this.alive = false;
        break;
      default:
        break;
    }
  }

  process(inputs, outputs) {
    const output = outputs?.[0];
    if (!output || output.length === 0) return this.alive;

    const input = inputs?.[0];
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];

    const left = input?.[0];
    if (!left) {
      // Нет входа — тишина, но цепочка всё равно «проходит» время, чтобы
      // задержка лимитера и состояние метров совпадали с реалтаймом.
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      this.postMetrics(outL);
      return this.alive;
    }
    const right = input.length > 1 ? input[1] : left;

    this.chain.process(left, right, outL, outR);
    this.postMetrics(outL);
    return this.alive;
  }

  postMetrics(outL) {
    this.samplesSincePost += outL.length;
    if (this.samplesSincePost < this.samplesPerPost) return;
    this.samplesSincePost = 0;
    const meters = this.chain.snapshot();
    this.port.postMessage({ type: 'metrics', meters });
  }
}

registerProcessor('master-processor', MasterProcessor);
