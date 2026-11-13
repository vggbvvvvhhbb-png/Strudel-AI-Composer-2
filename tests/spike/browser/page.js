// Фаза 0, браузерный спайк: измерения по реальному движку Strudel (@strudel/web 1.3.0).
// Страница грузит UMD-бандл /bundle.js -> window.strudel и выполняет измерения.
//
// Детерминированность: никакого Math.random, никаких сетевых запросов (кроме H8),
// фиксированные sampleRate / cps / длительности.
// Идентификаторы кода — английские, комментарии — по-русски.

import { LookaheadLimiter } from '/limiter.js';

const strudel = window.strudel;

const dbfs = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const round = (x, n = 6) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(n)) : x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Палитра сэмплов проекта (server/music/extract.js + server/prompts/system.md).
const PROJECT_PALETTE = [
  'bd', 'sd', 'hh', 'hh27', 'cp', 'oh', 'perc', '808', '808bd', '808sd', '808oh',
  '808mc', '808ht', '808lc', '909', 'bass', 'bass0', 'bass1', 'bass2', 'bass3',
  'pluck', 'stab', 'jazz', 'juno', 'moog', 'sax', 'trump', 'sitar', 'house',
  'dr', 'dr2', 'dr55', 'breaks125', 'breaks152', 'breaks157', 'breaks165',
  'realclaps', 'sh', 'rave', 'gab', 'industrial', 'jungle', 'techno', 'piano',
];

function bufferStats(buf) {
  let sumSq = 0;
  let count = 0;
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c += 1) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i += 1) {
      const v = d[i];
      sumSq += v * v;
      count += 1;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
  }
  const rms = Math.sqrt(sumSq / count);
  return {
    channels: buf.numberOfChannels,
    frames: buf.length,
    sampleRate: buf.sampleRate,
    rms: round(rms),
    peak: round(peak),
    rmsDb: round(dbfs(rms), 3),
    peakDb: round(dbfs(peak), 3),
  };
}

// Покомпонентная разница двух буферов (детерминированность офлайн-рендера).
function compareBuffers(a, b) {
  let maxAbs = 0;
  let sumSq = 0;
  let count = 0;
  const n = Math.min(a.length, b.length);
  for (let c = 0; c < a.numberOfChannels; c += 1) {
    const da = a.getChannelData(c);
    const dbb = b.getChannelData(c);
    for (let i = 0; i < n; i += 1) {
      const d = da[i] - dbb[i];
      const abs = d < 0 ? -d : d;
      if (abs > maxAbs) maxAbs = abs;
      sumSq += d * d;
      count += 1;
    }
  }
  const rms = Math.sqrt(sumSq / count);
  return {
    maxAbsDiff: round(maxAbs, 12),
    rmsDiff: round(rms, 12),
    rmsDiffDb: round(dbfs(rms), 3),
  };
}

// --------------------------------------------------------------------------------------
// H1 / H3: собственный офлайн-рендер по схеме renderPatternAudio из @strudel/web 1.3.0.
// --------------------------------------------------------------------------------------

const OFFLINE_SR = 44100;
const OFFLINE_SECONDS = 4;
const OFFLINE_CPS = 2;

// Тестовый паттерн: синтезатор без сэмплов (детерминированный, без сети).
// Внимание: control-значения в @strudel/web 1.3.0 НЕ разбиваются на
// последовательность при установке через .s()/.note() (проверено пробой),
// поэтому используем постоянные значения: паттерн повторяется по тактам.
function makeTestPattern() {
  let p = strudel.s('sawtooth');
  if (typeof p.note === 'function') p = p.note('c3');
  else p = strudel.note('c3').s('sawtooth');
  if (typeof p.gain === 'function') p = p.gain(0.8);
  return p;
}

/**
 * Рендерит паттерн в OfflineAudioContext.
 * masterGain === null -> обычный путь (destinationGain -> ctx.destination),
 * иначе destinationGain перехватывается и вставляется masterIn -> ctx.destination.
 */
