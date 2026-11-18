// Браузерная часть рендер-воркера режима «Разбор».
//
// Задача: превратить Strudel-код в АУДИО на сервере, где нет ни Web Audio,
// ни OfflineAudioContext. Поэтому звук рождается в настоящем движке
// (superdough) внутри headless-браузера, а наверх отдаются:
//
//   * WAV (16-bit PCM, base64)   — чтобы Node мог посчитать метрики своим же DSP;
//   * MetricsReport               — тот же отчёт, что считает браузер студии;
//   * события паттерна            — для сравнения ритма без декодирования звука.
//
// Детерминизм E-022: фиксированный PRNG до init/evaluate и ожидание
// завершения каждой IR. Node создаёт свежую render page на каждый рендер.
//
// Движок (@strudel/web) грузится отдельным UMD-скриптом (/bundle.js) и доступен
// как window.strudel — так же, как в спайке фазы 0 (tests/spike/browser/page.js).

import { createEngineAdapter } from '../../../src/audio/engine/adapter.js';
import { audioBufferToChannels } from '../../../src/audio/render/offline.js';
import { buildMetricsReport } from '../../../src/audio/metrics-report.js';
import { encodeWav } from '../../../src/core/wav.js';
import { SAMPLE_SETS } from '../../../src/sample-banks.js';
import { installRenderDeterminism } from '../../../src/audio/render/seed.js';

const strudel = window.strudel;
const determinism = installRenderDeterminism();

/**
 * Алиасы визуализаций живут в приложении (src/pianoroll.js), а не в Strudel.
 * Код двойника их содержит (`._scope()`, `._pianoroll()` — их ставит общий
 * компилятор), поэтому без заглушек рендер падает с
 * «arrange(...)._scope is not a function». В Node-рантайме студии то же самое
 * делает installVisualStubs (server/music/strudel-runtime.mjs).
 */
function installVisualStubs(api) {
  const proto = api?.Pattern?.prototype;
  if (!proto) return;
  for (const name of ['_pianoroll', '_scope', '_fscope', '_spectrum']) {
    if (typeof proto[name] !== 'function') {
      proto[name] = function () {
        return this;
      };
    }
  }
}

installVisualStubs(strudel);

// Ровно тот список методов, который ждёт createEngineAdapter (см. src/strudel-engine.js).
const STRUDEL_METHODS = [
  'initStrudel',
  'evaluate',
  'hush',
  'getAudioContext',
  'setAudioContext',
  'getSuperdoughAudioController',
  'setSuperdoughAudioController',
  'initAudio',
  'registerSynthSounds',
  'superdough',
  'samples',
  'loadBuffer',
];

const strudelApi = {};
for (const name of STRUDEL_METHODS) {
  strudelApi[name] = (...args) => strudel[name](...args);
}

let adapter = null;
let initError = null;
const loadedPoolSamples = new Set();
let registeredTimbreMap = null;

/** base64 из байтов — кусками, чтобы не раздувать стек на длинном рендере. */
function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** События паттерна: ритм двойника без декодирования звука. */
function collectEvents(pattern, fromCycle, toCycle, cps) {
  const haps = pattern.queryArc(fromCycle, toCycle, { _cps: cps });
  return haps.map((hap) => ({
    begin: Number(hap.whole?.begin?.valueOf?.() ?? hap.whole?.begin ?? 0),
    dur: Number(hap.duration ?? 0),
    note: hap.value?.note ?? null,
    n: hap.value?.n ?? null,
    s: hap.value?.s ?? null,
    gain: hap.value?.gain ?? null,
    hasOnset: typeof hap.hasOnset === 'function' ? hap.hasOnset() : true,
  }));
}

/**
 * Рендер кода в аудио.
 *
 * @param {{code:string, fromCycle?:number, toCycle?:number, sampleRate?:number,
 *          cps?:number, wantWav?:boolean, wantEvents?:boolean}} args
 */
