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
// Детерминизм: два прогона подряд дают maxAbsDiff = 0 (доказано в
// tests/spike/browser/out-offline.txt). Поэтому воркер НЕ полагается на seed —
// он полагается на то, что движок и сэмпл-банк неизменны.
//
// Движок (@strudel/web) грузится отдельным UMD-скриптом (/bundle.js) и доступен
// как window.strudel — так же, как в спайке фазы 0 (tests/spike/browser/page.js).

import { createEngineAdapter } from '../../../src/audio/engine/adapter.js';
import { audioBufferToChannels } from '../../../src/audio/render/offline.js';
import { buildMetricsReport } from '../../../src/audio/metrics-report.js';
import { encodeWav } from '../../../src/core/wav.js';

const strudel = window.strudel;

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
];

const strudelApi = {};
for (const name of STRUDEL_METHODS) {
  strudelApi[name] = (...args) => strudel[name](...args);
}

let adapter = null;
let initError = null;

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
  } = args || {};

  if (!code || typeof code !== 'string') throw new Error('Нет кода для рендера');
  if (!adapter) throw new Error(initError ? 'Движок не инициализирован: ' + initError : 'Движок не инициализирован');

  const startedAt = performance.now();

  const pattern = await adapter.patternFromCode(code);
  if (!pattern || typeof pattern.queryArc !== 'function') {
    throw new Error('Код не дал паттерн — рендер невозможен');
  }

  const buffer = await adapter.renderCodeOffline({ code, fromCycle, toCycle, sampleRate, cps });
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
 * даёт «sound bd not found!». Имена и адреса — из реестра
 * server/music/data/sample-banks.json (не выдумываем имён сэмплов).
 */
const SAMPLE_SETS = ['github:tidalcycles/dirt-samples', 'shabda:piano'];

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
