// Фаза 3, браузерный спайк: офлайн-рендер → MetricsReport → замечания Audio QA.
//
// Этот файл — точка входа браузерного бандла: его собирает esbuild
// (см. offline-render-spike.mjs) вместе с нашими ES-модулями из src/audio
// и zod (его тянет metrics-report.js).
//
// Движок @strudel/web грузится отдельным UMD-скриптом (/bundle.js) и доступен
// как window.strudel — так же, как в спайке фазы 0 (page.js).

import { createEngineAdapter } from '../../../src/audio/engine/adapter.js';
import {
  renderAndMeasure,
  audioBufferToChannels,
} from '../../../src/audio/render/offline.js';
import { buildMetricsReport, ACCEPTANCE } from '../../../src/audio/metrics-report.js';
import { runAudioQa, splitFindings, acceptancePassed } from '../../../src/audio/qa.js';

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

const SAMPLE_RATE = 48000;
const CPS = 0.5; // 120 BPM: один такт (цикл) = 2 с

// Паттерны — только синтезаторы: банк сэмплов тянут из сети, а спайк должен
// работать без загрузки сэмплов (s("bd") без сэмпла просто молчит).
const PATTERNS = [
  {
    id: 'bass',
    label: 'бас: пила c2, gain 0.8',
    code: 'note("c2").s("sawtooth").gain(0.8)',
    bars: 16,
  },
  {
    id: 'arp',
    label: 'арпеджио: квадрат c3-e3-g3-b3, gain 0.5',
    code: 'note("c3 e3 g3 b3").s("square").gain(0.5)',
    bars: 16,
  },
  {
    id: 'pad',
    label: 'под: треугольник c4, gain 0.35',
    code: 'note("c4").s("triangle").gain(0.35)',
    bars: 16,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Заменяет нечисловые значения на null — чтобы результат уехал в JSON без потерь. */
function sanitize(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = sanitize(val);
    return out;
  }
  return value;
}

/**
 * Проверка живого пути ПОСЛЕ офлайн-рендера:
 * контекст должен быть в норме, ошибок быть не должно, а звук — идти.
 */
async function liveCheck(adapter, code, ctx) {
  const res = { ctxStateBefore: ctx.state };
  const tail = adapter.outputNode();
  res.hasTail = !!tail;
  let analyser = null;
  if (tail) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    tail.connect(analyser);
  }
  const evaluated = await adapter.evaluate(code);
  res.evalOk = evaluated.ok;
  res.evalError = evaluated.error ?? null;
  const started = ctx.currentTime;
  let peak = 0;
  const data = analyser ? new Float32Array(analyser.fftSize) : null;
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    await sleep(50);
    if (analyser) {
      analyser.getFloatTimeDomainData(data);
      for (const v of data) {
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
    }
  }
  res.livePeak = peak;
  res.livePeakDb = peak > 0 ? 20 * Math.log10(peak) : null;
  res.ctxStateAfter = ctx.state;
  res.globalCtxState = strudel.getAudioContext?.()?.state ?? null;
  res.globalCtxIsLive = strudel.getAudioContext?.() === ctx;
  res.timeAdvanced = ctx.currentTime > started;
  if (analyser) {
    try {
      tail.disconnect(analyser);
    } catch (_) {
      /* хвост мог быть уже отключён */
    }
  }
  return res;
}

/**
 * Огибающая сигнала и моменты атак: проверяем, что события попали в рендер
 * на свои места (а не все в начало такта).
 */
function envelopeOnsets(channels, sampleRate, { windowMs = 50, thresholdDb = -45, riseDb = 6, maxOnsets = 8, limitSeconds = 8 } = {}) {
  const frames = Math.min(...channels.map((ch) => ch.length));
  const win = Math.max(1, Math.round((windowMs * sampleRate) / 1000));
  const limit = Math.min(frames, Math.round(limitSeconds * sampleRate));
  const threshold = Math.pow(10, thresholdDb / 20);
  const levels = [];
  for (let from = 0; from + win <= limit; from += win) {
    let sum = 0;
    for (const ch of channels) {
      for (let i = from; i < from + win; i += 1) sum += ch[i] * ch[i];
    }
    const rms = Math.sqrt(sum / (win * channels.length));
    levels.push({ t: Number((from / sampleRate).toFixed(3)), db: rms > 0 ? Number((20 * Math.log10(rms)).toFixed(2)) : null });
  }
  const onsets = [];
  for (let i = 1; i < levels.length && onsets.length < maxOnsets; i += 1) {
    const prev = levels[i - 1].db === null ? -120 : levels[i - 1].db;
    const cur = levels[i].db === null ? -120 : levels[i].db;
    if (cur > thresholdDb && cur - prev > riseDb) onsets.push(levels[i].t);
  }
  return { windowMs, thresholdDb, levels: levels.slice(0, 40), onsets };
}

