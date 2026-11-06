// Обёртка над @strudel/web: инициализация, исполнение кода, визуализация.
import { initStrudel, evaluate, hush, getAudioContext, Pattern, samples } from '@strudel/web';

let initialized = false;
let initPromise = null;
let visualRoot = null;
let drawSeq = 0;
let lastError = null;

// Каждый вызов .pianoroll()/.scope() получает свой canvas внутри контейнера.
// id сбрасывается на каждом evaluate, поэтому новые отрисовки отменяют старые циклы RAF.
function nextDrawTarget() {
  if (!visualRoot) return {};
  const canvas = document.createElement('canvas');
  canvas.className = 'strudel-view';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(280, (visualRoot.clientWidth || 480) - 20);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(190 * dpr);
  visualRoot.appendChild(canvas);
  return { ctx: canvas.getContext('2d', { willReadFrequently: true }), id: drawSeq++ };
}

// Перенаправляем встроенные визуализации Strudel в наш контейнер
// вместо полноэкранного canvas, который пакеты рисуют по умолчанию.
function patchVisuals() {
  for (const name of ['pianoroll', 'scope', 'fscope', 'spectrum']) {
    const orig = Pattern.prototype[name];
    if (typeof orig !== 'function') continue;
    Pattern.prototype[name] = function (opts = {}) {
      const { ctx, id } = nextDrawTarget();
      if (!ctx) return orig.call(this, opts);
      return orig.call(this, { ...opts, ctx, id });
    };
  }
}

export function initEngine(container) {
  if (container) visualRoot = container;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await initStrudel({
      // Сэмплы барабанов (dirt-samples) тянутся с GitHub лениво — при первом
      // исполнении кода (см. ensureSamples), чтобы не блокировать загрузку страницы
      // внешними запросами; при их недоступности синтезаторы всё равно работают.
      onError: (err) => {
        lastError = err;
      },
    });
    patchVisuals();
    initialized = true;
    return true;
  })();
  return initPromise;
}

let samplesPromise = null;

// Ленивая загрузка барабанных сэмплов: без блокировки evaluate и с повтором
// при следующем исполнении, если первая попытка сорвалась (нет сети и т.п.).
function ensureSamples() {
  if (samplesPromise) return samplesPromise;
  samplesPromise = samples('github:tidalcycles/dirt-samples').catch((err) => {
    console.warn('Не удалось загрузить сэмплы dirt-samples:', err);
    samplesPromise = null;
  });
  return samplesPromise;
}

export async function evaluateCode(code) {
  await initPromise;
  if (!initialized) throw new Error('Strudel не инициализирован');
  ensureSamples();
  if (visualRoot) visualRoot.querySelectorAll('canvas').forEach((c) => c.remove());
  drawSeq = 0;
  lastError = null;
  try {
    const result = await evaluate(code);
    if (lastError) throw lastError?.error || lastError;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export function stop() {
  if (!initialized) return;
  hush();
}

export function reset() {
  if (!initialized) return;
  hush();
  if (visualRoot) visualRoot.querySelectorAll('canvas').forEach((c) => c.remove());
}

// Разблокировка звука: браузеры разрешают AudioContext только после жеста пользователя.
export async function unlockAudio() {
  const ctx = getAudioContext?.();
  if (ctx && ctx.state !== 'running') {
    try {
      await ctx.resume();
    } catch {
      /* остаётся suspended до следующего клика */
    }
  }
  return ctx?.state || 'unknown';
}
