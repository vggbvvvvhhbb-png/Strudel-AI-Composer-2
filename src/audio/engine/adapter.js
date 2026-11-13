// EngineAdapter — единственная точка, где студия касается движка.
//
// Контракт (§5 промта):
//   init(ctx, destNode) · loadSamples(manifest) · evaluate(code, plan) ·
//   start() · stop() · setTempo(bpm) · position() · outputNode() ·
//   renderOffline({fromBar,toBar,sampleRate,plan}) · dispose()
//
// Важно: движок — гость. Контекст, шина и мастер принадлежат студии
// (src/audio/graph.js), а адаптер только отдаёт хвост сигнала.
//
// Точка врезки в мастер-шину — экспортный хук H1 (см. docs/SPIKE-AUDIO.md):
// `getSuperdoughAudioController().output.destinationGain` — GainNode между
// channelMerger и ctx.destination. Перехват `connect` не нужен.

const DEFAULT_MAX_POLYPHONY = 64;

/**
 * @param {object} strudel модуль @strudel/web
 * @param {{maxPolyphony?:number, onEvalError?:Function}} [options]
 */
export function createEngineAdapter(strudel, { maxPolyphony = DEFAULT_MAX_POLYPHONY, onEvalError } = {}) {
  let context = null;
  let repl = null;
  let tail = null;
  let controller = null;
  let lastError = null;
  let tempoBpm = 120;

  async function ensureController() {
    controller = strudel.getSuperdoughAudioController?.() ?? null;
    if (!controller) {
      // Контроллер superdough создаётся при инициализации аудио. Если движок
      // не создал его сам (разные версии @strudel/web), инициализируем явно.
      await strudel.initAudio({ maxPolyphony });
      controller = strudel.getSuperdoughAudioController?.() ?? null;
    }
    tail = controller?.output?.destinationGain ?? null;
    return tail;
  }

  const adapter = {
    /** Инициализация на контексте студии. */
    async init(ctx) {
      context = ctx;
      repl = await strudel.initStrudel({
        audioContext: ctx,
        maxPolyphony,
        onEvalError: (err) => {
          lastError = err;
          if (onEvalError) onEvalError(err);
        },
      });
      await ensureController();
      return adapter;
    },

    /** Хвост сигнала движка — его и врезаем в мастер-шину. */
    outputNode() {
      return tail;
    },

    /**
     * Врезает хвост движка в мастер-шину студии.
     * @param {AudioNode} masterIn
     */
    attachMaster(masterIn) {
      if (!tail) throw new Error('Движок не инициализирован: нет хвоста сигнала');
      try {
        tail.disconnect();
      } catch {
        /* хвост мог ещё ни к чему не подключён */
      }
      tail.connect(masterIn);
      return adapter;
    },

    /** Загружает банки сэмплов. */
    async loadSamples(manifest = []) {
      const sources = Array.isArray(manifest) ? manifest : manifest?.sources ?? [];
      const results = await Promise.allSettled(sources.map((src) => strudel.samples(src)));
      const failed = results.filter((r) => r.status === 'rejected');
      return {
        ok: failed.length < results.length,
        total: results.length,
        failed: failed.length,
        errors: failed.map((f) => String(f.reason?.message || f.reason)),
      };
    },

    /** Исполняет код паттерна. */
    async evaluate(code, plan) {
      lastError = null;
      try {
        const result = repl ? await repl.evaluate(code, true) : await strudel.evaluate(code);
        if (lastError) throw lastError?.error || lastError;
        return { ok: true, result, plan };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },

    /** Запуск/остановка воспроизведения. */
    start() {
      repl?.start?.();
      return adapter;
    },

    stop() {
      repl?.stop?.();
      return adapter;
    },

    /** Темп. В Strudel cps = bpm/4 (D-010). */
    setTempo(bpm) {
      tempoBpm = Number(bpm) || tempoBpm;
      return adapter;
    },

    get tempo() {
      return tempoBpm;
    },

    /**
     * Позиция воспроизведения.
     * scheduler.now() отдаёт ЦИКЛЫ, а не секунды (H5): в секунды переводим
     * делением на cps.
     */
    position() {
      const scheduler = repl?.scheduler;
      const cycles = scheduler?.now?.() ?? 0;
      const cps = scheduler?.cps ?? 0.5;
      return {
        cycles,
        seconds: cps ? cycles / cps : 0,
        cps,
        bpm: tempoBpm,
      };
    },

    /**
     * Офлайн-рендер в отдельном OfflineAudioContext.
     * Схема вызова события — из кода движка (см. docs/SPIKE-AUDIO.md, H3):
     * официальный renderPatternAudio закрывает живой контекст, поэтому своя
     * реализация.
     *
     * @param {{pattern:object, fromCycle:number, toCycle:number, sampleRate:number, cps:number}} options
   * @returns {Promise<AudioBuffer>}
     */
    async renderOffline({ pattern, fromCycle = 0, toCycle = 4, sampleRate = 44100, cps = 0.5 } = {}) {
      const seconds = (toCycle - fromCycle) / cps;
      const offline = new OfflineAudioContext(2, Math.round(sampleRate * seconds), sampleRate);

      // Порядок важен: сперва чистим контроллер, потом ставим контекст,
      // иначе контроллер останется привязан к предыдущему AudioContext.
      strudel.setSuperdoughAudioController?.(null);
      strudel.setAudioContext?.(offline);
      strudel.registerSynthSounds?.();
      await strudel.initAudio({ maxPolyphony });

      const haps = pattern
        .queryArc(fromCycle, toCycle, { _cps: cps })
        .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

      for (const hap of haps) {
        if (!hap.hasOnset()) continue;
        const begin = (hap.whole.begin.valueOf() - fromCycle) / cps;
        const dur = hap.duration / cps;
        if (typeof hap.ensureObjectValue === 'function') hap.ensureObjectValue();
        await strudel.superdough(hap.value, begin, dur, cps, begin);
      }

      const buffer = await offline.startRendering();
      // Возвращаем живой контекст на место.
      strudel.setAudioContext?.(context);
      strudel.setSuperdoughAudioController?.(null);
      if (context) await strudel.initAudio({ maxPolyphony });
      return buffer;
    },

    dispose() {
      try {
        repl?.stop?.();
      } catch {
        /* уже остановлен */
      }
      repl = null;
      tail = null;
      controller = null;
    },
  };

  return adapter;
}