async function renderOffline(masterGain) {
  const off = new OfflineAudioContext(2, Math.round(OFFLINE_SR * OFFLINE_SECONDS), OFFLINE_SR);

  // Порядок важен: сперва чистим контроллер, потом ставим контекст,
  // иначе getSuperdoughAudioController() создаст контроллер на старом AudioContext.
  strudel.setSuperdoughAudioController(null);
  strudel.setAudioContext(off);
  strudel.registerSynthSounds();
  await strudel.initAudio({ maxPolyphony: 64 });

  const ctrl = strudel.getSuperdoughAudioController();
  const shape = {
    controllerCtor: ctrl ? ctrl.constructor.name : null,
    hasOutput: !!(ctrl && ctrl.output),
    hasDestinationGain: !!(ctrl && ctrl.output && ctrl.output.destinationGain),
    hasChannelMerger: !!(ctrl && ctrl.output && ctrl.output.channelMerger),
    destinationGainCtor: ctrl && ctrl.output && ctrl.output.destinationGain
      ? ctrl.output.destinationGain.constructor.name
      : null,
    channelMergerCtor: ctrl && ctrl.output && ctrl.output.channelMerger
      ? ctrl.output.channelMerger.constructor.name
      : null,
    sameContext: !!(ctrl && ctrl.audioContext === off),
  };

  let masterIn = null;
  let insertError = null;
  if (masterGain !== null) {
    try {
      const dg = ctrl.output.destinationGain;
      dg.disconnect();
      masterIn = new GainNode(off, { gain: masterGain });
      dg.connect(masterIn);
      masterIn.connect(off.destination);
      shape.masterInserted = true;
    } catch (err) {
      insertError = String((err && err.message) || err);
      shape.masterInserted = false;
    }
  }

  const pattern = makeTestPattern();
  const from = 0;
  const to = OFFLINE_SECONDS * OFFLINE_CPS;
  const haps = pattern
    .queryArc(from, to, { _cps: OFFLINE_CPS })
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

  const events = [];
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
    const begin = (hap.whole.begin.valueOf() - from) / OFFLINE_CPS;
    const dur = hap.duration / OFFLINE_CPS;
    if (typeof hap.ensureObjectValue === 'function') hap.ensureObjectValue();
    await strudel.superdough(hap.value, begin, dur, OFFLINE_CPS, begin);
    events.push({ begin: round(begin, 4), dur: round(dur, 4), note: hap.value.note, s: hap.value.s });
  }

  const buf = await off.startRendering();
  return { buf, shape, events, insertError, masterGain };
}

