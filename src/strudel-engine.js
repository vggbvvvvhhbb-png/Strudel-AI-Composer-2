// Обёртка над @strudel/web: инициализация, исполнение кода, визуализация.
// Визуализации перенаправлены в наш контейнер: каждая партия получает свой блок
// с подписью и нефритовым пианороллом (активные ноты подсвечиваются).
import { initStrudel, evaluate, hush, getAudioContext, Pattern, samples } from '@strudel/web';
import { highlightBlock } from './core/highlight.js';
import { visualPlan } from './core/visual-plan.js';
import { installJadeVisuals } from './pianoroll.js';
import { instrumentCode, resetMeters } from './meters.js';
import { accentOf } from './accents.js';

export { visualPlan };

let initialized = false;
let initPromise = null;
let visualRoot = null;
let drawSeq = 0;
let lastError = null;
let planCache = [];
// На тихом прогоне (валидация) визуализации не создаются.
let suppressVisuals = false;

function dpr() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

// Карточка партии: подпись, исходный код партии и крупный пианоролл/осциллограф
// прямо под строкой $PART: — как в live-coding стримах.
function nextDrawTarget(kind) {
  if (!visualRoot || suppressVisuals) return null;
  const plan = planCache[drawSeq] || { label: '', kind, accent: accentOf(drawSeq), lines: [] };
  const block = document.createElement('section');
  block.className = `part-block part-${kind} accent-${plan.accent}`;
  block.dataset.label = plan.label;

  const head = document.createElement('header');
  head.className = 'part-head';
  const name = document.createElement('span');
  name.className = 'part-name';
  name.textContent = plan.label ? `$${plan.label}` : 'Партия';
  const badge = document.createElement('span');
  badge.className = 'part-kind';
  badge.textContent = kind === 'scope' ? 'осциллограф' : 'пианоролл';
  const live = document.createElement('span');
  live.className = 'part-live';
  live.title = 'Партия звучит';
  head.append(name, badge, live);

  const canvas = document.createElement('canvas');
  canvas.className = kind === 'scope' ? 'strudel-view scope-canvas' : 'strudel-view';

  block.append(head);

  // Код партии над пианороллом: видно, какой строкой он построен.
  if (plan.lines?.length) {
    const code = document.createElement('pre');
    code.className = 'part-code';
    code.innerHTML = highlightBlock(plan.lines);
    block.append(code);
  }

  block.append(canvas);
  visualRoot.appendChild(block);
  sizeCanvas(canvas, block);
  drawSeq += 1;
  return { ctx: canvas.getContext('2d', { willReadFrequently: true }), id: drawSeq, canvas };
}

// Пианоролл — крупный: во всю ширину карточки и заметной высоты.
function sizeCanvas(canvas, block) {
  const ratio = dpr();
  const host = block || visualRoot;
  const width = Math.max(280, (host?.clientWidth || 480) - 28);
  const height = canvas.classList.contains('scope-canvas') ? 150 : 220;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = '100%';
  canvas.style.height = `${height}px`;
}

export function initEngine(container) {
  if (container) visualRoot = container;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await initStrudel({
      // Сэмплы барабанов (dirt-samples) тянутся с GitHub лениво — при первом
      // исполнении кода (см. ensureSamples), чтобы не блокировать загрузку страницы
      // внешними запросами; при их недоступности синтезаторы всё равно работают.
      //
      // Важно: именно onEvalError, а не onError. Strudel проглатывает исключение
      // внутри evaluate() и сам его не бросает — без этого хука сломанный код
      // выглядел бы как успешно исполненный.
      onEvalError: (err) => {
        lastError = err;
      },
    });
    installJadeVisuals({ drawTarget: nextDrawTarget });
    initialized = true;
    // Прогреваем сэмплы заранее: к моменту первого нажатия «play»
    // манифест уже загружен, и звук есть с первой ноты.
    ensureSamples();
    window.addEventListener('resize', () => {
      visualRoot?.querySelectorAll('.part-block').forEach((block) => {
        const canvas = block.querySelector('canvas');
        if (canvas) sizeCanvas(canvas, block);
      });
    });
    return true;
  })();
  return initPromise;
}

