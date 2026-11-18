// Обёртка над @strudel/web: инициализация, исполнение кода, визуализация.
// Визуализации перенаправлены в наш контейнер: каждая партия получает свой блок
// с подписью и нефритовым пианороллом (активные ноты подсвечиваются).
//
// Сигнальный путь студии:
//
//   движок (superdough) ─► masterIn ─► [worklet: EQ→glue→лимитер→метры] ─► выход
//
// Контекст и мастер принадлежат студии (src/audio/graph.js), движок — гость.
import {
  initStrudel,
  evaluate,
  hush,
  getAudioContext,
  setAudioContext,
  getSuperdoughAudioController,
  setSuperdoughAudioController,
  initAudio,
  registerSynthSounds,
  superdough,
  Pattern,
  samples,
  loadBuffer,
} from '@strudel/web';
import { highlightBlock } from './core/highlight.js';
import { visualPlan } from './core/visual-plan.js';
import { installJadeVisuals } from './pianoroll.js';
import { instrumentCode, resetMeters } from './meters.js';
import { accentOf } from './accents.js';
import { createStudioGraph } from './audio/graph.js';
import { createEngineAdapter } from './audio/engine/adapter.js';
import { SAMPLE_SETS } from './sample-banks.js';
import { masterPresetFor, masterPresetForCode } from './audio/master-presets.js';
import { renderAndMeasure } from './audio/render/offline.js';
import { createRealmRenderer } from './audio/render/realm.js';
import { allSamplesReady } from './samples-ready.js';
import { ensureTimbreForCode, fetchTimbreCatalog } from './timbre/register.js';

export { visualPlan };

let initialized = false;
let initPromise = null;
let visualRoot = null;
let drawSeq = 0;
let lastError = null;
let planCache = [];
// На тихом прогоне (валидация) визуализации не создаются.
let suppressVisuals = false;
// Последний исполненный код — нужен, чтобы после офлайн-рендера вернуть
// живой трек на место.
let currentCode = null;

// Студийная шина: контекст, мастер-цепочка, метры.
let context = null;
let graph = null;
let adapter = null;
// true, если мастер-шина не поднялась и звук идёт напрямую в выход.
let directOutput = false;

/** Модуль @strudel/web в виде объекта — так его ждёт адаптер движка. */
const strudelApi = {
  initStrudel,
  evaluate,
  hush,
  getAudioContext,
  setAudioContext,
  getSuperdoughAudioController,
  setSuperdoughAudioController,
  initAudio,
  registerSynthSounds,
  superdough,
  samples,
  loadBuffer,
};

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
    // 1. Контекст и мастер-шина — принадлежат студии.
    await setupStudioGraph();

    // 2. Движок — гость: садится в наш контекст.
    adapter = createEngineAdapter(strudelApi, {
      onEvalError: (err) => {
        lastError = err;
      },
    });
    await adapter.init(context);

    // 3. Хвост движка врезаем в мастер-шину (точка вставки H1).
    if (!directOutput) {
      adapter.attachMaster(graph.masterIn);
    } else {
      // Запасной путь: мастер недоступен — звук идёт прямо в выход.
      adapter.outputNode()?.connect(context.destination);
    }

    installJadeVisuals({ drawTarget: nextDrawTarget });
    initialized = true;

    // Отладочная ручка: граф, адаптер и живые метры. Используется браузерным
    // спайком (tests/spike/browser) и будущей GUI-панелью студии.
    window.strudelStudio = {
      get graph() {
        return graph;
      },
      get adapter() {
        return adapter;
      },
      get meters() {
        return graph?.meters ?? null;
      },
      get directOutput() {
        return directOutput;
      },
      // Отладочная ручка офлайн-рендера для браузерных зондов
      // (scripts/probe-render-realm.mjs, tests/spike/browser).
      renderTrackOffline,
    };

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

/**
 * Поднимает студийную шину: контекст + мастер-worklet.
 *
 * Если worklet не загрузился (старый браузер, битая сборка) — не падаем:
 * звук идёт напрямую в выход, приложение остаётся рабочим. Об этом честно
 * сообщаем в консоль: «мастер-цепочка выключена» — не «всё в порядке».
 */
async function setupStudioGraph() {
  try {
    context = new AudioContext({ latencyHint: 'interactive' });
    const created = await createStudioGraph({
      context,
      masterParams: masterPresetFor('flat').params,
    });
    graph = created.graph;
    directOutput = false;
    console.info(
      `[studio] Мастер-цепочка включена: задержка ${graph.latencySamples} отсчётов ` +
        `(${(graph.latencySeconds * 1000).toFixed(1)} мс)`,
    );
  } catch (error) {
    directOutput = true;
    context = new AudioContext({ latencyHint: 'interactive' });
    console.warn(
      '[studio] Мастер-цепочка недоступна, звук идёт напрямую:',
      error?.message || error,
    );
  }
}

/** Граф студии (контекст, мастер, метры) — null, если шина не поднялась. */
export function studioGraph() {
  return graph;
}

let appliedMasterId = null;

/**
 * Мастер под стиль трека: оркестр не жмётся порогом −20 дБ (D-121).
 * Пресет меняется только при смене стиля — лишний патч пересоздаёт
 * компрессор и лимитер без нужды.
 */
function applyMasterForCode(code) {
  if (!graph) return;
  const preset = masterPresetForCode(code);
  if (preset.id === appliedMasterId) return;
  // makeupDb сбрасывается явно: worklet мержит comp-патч, и +1 дБ оркестра
  // не должен пережить переключение на обычный пресет.
  graph.setMasterParams({ ...preset.params, comp: { makeupDb: 0, ...preset.params.comp } });
  appliedMasterId = preset.id;
  console.info(`[studio] мастер-пресет: ${preset.label}`);
}