// Запасной путь (b): подмена destination у контекста через defineProperty.
async function probeFallbackDefineProperty() {
  const out = { tried: true, ok: false, error: null };
  try {
    const off = new OfflineAudioContext(2, OFFLINE_SR, OFFLINE_SR);
    const masterIn = new GainNode(off, { gain: 0.5 });
    Object.defineProperty(off, 'destination', { get: () => masterIn, configurable: true });
    strudel.setSuperdoughAudioController(null);
    strudel.setAudioContext(off);
    strudel.registerSynthSounds();
    await strudel.initAudio({ maxPolyphony: 16 });
    const ctrl = strudel.getSuperdoughAudioController();
    out.controllerCtor = ctrl ? ctrl.constructor.name : null;
    out.destinationIsMasterIn = off.destination === masterIn;
    const pat = strudel.s('sawtooth').note('c3').gain(0.8);
    const haps = pat.queryArc(0, 1, { _cps: OFFLINE_CPS });
    for (const hap of haps) {
      if (!hap.hasOnset()) continue;
      if (typeof hap.ensureObjectValue === 'function') hap.ensureObjectValue();
      await strudel.superdough(hap.value, 0, hap.duration / OFFLINE_CPS, OFFLINE_CPS, 0);
    }
    const buf = await off.startRendering();
    out.stats = bufferStats(buf);
    out.ok = out.stats.rms > 0;
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  return out;
}

async function runH1() {
  const result = { hypothesis: 'H1', steps: [], errors: [] };

  // (1) обычный путь
  const base = await renderOffline(null);
  result.shape = base.shape;
  result.events = base.events;
  result.base = bufferStats(base.buf);

  // (2) masterIn.gain = 0.5
  const half = await renderOffline(0.5);
  if (half.insertError) result.errors.push('gain=0.5: ' + half.insertError);
  result.half = bufferStats(half.buf);

  // (3) masterIn.gain = 1.0 (bypass-эквивалент)
  const one = await renderOffline(1.0);
  if (one.insertError) result.errors.push('gain=1.0: ' + one.insertError);
  result.one = bufferStats(one.buf);

  // Отношение RMS и остаток (bypass − baseline).
  const ratioHalf = result.base.rms > 0 ? result.half.rms / result.base.rms : null;
  const ratioOne = result.base.rms > 0 ? result.one.rms / result.base.rms : null;
  const residual = compareBuffers(one.buf, base.buf);
  result.ratioHalf = round(ratioHalf, 6);
  result.ratioOne = round(ratioOne, 6);
  result.residual = residual;
  result.residualRelDb = result.base.rms > 0
    ? round(dbfs(residual.rmsDiff / result.base.rms), 3)
    : null;
  result.halfWithin10pct = ratioHalf === null ? false : Math.abs(ratioHalf - 0.5) <= 0.05;
  result.bypassMatchesBase = result.residualRelDb === null ? false : result.residualRelDb <= -40;

  // Запасной путь (b) — только если основной не сработал.
  if (!result.shape.hasDestinationGain) {
    result.fallbackDefineProperty = await probeFallbackDefineProperty();
  }

  strudel.setAudioContext(null);
  strudel.setSuperdoughAudioController(null);
  return result;
}

// Детерминированность собственного офлайн-рендера (H3, часть 1).
async function runH3Determinism() {
  const a = await renderOffline(null);
  const b = await renderOffline(null);
  const cmp = compareBuffers(a.buf, b.buf);
  const out = {
    hypothesis: 'H3-own',
    first: bufferStats(a.buf),
    second: bufferStats(b.buf),
    compare: cmp,
    identical: cmp.maxAbsDiff === 0,
    events: a.events.length,
  };
  strudel.setAudioContext(null);
  strudel.setSuperdoughAudioController(null);
  return out;
}

// --------------------------------------------------------------------------------------
// H3, часть 2: официальный renderPatternAudio — что он возвращает и что закрывает.
// --------------------------------------------------------------------------------------

async function runH3Official() {
  const out = { hypothesis: 'H3-official' };
  const downloads = [];
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedClick() {
    downloads.push({ href: this.href, download: this.download });
    // сам клик не выполняем: иначе Chrome начнёт сохранять файл
  };

  // renderPatternAudio вызывает URL.revokeObjectURL сразу после клика,
  // поэтому размер WAV-блоба снимаем в момент создания.
  let wavBlob = null;
  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function patchedCreateObjectURL(obj) {
    if (obj instanceof Blob && obj.type && obj.type.includes('audio')) wavBlob = obj;
    return originalCreateObjectURL.call(URL, obj);
  };

  let capturedBuffer = null;
  const originalStartRendering = OfflineAudioContext.prototype.startRendering;
  OfflineAudioContext.prototype.startRendering = function patchedStartRendering() {
    return originalStartRendering.apply(this, arguments).then((buf) => {
      capturedBuffer = buf;
      return buf;
    });
  };

  try {
    const live = new AudioContext();
    out.liveCtxStateBefore = live.state;
    strudel.setAudioContext(live);
    strudel.registerSynthSounds();

    const pattern = makeTestPattern();
    const returned = await strudel.renderPatternAudio(
      pattern, 2, 0, 4, 44100, 64, false, 'spike-h3',
    );
    out.returnedType = typeof returned;
    out.returnedValue = returned === undefined ? 'undefined' : String(returned);
    out.liveCtxStateAfter = live.state;
    out.liveCtxClosed = live.state === 'closed';

    // Побочные эффекты: renderPatternAudio в finally делает setAudioContext(null).
    const after = strudel.getAudioContext();
    out.globalCtxReplaced = after !== live;
    out.globalCtxState = after ? after.state : null;

    out.capturedBuffer = capturedBuffer
      ? { frames: capturedBuffer.length, channels: capturedBuffer.numberOfChannels, sampleRate: capturedBuffer.sampleRate }
      : null;
    out.downloads = downloads;
    out.wavBlobType = wavBlob ? wavBlob.type : null;
    out.wavBlobSize = wavBlob ? wavBlob.size : null;
  } catch (err) {
    out.error = String((err && err.message) || err);
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
    URL.createObjectURL = originalCreateObjectURL;
    OfflineAudioContext.prototype.startRendering = originalStartRendering;
  }
  return out;
}

// --------------------------------------------------------------------------------------
// H5: позиция воспроизведения (scheduler.now() против ctx.currentTime).
// --------------------------------------------------------------------------------------

async function runH5() {
  const out = { hypothesis: 'H5', rows: [] };
  const ctx = new AudioContext();
  const repl = strudel.webaudioRepl({ audioContext: ctx });
  strudel.registerSynthSounds();
  await ctx.resume();
  await repl.scheduler.setPattern(strudel.s('sawtooth').note('c3'), true);
  await sleep(300);

  for (let i = 0; i < 10; i += 1) {
    out.rows.push({
      i,
      state: ctx.state,
      currentTime: round(ctx.currentTime, 6),
      schedulerNow: round(repl.scheduler.now(), 6),
      baseLatency: round(ctx.baseLatency, 6),
      outputLatency: round(ctx.outputLatency, 6),
    });
    await sleep(200);
  }

  out.cps = repl.scheduler.cps;
  out.schedulerNowUnit = 'cycles (cyclist: now() возвращает lastBegin + t*cps)';
  const diffs = out.rows.map((r) => r.schedulerNow - r.currentTime);
  const diffsSec = out.rows.map((r) => (out.cps ? r.schedulerNow / out.cps : 0) - r.currentTime);
  out.diffRaw = { mean: round(mean(diffs), 6), min: round(Math.min(...diffs), 6), max: round(Math.max(...diffs), 6) };
  out.diffConvertedSeconds = {
    mean: round(mean(diffsSec), 6),
    min: round(Math.min(...diffsSec), 6),
    max: round(Math.max(...diffsSec), 6),
  };
  out.baseLatency = out.rows[0].baseLatency;
  out.outputLatency = out.rows[0].outputLatency;
  out.clockDuration = repl.scheduler.clock && repl.scheduler.clock.duration
    ? repl.scheduler.clock.duration
    : null;
  try {
    await ctx.close();
  } catch (_) { /* ignore */ }
  return out;
}

function mean(a) {
  return a.reduce((s, v) => s + v, 0) / (a.length || 1);
}

// --------------------------------------------------------------------------------------
// H8: банки сэмплов (манифесты + реальная загрузка файлов).
// --------------------------------------------------------------------------------------

async function runH8() {
  const out = { hypothesis: 'H8', sets: [] };
  for (const source of ['github:tidalcycles/dirt-samples', 'shabda:piano']) {
    const t0 = performance.now();
    const rec = { source };
    try {
      const ret = await strudel.samples(source);
      rec.ok = true;
      rec.ms = round(performance.now() - t0, 1);
      rec.returnedType = typeof ret;
      rec.returnedValue = ret === undefined ? 'undefined' : String(ret);
    } catch (err) {
      rec.ok = false;
      rec.ms = round(performance.now() - t0, 1);
      rec.error = String((err && err.message) || err);
    }
    out.sets.push(rec);
  }

  // Какие имена палитры проекта реально зарегистрированы.
  const present = [];
  const missing = [];
  for (const name of PROJECT_PALETTE) {
    const sound = strudel.getSound(name);
    if (sound) {
      const samples = sound.data && sound.data.samples;
      present.push({ name, urls: samples ? sampleUrls(samples) : null });
    } else {
      missing.push(name);
    }
  }
  out.palettePresent = present.map((p) => p.name);
  out.paletteMissing = missing;
  out.paletteUrls = present;

  // Фактическая загрузка аудиофайлов: триггерим сэмплы в живом контексте.
  const ctx = new AudioContext();
  strudel.setAudioContext(ctx);
  strudel.registerSynthSounds();
  await strudel.initAudio({ maxPolyphony: 32 });
  const trigger = [];
  for (const name of ['bd', '808bd', 'piano']) {
    const t0 = performance.now();
    const sound = strudel.getSound(name);
    if (!sound) {
      trigger.push({ name, ok: false, error: 'нет такого имени в soundMap' });
      continue;
    }
    try {
      await strudel.superdough({ s: name }, ctx.currentTime + 1.5, 0.25, 0.5, 0);
      trigger.push({ name, ok: true, ms: round(performance.now() - t0, 1) });
    } catch (err) {
      trigger.push({ name, ok: false, error: String((err && err.message) || err) });
    }
  }
  out.triggers = trigger;
  await sleep(1500);
  try {
    await ctx.close();
  } catch (_) { /* ignore */ }
  return out;
}

function sampleUrls(samples) {
  if (Array.isArray(samples)) return samples.slice(0, 3);
  if (samples && typeof samples === 'object') return Object.values(samples).slice(0, 3);
  return null;
}

// --------------------------------------------------------------------------------------
// H9: DynamicsCompressorNode против нашего LookaheadLimiter.
// --------------------------------------------------------------------------------------

function makeTone(sr, seconds, freq, amp) {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function makeBursts(sr, seconds, freq, amp, burstSec, periodSec) {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  const burst = Math.round(sr * burstSec);
  const period = Math.round(sr * periodSec);
  for (let i = 0; i < n; i += 1) {
    const inBurst = i % period < burst;
    out[i] = inBurst ? amp * Math.sin((2 * Math.PI * freq * i) / sr) : 0;
  }
  return out;
}

function peakOf(arr) {
  let p = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const a = arr[i] < 0 ? -arr[i] : arr[i];
    if (a > p) p = a;
  }
  return p;
}

function rmsOf(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i += 1) s += arr[i] * arr[i];
  return Math.sqrt(s / (arr.length || 1));
}

