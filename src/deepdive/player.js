// A/B-плеер режима «Разбор»: оригинал ⇄ двойник.
//
// Ключевое требование — сравнение на равной громкости. Поэтому громкость
// оригинала измеряется в браузере (BS.1770, src/audio/dsp/loudness.js), а
// громкость двойника берётся из метрик рендера; разница превращается в
// коэффициент gain, чтобы оба источника звучали на одном уровне.
//
// Если LUFS двойника неизвестны, уровень не выравнивается «на глаз»:
// в интерфейс выводится честная пометка об оценке по измерениям оригинала.
import { measureLoudness } from '../audio/dsp/loudness.js';

export function createAbPlayer({ onState } = {}) {
  let ctx = null;
  let originalBuffer = null;
  let twinBuffer = null;
  let twinUrl = null;
  let node = null;
  let gainNode = null;
  let source = 'original'; // что выбрано сейчас: original | twin
  let playing = false;
  let startedAt = 0; // ctx.currentTime в момент старта
  let offset = 0; // позиция в буфере на момент старта, с
  let originalLufs = null;
  let twinLufs = null;
  let twinLufsEstimated = false; // LUFS двойника взяты из измерений оригинала
  let originalGain = 1;
  let twinGain = 1;

  function ensureContext() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('В этом браузере нет Web Audio API');
      ctx = new Ctor();
    }
    return ctx;
  }

  function bufferOf(which) {
    return which === 'twin' ? twinBuffer : originalBuffer;
  }

  function state() {
    return {
      source,
      playing,
      hasOriginal: Boolean(originalBuffer),
      hasTwin: Boolean(twinBuffer),
      originalLufs,
      twinLufs,
      twinLufsEstimated,
      originalGain,
      twinGain,
      position: position(),
      duration: duration(),
    };
  }

  function notify() {
    onState?.(state());
  }

  function position() {
    if (!playing || !ctx) return offset;
    return offset + (ctx.currentTime - startedAt);
  }

  function duration() {
    const buffer = bufferOf(source);
    return buffer ? buffer.duration : 0;
  }

  // Загружает оригинал: декодирование файла и измерение его громкости.
  async function setOriginalFile(file) {
    const data = await file.arrayBuffer();
    const c = ensureContext();
    originalBuffer = await c.decodeAudioData(data);
    originalLufs = null;
    // Отдаём кадр браузеру: декодирование тяжёлое, интерфейс не должен висеть.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const channels = Array.from({ length: originalBuffer.numberOfChannels }, (_, i) =>
        originalBuffer.getChannelData(i),
      );
      const measured = measureLoudness(channels, originalBuffer.sampleRate);
      originalLufs = Number.isFinite(measured.lufsI) ? measured.lufsI : null;
    } catch {
      originalLufs = null; // без измерения честно говорим «не измерено»
    }
    applyGains();
    notify();
  }

  // Загружает двойника: WAV из рендера сервера. LUFS приходит из метрик.
  async function setTwin(url, { lufs = null, lufsEstimated = false } = {}) {
    twinUrl = url;
    twinLufs = Number.isFinite(Number(lufs)) ? Number(lufs) : null;
    twinLufsEstimated = Boolean(lufsEstimated);
    twinBuffer = null;
    if (!url) {
      applyGains();
      notify();
      return;
    }
    const res = await fetch(url);
    if (!res.ok) {
      twinBuffer = null;
      applyGains();
      notify();
      return;
    }
    const data = await res.arrayBuffer();
    const c = ensureContext();
    twinBuffer = await c.decodeAudioData(data);
    applyGains();
    notify();
  }

  // Выравнивание по LUFS: оба источника приводятся к уровню оригинала.
  function applyGains() {
    const target = originalLufs ?? twinLufs;
    if (target === null || target === undefined) {
      originalGain = 1;
      twinGain = 1;
      return;
    }
    originalGain = originalLufs !== null ? 10 ** ((target - originalLufs) / 20) : 1;
    twinGain = twinLufs !== null ? 10 ** ((target - twinLufs) / 20) : 1;
  }

  function stopNode() {
    if (node) {
      try {
        node.stop();
      } catch {
        // уже остановлен — не страшно
      }
      node.disconnect();
      node = null;
    }
    if (gainNode) {
      gainNode.disconnect();
      gainNode = null;
    }
  }

  function startAt(pos) {
    const c = ensureContext();
    const buffer = bufferOf(source);
    if (!buffer) return;
    stopNode();
    const node2 = c.createBufferSource();
    node2.buffer = buffer;
    const g = c.createGain();
    g.gain.value = source === 'twin' ? twinGain : originalGain;
    node2.connect(g).connect(c.destination);
    const start = Math.max(0, Math.min(pos, Math.max(0, buffer.duration - 0.01)));
    node2.start(0, start);
    node = node2;
    gainNode = g;
    startedAt = c.currentTime;
    offset = start;
    playing = true;
    node2.onended = () => {
      // Событие старого источника приходит уже после переключения — игнорируем его,
      // иначе переключение «Оригинал ⇄ Двойник» сбрасывало бы позицию.
      if (node !== node2) return;
      playing = false;
      offset = 0;
      notify();
    };
  }

  async function play() {
    if (playing) return;
    const buffer = bufferOf(source);
    if (!buffer) return;
    const c = ensureContext();
    if (c.state === 'suspended') await c.resume();
    startAt(offset);
    notify();
  }

  function stop() {
    if (!playing) return;
    offset = position();
    stopNode();
    playing = false;
    notify();
  }

  function togglePlay() {
    if (playing) stop();
    else play().catch(() => {});
  }

  // Переключение источника. Если играет — переносим позицию на другой источник,
  // чтобы сравнение шло по одному и тому же месту трека.
  function toggleSource() {
    const next = source === 'original' ? 'twin' : 'original';
    if (!bufferOf(next)) return next; // переключаться не на что
    if (playing) {
      const pos = position();
      source = next;
      startAt(pos);
    } else {
      source = next;
      offset = 0;
    }
    notify();
    return source;
  }

  return {
    setOriginalFile,
    setTwin,
    play,
    stop,
    togglePlay,
    toggleSource,
    state,
    get twinUrl() {
      return twinUrl;
    },
  };
}