/** Адаптер движка — для позиции, темпа и офлайн-рендера. */
export function engineAdapter() {
  return adapter;
}

let realm = null;
/** Менеджер изолированного рендера: один на страницу, realm — на рендер. */
function realmRenderer() {
  if (!realm) realm = createRealmRenderer();
  return realm;
}

let samplesPromise = null;
let samplesRetryAt = 0;

// Наборы сэмплов, которые реально существуют. Список — в общем модуле:
// им пользуются ещё серверный рендерер и гейт лицензий, иначе банк можно
// добавить в одном месте, а лицензия останется непроверенной.

/**
 * Подгружает манифесты сэмплов. Возвращает промис, который можно ждать:
 * после его резолва soundMap готов и первый такт уже со звуком.
 *
 * Промис ВСЕГДА резолвится в булево: `true` — оба набора на месте и трек
 * звучит целиком; `false` — сэмплов не хватает (сеть, CDN), и трек неполный.
 * Раньше здесь был `undefined` в окне повторной попытки — вызывающий код
 * принимал это за «сэмплов нет» и портил метки.
 *
 * @param {{force?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export function ensureSamples({ force = false } = {}) {
  if (samplesPromise && !force) return samplesPromise;
  // Окно повторной попытки: сэмплы уже не в порядке, и ждать их сейчас
  // бессмысленно — отвечаем честным «нет» вместо undefined.
  if (!force && Date.now() < samplesRetryAt) return Promise.resolve(false);
  samplesPromise = Promise.allSettled(SAMPLE_SETS.map((src) => samples(src))).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    for (const f of failed) console.warn('Набор сэмплов недоступен:', f.reason?.message || f.reason);
    // Нужен ВЕСЬ набор: без ударных трек теряет ритм, без пианино — мелодию.
    // Половина набора — это неполный трек, и сравнивать его как цельный
    // бессмысленно (такая метка помечается degraded и в обучение не идёт).
    const ok = allSamplesReady(results);
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
  // Пресеты Timbre (D-128): прогрев конкретных файлов ДО первого звука.
  // Отказ — ошибка исполнения, а не тихая подмена синтезатором.
  if (code.includes('tp_')) {
    try {
      const timbre = await ensureTimbreForCode(code, adapter);
      if (!timbre.ok) {
        return { ok: false, error: `Пресеты тембра не загрузились: ${timbre.errors.join('; ')}` };
      }
    } catch (error) {
      return { ok: false, error: `Каталог тембров недоступен: ${String(error?.message || error)}` };
    }
  }
  applyMasterForCode(code);
  planCache = visualPlan(code);
  if (visualRoot) visualRoot.replaceChildren();
  drawSeq = 0;  lastError = null;
  resetMeters();

  // Исполняем счётчики партий: они не трогают звук, но дают живые метры.
  const { code: runnable } = instrumentCode(code);
  try {
    const result = await evaluate(runnable);
    if (lastError) throw lastError?.error || lastError;
    currentCode = code;
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

/**
 * Офлайн-рендер трека и отчёт о звучании (фаза 3).
 *
 * Рендер изолирован в свежем iframe-realm на каждый прогон (E-020/D-143):
 * глобальные пулы узлов superdough 1.3.0 не переживают уничтожение realm,
 * поэтому быстрые последовательные рендеры не ловят cross-context connect.
 * Живой контекст и контроллер студии рендер не трогает — живой трек
 * продолжает звучать без восстановления. DSP и паспорт происхождения те же
 * (инвариант D-104 проверяется зондом scripts/probe-render-realm.mjs).
 *
 * Сэмплы и пресеты Timbre realm грузит сам (банки — до готовности, пресеты —
 * прогревом конкретных файлов); отказ — ошибка рендера, не тихая подмена.
 * Соло-рендеры партий требуют разметки партий в коде — это фаза 4.
 *
 * @param {{code?:string, bars?:[number,number], sampleRate?:number, cps?:number, runs?:number}} [options]
 * @returns {Promise<{report:object, renderMs:number, comparison:object|null}>}
 */
export async function renderTrackOffline({ code, bars = [0, 16], sampleRate = 48000, cps = 0.5, runs = 2 } = {}) {
  await initPromise;
  if (!initialized) throw new Error('Струдия не инициализирована');
  const target = code ?? currentCode;
  if (!target) throw new Error('Нет кода для рендера');

  // Каталог Timbre родитель отдаёт realm сам (кэш родителя): каждый свежий
  // iframe не должен ходить в /api/timbre/catalog — лимитер 20 req/min.
  // Отказ каталога — ошибка рендера (fail-closed, D-128).
  let timbre = null;
  if (target.includes('tp_')) {
    const catalog = await fetchTimbreCatalog();
    timbre = { sampleMap: catalog.sampleMap, presets: catalog.presets };
  }

  return renderAndMeasure({
    render: ({ fromCycle, toCycle, sampleRate: sr, cps: c }) =>
      realmRenderer().render({ code: target, fromCycle, toCycle, sampleRate: sr, cps: c, timbre }),
    bars,
    sampleRate,
    cps,
    runs,
  });
}

export function reset() {
  if (!initialized) return;
  hush();
  resetMeters();
  if (visualRoot) visualRoot.replaceChildren();
}

// Разблокировка звука: браузеры разрешают AudioContext только после жеста пользователя.
export async function unlockAudio() {
  const ctx = context ?? getAudioContext?.();
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
