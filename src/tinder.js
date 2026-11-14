// Страница суждения: «Тиндер» для человеческих меток (дорожка H).
//
// Что здесь важно для честности сравнения:
//   • громкость выровнена ТОЛЬКО гейном (без лимитера) — иначе «громче»
//     читается как «лучше» (§7.2, замечание 10 аудита);
//   • стороны A/B переставлены случайно при каждом показе;
//   • метки скрыты, промпт показан (оценивать музыку, а не загадку);
//   • каждая десятая пара — повтор с переставленными сторонами: из этого
//     считается надёжность рецензента.
//
// Рендер делает браузер тем же движком, что и студия: пара — это два кода
// из очереди /api/preference/queue.

import './styles/tokens.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/tinder.css';

import { initEngine, renderTrackOffline, unlockAudio } from './strudel-engine.js';
import { measureLoudness, measurePeakDbfs, measureCrestDb } from './audio/dsp/loudness.js';
import { measureTruePeak } from './audio/dsp/truepeak.js';

const els = {
  start: document.getElementById('btn-start'),
  replay: document.getElementById('btn-replay'),
  status: document.getElementById('status'),
  prompt: document.getElementById('prompt'),
  progress: document.getElementById('progress'),
  log: document.getElementById('log'),
};

/** Сколько тактов рендерим на пару: 16 тактов ≈ 8–10 с на 120 BPM. */
const BARS = 16;
/** Сколько пар берём за раз. */
const QUEUE_SIZE = 20;

let queue = [];
let index = 0;
let current = null;
let audioCtx = null;
let playing = false;
let listenStart = 0;
let listenMs = 0;
let activeSource = null;

/**
 * Сообщение в статусной строке.
 * @param {string} text
 */
function say(text) {
  els.status.textContent = text;
}

/**
 * Контекст для воспроизведения.
 * @returns {AudioContext}
 */
function context() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

/**
 * Каналы → AudioBuffer для воспроизведения.
 * @param {Float64Array[]} channels
 * @param {number} sampleRate
 * @returns {AudioBuffer}
 */
function toBuffer(channels, sampleRate) {
  const ctx = context();
  const buffer = ctx.createBuffer(
    Math.max(1, channels.length),
    channels[0]?.length ?? 0,
    sampleRate,
  );
  for (const [index, channel] of channels.entries()) {
    buffer.copyToChannel(Float32Array.from(channel), index);
  }
  return buffer;
}

/**
 * Выравнивание громкости по гейну: оба трека приводятся к тихому из двух.
 * Только гейн — лимитер и компрессор тут были бы подменой измерения.
 *
 * @param {{lufs:number}} a
 * @param {{lufs:number}} b
 * @returns {{a:number, b:number, target:number}}
 */
function alignLoudness(a, b) {
  const finite = (value) => (Number.isFinite(value) ? value : -70);
  const target = Math.min(finite(a.lufs), finite(b.lufs));
  const gainOf = (lufs) => {
    const db = target - finite(lufs);
    if (!Number.isFinite(db) || db <= 0) return 1;
    return Math.min(1, Math.pow(10, db / 20));
  };
  return { a: gainOf(a.lufs), b: gainOf(b.lufs), target };
}

/**
 * Сколько отсчётов клиппинговалось (|x| ≥ 1).
 * @param {Float64Array[]} channels
 * @returns {number}
 */
function countClips(channels) {
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      if (Math.abs(channel[i]) >= 1) count += 1;
    }
  }
  return count;
}

/**
 * Рендер кандидата: код → каналы, аудио-признаки и AudioBuffer.
 *
 * Признаки (L0) нужны не для показа, а для обучения: без них метка
 * «победил вот этот» не с чем сравнить, и выученная цель остаётся
 * невозможной (см. server/preference/ledger.js).
 *
 * @param {{code:string}} candidate
 * @returns {Promise<{buffer:AudioBuffer, lufs:number, audio:object}>}
 */
async function renderCandidate(candidate) {
  const result = await renderTrackOffline({
    code: candidate.code,
    bars: [0, BARS],
    sampleRate: 48000,
    runs: 1,
  });
  const loudness = measureLoudness(result.channels, result.sampleRate);
  const peak = measureTruePeak(result.channels, result.sampleRate);
  const audio = {
    lufsI: loudness.lufsI,
    lufsS: loudness.lufsS ?? null,
    truePeakDbtp: peak.truePeakDb,
    peakDbfs: measurePeakDbfs(result.channels),
    crestDb: measureCrestDb(result.channels),
    clipCount: countClips(result.channels),
  };
  return { buffer: toBuffer(result.channels, result.sampleRate), lufs: loudness.lufsI, audio };
}