/** Один паттерн: код → офлайн-рендер ×2 → метрики → замечания QA → проверка живого пути. */
async function measurePattern(adapter, spec, ctx) {
  const rec = { id: spec.id, label: spec.label, code: spec.code, bars: spec.bars };

  // 1. Код → паттерн Strudel (исполняется БЕЗ звука).
  const pattern = await adapter.patternFromCode(spec.code);
  rec.patternOk = !!(pattern && typeof pattern.queryArc === 'function');
  if (!rec.patternOk) throw new Error('Код не дал паттерн — рендер невозможен');
  const haps = pattern.queryArc(0, spec.bars, { _cps: CPS });
  rec.events = haps.length;
  rec.onsets = haps.filter((hap) => (typeof hap.hasOnset === 'function' ? hap.hasOnset() : true)).length;
  rec.firstEvents = haps.slice(0, 4).map((hap) => ({
    begin: Number(hap.whole.begin.valueOf()),
    dur: Number(hap.duration),
    note: hap.value?.note ?? null,
    s: hap.value?.s ?? null,
    gain: hap.value?.gain ?? null,
  }));
  // Куда адаптер ставит событие (whole.begin) и где оно лежит на самом деле
  // (part.begin) — расхождение означает, что события схлопываются в начало такта.
  rec.placement = haps.slice(0, 8).map((hap) => ({
    wholeBegin: Number(hap.whole.begin.valueOf()),
    partBegin: hap.part ? Number(hap.part.begin.valueOf()) : null,
    scheduledSec: Number(((hap.whole.begin.valueOf() - 0) / CPS).toFixed(3)),
    trueSec: hap.part ? Number(((hap.whole.begin.valueOf() + hap.part.begin.valueOf()) / CPS).toFixed(3)) : null,
    note: hap.value?.note ?? null,
  }));

  // 2. Два офлайн-рендера: renderAndMeasure сам считает повторяемость
  //    (второй прогон) и строит MetricsReport.
  const measured = await renderAndMeasure({
    render: async ({ fromCycle, toCycle, sampleRate, cps }) => {
      const buffer = await adapter.renderCodeOffline({
        code: spec.code,
        fromCycle,
        toCycle,
        sampleRate,
        cps,
      });
      return { channels: audioBufferToChannels(buffer), sampleRate: buffer.sampleRate };
    },
    bars: [0, spec.bars],
    sampleRate: SAMPLE_RATE,
    cps: CPS,
    runs: 2,
  });
  rec.renderMs = measured.renderMs;
  rec.comparison = measured.comparison;
  rec.report = measured.report;
  // Огибающая рендера: где реально стоят атаки.
  rec.envelope = envelopeOnsets(measured.channels, measured.sampleRate);

  // 3. Контрольный MetricsReport из сырых каналов (buildMetricsReport напрямую):
  //    значения должны совпасть с отчётом оркестратора.
  const direct = buildMetricsReport(measured.channels, measured.sampleRate, {
    renderMode: 'offline',
    bars: [0, spec.bars],
  });
  rec.directReport = {
    lufsI: direct.lufsI,
    truePeakDbtp: direct.truePeakDbtp,
    peakDbfs: direct.peakDbfs,
    crestDb: direct.crestDb,
    matchesOrchestrated:
      direct.lufsI === measured.report.lufsI &&
      direct.truePeakDbtp === measured.report.truePeakDbtp &&
      direct.peakDbfs === measured.report.peakDbfs,
  };

  // 4. Замечания Audio QA.
  const findings = runAudioQa(measured.report);
  rec.findings = findings.map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    label: finding.label,
    hint: finding.hint,
    params: finding.params,
  }));
  const split = splitFindings(findings);
  rec.errorCount = split.errors.length;
  rec.warningCount = split.warnings.length;
  rec.acceptancePassed = acceptancePassed(measured.report).passed;

  // 5. Живой путь после офлайн-рендера.
  rec.live = await liveCheck(adapter, spec.code, ctx);
  return rec;
}

async function runSpike() {
  const out = {
    startedAt: new Date().toISOString(),
    engine: {
      userAgent: navigator.userAgent,
      sampleRate: SAMPLE_RATE,
      cps: CPS,
      acceptance: ACCEPTANCE,
    },
    patterns: [],
    errors: [],
  };

  // Живой контекст: его состояние проверяем и до, и после офлайн-рендера.
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume().catch(() => {});
  out.engine.liveContextStateBefore = ctx.state;

  const adapter = createEngineAdapter(strudelApi, {
    maxPolyphony: 64,
    onEvalError: (err) => {
      out.errors.push('eval: ' + String(err?.message || err));
    },
  });
  await adapter.init(ctx);
  out.engine.tailAfterInit = !!adapter.outputNode();

  for (const spec of PATTERNS) {
    try {
      out.patterns.push(await measurePattern(adapter, spec, ctx));
    } catch (err) {
      out.patterns.push({
        id: spec.id,
        label: spec.label,
        code: spec.code,
        bars: spec.bars,
        error: String(err?.message || err),
      });
    }
  }

  out.engine.liveContextStateAfter = ctx.state;
  out.finishedAt = new Date().toISOString();
  return sanitize(out);
}

window.__offlineSpike = {
  ready: !!strudel,
  run: runSpike,
};

const status = document.getElementById('status');
if (status) {
  status.textContent = strudel
    ? 'движок загружен, можно запускать измерения'
    : 'движок не загрузился: window.strudel пуст';
}
