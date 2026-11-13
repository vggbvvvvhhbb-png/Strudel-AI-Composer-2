// Аудиограф студии: контекст, мастер-шина, метры.
//
// Ключевое решение (§5 промта): граф принадлежит студии, а не движку.
// Контекст, шина, мастер и метры живут здесь; движок — гость, который
// подключается к `masterIn` и отдаёт свой хвост.
//
// Схема:
//
//   движок (superdough) ──► masterIn ──► [worklet: EQ→glue→лимитер→метры] ──► destination
//                                   │
//                                   └── (bypass реализован внутри worklet,
//                                        сухая ветка задержена так же, как мастер)
//
// Bypass сделан внутри worklet, а не отдельными нативными узлами: у
// AudioWorkletNode есть собственная задержка в один рендер-квант (128
// отсчётов), и сухая ветка на DelayNode отстала бы от обработанной ровно на
// квант — A/B разъезжался бы по времени. Внутри worklet обе ветки проходят
// один конвейер, поэтому выравнивание точное по построению.

const DEFAULT_WORKLET_URL = '/worklets/master-processor.js';
const METRICS_INTERVAL_MS = 100;

export class StudioGraph {
  /**
   * @param {AudioContext} context
   * @param {{workletUrl?:string, masterParams?:object}} [options]
   */
  constructor(context, { workletUrl = DEFAULT_WORKLET_URL, masterParams = {} } = {}) {
    this.context = context;
    this.workletUrl = workletUrl;
    this.masterParams = masterParams;
    this.masterIn = null;
    this.masterNode = null;
    this.meters = null;
    this.latencySamples = 0;
    this.ready = false;
    this.listeners = new Set();
    this.disposed = false;
  }

  /**
   * Поднимает граф: грузит модуль worklet и строит шину.
   * @returns {Promise<StudioGraph>}
   */
  async init() {
    const ctx = this.context;
    if (!ctx.audioWorklet) {
      throw new Error('Браузер не поддерживает AudioWorklet — мастер-цепочка невозможна');
    }
    await ctx.audioWorklet.addModule(this.workletUrl);

    this.masterIn = new GainNode(ctx, { gain: 1 });
    this.masterNode = new AudioWorkletNode(ctx, 'master-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { master: this.masterParams },
    });

    this.masterNode.port.onmessage = (event) => this.handleMessage(event.data);
    this.masterIn.connect(this.masterNode);
    this.masterNode.connect(ctx.destination);

    // Worklet сообщает задержку конвейера сразу после создания.
    await new Promise((resolve) => {
      this.resolveReady = resolve;
      // Страховка: если worklet не ответил за 2 с, считаем задержку нулевой.
      this.readyTimer = setTimeout(() => {
        if (!this.ready) {
          this.ready = true;
          resolve();
        }
      }, 2000);
    });

    return this;
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      this.latencySamples = message.latencySamples || 0;
      this.sampleRate = message.sampleRate;
      this.ready = true;
      if (this.resolveReady) {
        clearTimeout(this.readyTimer);
        this.resolveReady();
        this.resolveReady = null;
      }
      return;
    }
    if (message.type === 'metrics') {
      this.meters = message.meters;
      for (const listener of this.listeners) listener(message.meters);
    }
  }

  /** Подписка на метры (10 Гц). Возвращает функцию отписки. */
  onMetrics(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Задержка мастер-цепочки в секундах (для компенсации в транспорте). */
  get latencySeconds() {
    return this.latencySamples / (this.context?.sampleRate || 48000);
  }

  /**
   * Суммарная задержка пути «источник → ухо»: базовая + выходная + мастер.
   * Плейхед: heardTime = ctx.currentTime − (baseLatency + outputLatency + masterLatency).
   */
  get totalLatencySeconds() {
    const ctx = this.context;
    const base = ctx?.baseLatency || 0;
    const output = ctx?.outputLatency || 0;
    return base + output + this.latencySeconds;
  }

  /** Bypass: сухой сигнал вместо обработанного. Переход — 25 мс, без щелчков. */
  setBypass(on) {
    this.masterNode?.port.postMessage({ type: 'bypass', on: Boolean(on) });
    return this;
  }

  /** Обновление параметров мастера (EQ, компрессор, потолок). */
  setMasterParams(params) {
    this.masterParams = { ...this.masterParams, ...params };
    this.masterNode?.port.postMessage({ type: 'params', params });
    return this;
  }

  resetMeters() {
    this.masterNode?.port.postMessage({ type: 'reset' });
  }

  /** Подключает выход узла (хвост движка) к мастер-шине. */
  connectSource(node) {
    node.connect(this.masterIn);
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.masterNode?.port.postMessage({ type: 'stop' });
      this.masterIn?.disconnect();
      this.masterNode?.disconnect();
    } catch {
      /* узлы уже могли быть отключены */
    }
    this.listeners.clear();
  }
}

/**
 * Поднимает граф на существующем или новом контексте.
 * @param {{context?:AudioContext, workletUrl?:string, masterParams?:object}} [options]
 * @returns {Promise<{graph:StudioGraph, context:AudioContext}>}
 */
export async function createStudioGraph({ context, workletUrl, masterParams } = {}) {
  const ctx = context ?? new AudioContext({ latencyHint: 'interactive' });
  const graph = new StudioGraph(ctx, { workletUrl, masterParams });
  await graph.init();
  return { graph, context: ctx };
}