/**
 * Проигрывание буфера с заданным гейном и позицией в стерео.
 *
 * Позиция нужна для слепого сравнения: трек A звучит слева, B — справа
 * (или наоборот — это выпадает случайно). Панорама двигает готовую
 * стерео-картинку целиком и не трогает её содержимое.
 *
 * @param {AudioBuffer} buffer
 * @param {number} gain линейный гейн выравнивания
 * @param {number} pan −1 (слева) … +1 (справа)
 * @returns {AudioBufferSourceNode}
 */
function play(buffer, gain, pan) {
  const ctx = context();
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gainNode = ctx.createGain();
  gainNode.gain.value = gain;

  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;

  source.connect(gainNode);
  gainNode.connect(panner);
  panner.connect(ctx.destination);
  source.start();

  playing = true;
  listenStart = performance.now();
  source.onended = () => {
    playing = false;
    listenMs = Math.round(performance.now() - listenStart);
  };
  activeSource = source;
  return source;
}

/** Остановить текущий звук (перед следующей парой). */
function stopPlayback() {
  if (activeSource) {
    try {
      activeSource.stop();
    } catch {
      /* уже остановился */
    }
    activeSource = null;
  }
  playing = false;
}

/**
 * Показ текущей пары: рендер двух кандидатов и проигрывание.
 */
async function showCurrent() {
  stopPlayback();
  if (index >= queue.length) {
    say('Очередь закончилась. Спасибо — метки сохранены.');
    els.progress.textContent = `${queue.length} / ${queue.length}`;
    els.replay.disabled = true;
    return;
  }
  const pair = queue[index];
  current = pair;
  els.prompt.textContent = pair.prompt;
  els.progress.textContent = `${index} / ${queue.length}`;
  say('Готовим пару: рендерим оба варианта…');

  try {
    const [a, b] = await Promise.all([
      renderCandidate(pair.a),
      renderCandidate(pair.b),
    ]);
    const gains = alignLoudness(a, b);
    current.buffers = { a: a.buffer, b: b.buffer };
    current.audio = { a: a.audio, b: b.audio };
    current.gains = gains;
    // Куда уходит A — выпадает случайно при каждом показе пары.
    current.aOnLeft = Math.random() < 0.5;

    play(a.buffer, gains.a, current.aOnLeft ? -1 : 1);
    els.replay.disabled = false;
    say(`Слушайте. Громкость выровнена (цель ${gains.target.toFixed(1)} LUFS). `
      + 'Клавиши: ← лучше A, → лучше B, ↓ ничья, Space — ещё раз.');
  } catch (err) {
    say(`Не удалось подготовить пару: ${err?.message || err}`);
  }
}

/**
 * Запись суждения.
 * @param {'A'|'B'|'tie'} winner
 */
async function judge(winner) {
  if (!current) return;
  const pair = current;
  const payload = {
    pairId: pair.id,
    winner,
    listenMs: listenMs || Math.round(performance.now() - listenStart),
    prompt: pair.prompt,
    seed: pair.seed,
    hashA: pair.a.hash,
    hashB: pair.b.hash,
    // Повторная пара (те же треки, стороны переставлены) — по ней считается
    // надёжность рецензента.
    swapped: Boolean(pair.repeat),
    source: 'explicit',
    // Аудио-признаки обеих сторон: без них метку нельзя превратить в
    // обучающий пример (см. server/preference/ledger.js).
    audio: current.audio ? { a: current.audio.a, b: current.audio.b } : undefined,
  };
  stopPlayback();
  try {
    await fetch('/api/preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    say('Метка не отправилась — проверьте соединение.');
    return;
  }
  const item = document.createElement('li');
  item.textContent = `${pair.prompt} → ${winner === 'tie' ? 'ничья' : winner}`;
  els.log.prepend(item);
  index += 1;
  current = null;
  await showCurrent();
}

/** Загрузка очереди. */
async function loadQueue() {
  const response = await fetch(`/api/preference/queue?limit=${QUEUE_SIZE}`);
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'очередь недоступна');
  queue = data.pairs ?? [];
}

els.start.addEventListener('click', async () => {
  els.start.disabled = true;
  say('Готовим студию…');
  try {
    await unlockAudio();
    initEngine(null);
    await loadQueue();
    await showCurrent();
  } catch (err) {
    say(`Не удалось начать: ${err?.message || err}`);
    els.start.disabled = false;
  }
});

els.replay.addEventListener('click', () => {
  if (!current?.buffers) return;
  play(current.buffers.a, current.gains.a, current.aOnLeft ? -1 : 1);
});

document.addEventListener('keydown', (event) => {
  if (!current) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    judge('A');
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    judge('B');
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    judge('tie');
  } else if (event.key === ' ') {
    event.preventDefault();
    els.replay.click();
  }
});