let samplesPromise = null;
let samplesRetryAt = 0;

// Наборы сэмплов, которые реально существуют.
//   github:tidalcycles/dirt-samples — большой набор (bd, sd, hh, cp, 808*, breaks* …);
//   shabda:piano — пианино (в dirt-samples его нет).
// Имена из манифеста — единственные рабочие: неизвестное имя молча
// выпадает из звука («sound … not found!»).
const SAMPLE_SETS = ['github:tidalcycles/dirt-samples', 'shabda:piano'];

/**
 * Подгружает манифесты сэмплов. Возвращает промис, который можно ждать:
 * после его резолва soundMap готов и первый такт уже со звуком.
 */
export function ensureSamples({ force = false } = {}) {
  if (samplesPromise && !force) return samplesPromise;
  if (!force && Date.now() < samplesRetryAt) return Promise.resolve();
  samplesPromise = Promise.allSettled(SAMPLE_SETS.map((src) => samples(src))).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    for (const f of failed) console.warn('Набор сэмплов недоступен:', f.reason?.message || f.reason);
    const ok = failed.length < results.length;
    if (!ok) {
      samplesPromise = null;
      samplesRetryAt = Date.now() + 60_000;
    }
    window.dispatchEvent(
      new CustomEvent('strudel:samples', { detail: { ok, failed: failed.length } }),
    );
    return ok;
  });
  return samplesPromise;
}

/** Ждём сэмплы, но не дольше лимита: медленная сеть не должна блокировать звук. */
async function waitForSamples(timeoutMs = 5000) {
  try {
    await Promise.race([
      ensureSamples(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    /* сэмплы не пришли — играем на синтезаторах */
  }
}

export async function evaluateCode(code) {
  await initPromise;
  if (!initialized) throw new Error('Strudel не инициализирован');
  // Сэмплы нужны до первого звука: иначе ударные и пианино молчат
  // («sound bd not found») до конца загрузки манифеста.
  await waitForSamples();
  planCache = visualPlan(code);
  if (visualRoot) visualRoot.replaceChildren();
  drawSeq = 0;
  lastError = null;
  resetMeters();

  // Исполняем счётчики партий: они не трогают звук, но дают живые метры.
  const { code: runnable } = instrumentCode(code);
  try {
    const result = await evaluate(runnable);
    if (lastError) throw lastError?.error || lastError;
    return { ok: true, result };
  } catch (err) {
    // Инструментация могла не подойти к конкретному коду — пробуем чистый вариант.
    if (runnable !== code) {
      try {
        const result = await evaluate(code);
        if (lastError) throw lastError?.error || lastError;
        return { ok: true, result };
      } catch (cleanErr) {
        return { ok: false, error: String(cleanErr?.message || cleanErr) };
      }
    }
    return { ok: false, error: String(err?.message || err) };
  }
}

export function stop() {
  if (!initialized) return;
  hush();
  resetMeters();
}

export function reset() {
  if (!initialized) return;
  hush();
  resetMeters();
  if (visualRoot) visualRoot.replaceChildren();
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

// Тихий прогон для валидатора: контекст приостанавливается, звук не звучит,
// но ошибки парсинга всплывают. По завершении паттерны глушатся.
export async function dryRun(code) {
  await initPromise;
  if (!initialized) throw new Error('Strudel не инициализирован');
  const ctx = getAudioContext?.();
  const wasRunning = ctx?.state === 'running';
  lastError = null;
  suppressVisuals = true;
  try {
    if (wasRunning) await ctx.suspend();
    await evaluate(code);
    if (lastError) throw lastError?.error || lastError;
    hush();
    return { ok: true };
  } catch (err) {
    hush();
    return { ok: false, error: String(err?.message || err) };
  } finally {
    suppressVisuals = false;
    if (wasRunning) await ctx.resume();
  }
}