async function render(args) {
  const {
    code,
    fromCycle = 0,
    toCycle = 16,
    sampleRate = 48000,
    cps = 0.5,
    wantWav = true,
    wantEvents = true,
    poolSamples = [],
    timbre = null,
  } = args || {};

  if (!code || typeof code !== 'string') throw new Error('Нет кода для рендера');
  if (!adapter) throw new Error(initError ? 'Движок не инициализирован: ' + initError : 'Движок не инициализирован');

  // Сэмплы пула «Охотника» (D-119): грузятся с того же локального сервера,
  // что и страница рендера. Ошибка загрузки — ошибка рендера: молча играть
  // бит без найденного звука нельзя.
  const fresh = poolSamples.filter((s) => s?.sound && s?.id && !loadedPoolSamples.has(s.sound));
  if (fresh.length) {
    const map = Object.fromEntries(fresh.map((s) => [s.sound, `/pool-audio/${s.id}.wav`]));
    const loaded = await adapter.loadSamples({ sources: [map] });
    if (!loaded.ok || loaded.failed) {
      throw new Error('Сэмплы пула не загрузились: ' + (loaded.errors || []).join('; '));
    }
    fresh.forEach((s) => loadedPoolSamples.add(s.sound));
  }

  // Пресеты Timbre Palette (D-128): регистрация карты + прогрев конкретных
  // OGG публичным loadBuffer ДО рендера. Манифест ≠ загруженные файлы:
  // без прогрева первая нота пресета молчит. Отказ — ошибка рендера.
  if (timbre && timbre.aliases?.length) {
    const mapKey = JSON.stringify(timbre.map);
    if (registeredTimbreMap !== mapKey) {
      const loaded = await adapter.loadSamples({ sources: [timbre.map] });
      if (!loaded.ok || loaded.failed) {
        throw new Error('Карта пресетов Timbre не зарегистрировалась: ' + (loaded.errors || []).join('; '));
      }
      registeredTimbreMap = mapKey;
    }
    const base = timbre.map._base ?? '/timbre-audio/';
    const urls = timbre.aliases.flatMap((alias) => {
      const entries = timbre.map[alias];
      if (!entries || typeof entries !== 'object') return [];
      return Object.values(entries).map((file) => (String(file).startsWith('/') ? file : base + file));
    });
    const warmed = await adapter.warmSamples(urls);
    if (!warmed.ok) {
      throw new Error('Пресеты Timbre не прогрелись: ' + (warmed.errors || []).join('; '));
    }
  }

  const startedAt = performance.now();

  const pattern = await adapter.patternFromCode(code);
  if (!pattern || typeof pattern.queryArc !== 'function') {
    throw new Error('Код не дал паттерн — рендер невозможен');
  }

  // Один evaluate, как в realm: повторный запуск кода потреблял бы PRNG
  // ещё раз и мог дать разные паттерны для WAV и списка событий.
  const buffer = await adapter.renderOffline({ pattern, fromCycle, toCycle, sampleRate, cps, prepare: determinism.prepare });
  const channels = audioBufferToChannels(buffer);
  const actualRate = buffer.sampleRate || sampleRate;

  const report = buildMetricsReport(channels, actualRate, {
    renderMode: 'offline',
    bars: [fromCycle, toCycle],
  });

  const result = {
    ok: true,
    sampleRate: actualRate,
    frames: channels[0]?.length ?? 0,
    durationS: channels[0]?.length ? channels[0].length / actualRate : 0,
    channels: channels.length,
    report,
    renderMs: Math.round(performance.now() - startedAt),
    wavBase64: null,
    events: null,
  };

  if (wantWav) {
    const wav = encodeWav(channels, actualRate);
    result.wavBase64 = bytesToBase64(new Uint8Array(wav));
  }
  if (wantEvents) {
    try {
      result.events = collectEvents(pattern, fromCycle, toCycle, cps);
    } catch (err) {
      result.eventsError = String(err?.message || err);
    }
  }
  return result;
}

/**
 * Банки сэмплов. Без них ударные и пианино молчат: `s("bd")` без сэмпла
 * даёт «sound bd not found!». Список — общий (src/sample-banks.js), там же
 * живёт его проверка лицензий.
 */

/** Готовит живой контекст и движок. */
async function init() {
  if (adapter) return { ok: true, already: true };
  if (!strudel) {
    initError = 'window.strudel пуст — UMD-бандл @strudel/web не загрузился';
    return { ok: false, error: initError };
  }
  try {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume().catch(() => {});
    adapter = createEngineAdapter(strudelApi, {
      maxPolyphony: 64,
      onEvalError: (err) => {
        initError = String(err?.message || err);
      },
    });
    await adapter.init(ctx);

    // Сэмплы грузим ДО рендера: без них двойник останется без ударных.
    const samples = await adapter.loadSamples({ sources: SAMPLE_SETS });

    return { ok: true, contextState: ctx.state, samples };
  } catch (err) {
    initError = String(err?.message || err);
    return { ok: false, error: initError };
  }
}

window.__renderTwin = {
  ready: !!strudel,
  init,
  render,
  userAgent: navigator.userAgent,
};