// Задержка сигнала: лаг (в отсчётах), при котором вход и выход совпадают лучше всего.
function bestLag(input, output, maxLag, winLen) {
  let best = -Infinity;
  let bestL = 0;
  const n = Math.min(winLen, input.length - maxLag);
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += input[i] * output[i + lag];
    if (s > best) {
      best = s;
      bestL = lag;
    }
  }
  return bestL;
}

async function runH9() {
  const sr = 48000;
  const out = { hypothesis: 'H9', sampleRate: sr, signals: {} };

  const signals = {
    sine1k0db: { data: makeTone(sr, 1, 1000, 1.0), label: 'ровный синус 1 кГц, пик 0 dBFS' },
    bursts: {
      data: makeBursts(sr, 1, 1000, 1.0, 0.02, 0.25),
      label: 'всплески 1 кГц 20 мс раз в 250 мс, пик 0 dBFS',
    },
    singleBurst: {
      data: makeBursts(sr, 0.5, 1000, 1.0, 0.02, 10),
      label: 'один всплеск 1 кГц 20 мс (непериодичный — для замера задержки)',
    },
  };

  for (const [key, sig] of Object.entries(signals)) {
    const input = sig.data;
    const inputStats = {
      peak: round(peakOf(input)),
      peakDb: round(dbfs(peakOf(input)), 3),
      rms: round(rmsOf(input)),
      rmsDb: round(dbfs(rmsOf(input)), 3),
    };

    // --- DynamicsCompressorNode ---
    const off = new OfflineAudioContext(2, input.length, sr);
    const buf = off.createBuffer(1, input.length, sr);
    buf.copyToChannel(input, 0);
    const src = new AudioBufferSourceNode(off, { buffer: buf });
    const comp = new DynamicsCompressorNode(off, {
      threshold: -3,
      knee: 0,
      ratio: 20,
      attack: 0.001,
      release: 0.05,
    });
    src.connect(comp);
    comp.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    const compOut = rendered.getChannelData(0);
    const compPeak = peakOf(compOut);
    // Задержку меряем только на непериодичном сигнале: для синуса корреляция
    // периодична, и лаг определяется с точностью до периода.
    const compLag = key === 'singleBurst' ? bestLag(input, compOut, 2000, 4800) : null;

    // --- наш LookaheadLimiter (JS, без Web Audio) ---
    const limiter = new LookaheadLimiter(sr, { ceilingDb: -1, lookaheadMs: 5, releaseMs: 80, attackMs: 0.5 });
    const [outL, outR] = limiter.process(input, input);
    const limPeak = peakOf(outL);
    const limLag = key === 'singleBurst' ? bestLag(input, outL, 2000, 4800) : null;

    out.signals[key] = {
      label: sig.label,
      input: inputStats,
      compressor: {
        thresholdDb: -3,
        ratio: 20,
        attack: 0.001,
        release: 0.05,
        outPeak: round(compPeak),
        outPeakDb: round(dbfs(compPeak), 3),
        outRmsDb: round(dbfs(rmsOf(compOut)), 3),
        overshootOverThresholdDb: round(dbfs(compPeak) - (-3), 3),
        lagSamples: compLag,
        lagMs: compLag === null ? null : round((compLag / sr) * 1000, 3),
      },
      lookaheadLimiter: {
        ceilingDb: -1,
        outPeak: round(limPeak),
        outPeakDb: round(dbfs(limPeak), 3),
        outRmsDb: round(dbfs(rmsOf(outL)), 3),
        overshootOverCeilingDb: round(dbfs(limPeak) - (-1), 3),
        gainReductionDb: round(dbfs(limPeak) - dbfs(peakOf(input)), 3),
        lagSamples: limLag,
        lagMs: limLag === null ? null : round((limLag / sr) * 1000, 3),
        lookaheadSamples: limiter.latencySamples,
        lookaheadMs: round((limiter.latencySamples / sr) * 1000, 3),
      },
    };
  }

  out.verdict = {
    compressorIsBrickwall: out.signals.sine1k0db.compressor.overshootOverThresholdDb <= 0
      && out.signals.bursts.compressor.overshootOverThresholdDb <= 0,
    limiterIsBrickwall:
      out.signals.sine1k0db.lookaheadLimiter.outPeakDb <= -1 + 0.05 &&
      out.signals.bursts.lookaheadLimiter.outPeakDb <= -1 + 0.05,
  };
  return out;
}

// --------------------------------------------------------------------------------------

window.__spike = {
  ready: !!strudel,
  h1: runH1,
  h3Determinism: runH3Determinism,
  h3Official: runH3Official,
  h5: runH5,
  h8: runH8,
  h9: runH9,
  versions: {
    strudelWeb: '1.3.0',
    ua: navigator.userAgent,
  },
};

const status = document.getElementById('status');
if (status) status.textContent = strudel ? 'бандл загружен, измерения доступны' : 'БАНДЛ НЕ ЗАГРУЗИЛСЯ';
