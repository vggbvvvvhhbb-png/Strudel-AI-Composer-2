// Запись мастер-выхода в WAV: перехват destination → AudioWorklet → 16-bit PCM.
//
// ДИНАМИЧЕСКИЙ ИМПОРТ. @strudel/web — это 627 КБ. Если импортировать его
// статически, он попадает в статический граф студии, и первый экран ждёт
// его загрузки. Здесь нужен всего один getAudioContext, и он нужен только
// в момент старта записи — поэтому импорт динамический.
import { encodeWav } from './wav.js';

export { encodeWav };

const MAX_SECONDS = 300; // лимит памяти при длинных записях
let state = null;

export function isRecording() {
  return Boolean(state?.active);
}

// Подменяем ctx.destination своей шиной: весь вывод Strudel идёт через неё,
// шина ведёт и в настоящий выход, и в рекордер. Восстанавливается при остановке.
async function attachTap(ctx) {
  const real = ctx.destination;
  const bus = ctx.createGain();
  let swapped = false;
  try {
    Object.defineProperty(ctx, 'destination', { value: bus, configurable: true });
    swapped = true;
  } catch {
    return null; // движок не позволил перехват — запись недоступна
  }
  bus.connect(real);
  return { bus, restore: () => { if (swapped) Object.defineProperty(ctx, 'destination', { value: real, configurable: true }); bus.disconnect(); } };
}

export async function startRecording({ bars = null, bpm = 120, name = 'track', onTick, onFinished } = {}) {
  if (isRecording()) return { ok: false, reason: 'Уже идёт запись' };
  const { getAudioContext } = await import('@strudel/web');
  const ctx = getAudioContext?.();
  if (!ctx || ctx.state !== 'running') return { ok: false, reason: 'Аудио не запущено' };
  const tap = await attachTap(ctx);
  if (!tap) return { ok: false, reason: 'Перехват звука недоступен в этом браузере' };
  try {
    await ctx.audioWorklet.addModule(new URL('/worklets/recorder-worklet.js', location.origin).href);
  } catch {
    tap.restore();
    return { ok: false, reason: 'AudioWorklet не поддерживается' };
  }
  const node = new AudioWorkletNode(ctx, 'rec-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
  const done = new Promise((resolve) => {
    node.port.onmessage = (e) => { if (e.data.done) resolve(e.data); };
  });
  tap.bus.connect(node);
  node.port.postMessage({ cmd: 'start' });

  const maxSec = bars ? Math.min(MAX_SECONDS, (bars * 4 * 60) / bpm) : MAX_SECONDS;
  const startedAt = performance.now();
  const timer = setInterval(() => onTick?.((performance.now() - startedAt) / 1000), 200);
  // Точная остановка по тактам (± миллисекунды) + скачивание результата.
  const hardStop = setTimeout(() => { stopRecording().then((r) => onFinished?.(r)); }, maxSec * 1000);

  state = { active: true, node, tap, timer, hardStop, done, name, sampleRate: ctx.sampleRate };
  return { ok: true };
}

// Останавливает запись и скачивает WAV. Возвращает {seconds, blob} или null.
export async function stopRecording() {
  if (!state) return null;
  const { node, tap, done, name, sampleRate, timer, hardStop } = state;
  state = null;
  clearInterval(timer);
  clearTimeout(hardStop);
  node.port.postMessage({ cmd: 'stop' });
  const data = await done;
  node.disconnect();
  tap.restore();
  state = null;

  const channels = data.channels.map((chunks) => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  });
  const seconds = data.frames / sampleRate;
  const blob = new Blob([encodeWav(channels, sampleRate)], { type: 'audio/wav' });
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `strudel-${name || 'track'}-${date}.wav`;
  a.click();
  URL.revokeObjectURL(a.href);
  return { seconds, blob };
}
