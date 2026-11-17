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

import { getEngine } from './engine-loader.js';
import { measureLoudness, measurePeakDbfs, measureCrestDb } from './audio/dsp/loudness.js';
import { measureTruePeak } from './audio/dsp/truepeak.js';

const els = {
  start: document.getElementById('btn-start'),
  replay: document.getElementById('btn-replay'),
  skip: document.getElementById('btn-skip'),
  mode: document.getElementById('pair-mode'),
  status: document.getElementById('status'),
  prompt: document.getElementById('prompt'),
  context: document.getElementById('pair-context'),
  progress: document.getElementById('progress'),
  log: document.getElementById('log'),
};

/**
 * Сколько тактов рендерим на пару.
 *
 * 8 тактов при 120 BPM — это 16 секунд на сторону: достаточно, чтобы услышать
 * ритм, гармонию и характер трека, но не настолько долго, чтобы «6 минут в
 * день» превратились в «20 минут ожидания рендера». Длинный фрагмент к
 * выбору «лучше / хуже» ничего не добавляет.
 */
const BARS = 8;
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
// Загрузились ли сэмплы. Без них трек звучит не тем, что нарисован, и
// сравнение получается неполным — такие метки помечаются как degraded.
let samplesOk = true;
// Покрытие промтов: сколько РАЗНЫХ промтов закрыто суждениями (приёмка
// §7.2 требует 50). Число приходит с сервера — оно единственно честное.
let coverage = { uniquePrompts: 0, promptsNeeded: 50 };
// Сессия рецензента: её выдаёт сервер вместе с очередью. Без неё метка
// не будет принята как человеческая — сервер проверяет, что пара была
// показана именно этой сессии (server/preference/session.js).
let sessionId = null;
// Тип очереди (D-132): 'track' — композиция, 'timbre' — одна и та же
// партия с двумя instrumentId. Тембровые метки не закрывают промты
// корпуса: их прогресс считается отдельно.
let mode = 'track';
let started = false;
let timbreJudged = 0;

const FAMILY_LABELS = { keys: 'клавишные', strings: 'струнные', bass: 'бас' };

/**
 * Строка прогресса: сколько пар пройдено и сколько разных промтов закрыто.
 */
function updateProgress() {
  els.progress.textContent = mode === 'timbre'
    ? `${index} / ${queue.length} · тембров ${timbreJudged}`
    : `${index} / ${queue.length}`
      + ` · промтов ${coverage.uniquePrompts}/${coverage.promptsNeeded}`;
}

/**
 * Обновляет покрытие промтов с сервера (после каждой метки).
 *
 * Считать на клиенте нельзя: повторная пара закрывает тот же промт, что уже
 * закрыт, и наивный счёт завысил бы прогресс — а это приёмочный счётчик.
 *
 * @returns {Promise<void>}
 */
async function refreshCoverage() {
  try {
    const response = await fetch('/api/preference/stats');
    const data = await response.json();
    if (Number.isFinite(data?.timbreJudged)) timbreJudged = data.timbreJudged;
    if (Number.isFinite(data?.uniquePrompts)) {
      coverage = {
        uniquePrompts: data.uniquePrompts,
        promptsNeeded: data.promptsNeeded ?? coverage.promptsNeeded,
      };
    }
    updateProgress();
  } catch {
    /* прогресс не критичен — не мешаем суждению */
  }
}

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
  const { renderTrackOffline } = await getEngine();
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
    updateProgress();
    els.replay.disabled = true;
    els.skip.disabled = true;
    return;
  }
  const pair = queue[index];
  current = pair;
  els.prompt.textContent = pair.prompt;
  // Тембровая пара (D-132): контекст партии виден, имена пресетов скрыты —
  // стороны переставлены, оценивается звук, а не название инструмента.
  if (pair.type === 'timbre') {
    els.context.hidden = false;
    els.context.textContent = `Партия ${pair.role} · ${FAMILY_LABELS[pair.family] ?? pair.family} · стиль ${pair.style}. `
      + 'Музыкальная партия одна и та же — меняется только инструмент.';
  } else {
    els.context.hidden = true;
    els.context.textContent = '';
  }
  updateProgress();
  say('Готовим пару: рендерим оба варианта…');

  try {
    // Стороны рендерятся ПОСЛЕДОВАТЕЛЬНО, а не параллельно: оффлайн-рендер
    // переключает глобальный аудиоконтекст движка, и два рендера «в одном
    // флаконе» перехватывают контекст друг у друга. На выходе был тихий
    // трек (громкость по −70 LUFS) и ошибки «разные аудиоконтексты».
    const a = await renderCandidate(pair.a);
    const b = await renderCandidate(pair.b);
    const gains = alignLoudness(a, b);
    current.buffers = { a: a.buffer, b: b.buffer };
    current.audio = { a: a.audio, b: b.audio };
    current.gains = gains;
    // Куда уходит A — выпадает случайно при каждом показе пары.
    current.aOnLeft = Math.random() < 0.5;

    play(a.buffer, gains.a, current.aOnLeft ? -1 : 1);
    els.replay.disabled = false;
    els.skip.disabled = false;
    const degradedNote = samplesOk
      ? ''
      : ' ВНИМАНИЕ: сэмплы не загрузились — треки неполные, такая метка не попадёт в обучение.';
    say(`Слушайте. Громкость выровнена (цель ${gains.target.toFixed(1)} LUFS). `
      + 'Клавиши: ← лучше A, → лучше B, ↓ ничья, ↑ ни один, Space — ещё раз.' + degradedNote);
  } catch (err) {
    say(`Не удалось подготовить пару: ${err?.message || err}`);
  }
}

/**
 * Запись суждения.
 * @param {'A'|'B'|'tie'|'skip'} winner
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
    // Канал: сервер принимает человеческую метку только со страницы суждения.
    channel: 'tinder',
    // Сессия рецензента (выдана сервером вместе с очередью).
    sessionId,
    // Тип пары (D-132): тембровые метки не входят в гейт композиции.
    ...(pair.type === 'timbre' ? { pairType: 'timbre' } : {}),
    // Аудио-признаки обеих сторон: без них метку нельзя превратить в
    // обучающий пример (см. server/preference/ledger.js).
    audio: current.audio ? { a: current.audio.a, b: current.audio.b } : undefined,
    // Рендер без сэмплов — сравнение неполное (нет ударных и пианино).
    // Такая метка помечается, чтобы не попасть в обучение (см. dataset.js).
    // То же — если звук вообще не удалось измерить: сравнивать нечего.
    degraded: !samplesOk || !current.audio,
  };
  stopPlayback();
  try {
    const response = await fetch('/api/preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // Ответ сервера проверяем: раньше ошибка 400 молча терялась, и
    // рецензент думал, что метка записана.
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      say(`Метка не записана: ${detail.error || response.status}`);
      return;
    }
  } catch {
    say('Метка не отправилась — проверьте соединение.');
    return;
  }
  const item = document.createElement('li');
  const verdict = winner === 'tie' ? 'ничья' : winner === 'skip' ? 'ни один' : winner;
  item.textContent = `${pair.prompt} → ${verdict}`;
  els.log.prepend(item);
  index += 1;
  current = null;
  // Покрытие промтов обновляем с сервера: клиентский счёт завышал бы
  // прогресс на повторных парах.
  await refreshCoverage();
  await showCurrent();
}

/** Загрузка очереди выбранного типа (треки или тембры). */
async function loadQueue() {
  const response = await fetch(`/api/preference/queue?limit=${QUEUE_SIZE}&type=${mode}`);
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'очередь недоступна');
  queue = data.pairs ?? [];
  // Сессия рецензента выдаётся вместе с очередью и уходит с каждой меткой.
  sessionId = data.sessionId ?? null;
  if (data.coverage) {
    coverage = {
      uniquePrompts: data.coverage.uniquePrompts ?? coverage.uniquePrompts,
      promptsNeeded: data.coverage.promptsNeeded ?? coverage.promptsNeeded,
    };
    if (Number.isFinite(data.coverage.timbreJudged)) timbreJudged = data.coverage.timbreJudged;
  }
}

els.start.addEventListener('click', async () => {
  els.start.disabled = true;
  started = true;
  say('Готовим студию…');
  try {
    const { unlockAudio, initEngine, ensureSamples } = await getEngine();
    await unlockAudio();
    initEngine(null);
    // Сэмплы грузим ДО рендера: без них ударные и пианино молчат, и
    // сравнение двух «половинок» трека бессмысленно.
    try {
      samplesOk = await ensureSamples();
    } catch (error) {
      samplesOk = false;
      console.warn('Сэмплы не загрузились:', error?.message || error);
    }
    if (!samplesOk) {
      say('Сэмплы не загрузились (сеть или CDN). Треки прозвучат неполно — '
        + 'такие метки не попадут в обучение. Попробуйте позже.');
    }
    await loadQueue();
    await showCurrent();
  } catch (err) {
    say(`Не удалось начать: ${err?.message || err}`);
    els.start.disabled = false;
    started = false;
  }
});

// Смена типа очереди: тембры — одна и та же партия с двумя instrumentId
// (D-132). Сессия и очередь запрашиваются заново: старые pairId в новой
// сессии не обслуживались, и метка по ним не прошла бы проверку сервера.
els.mode?.addEventListener('change', async () => {
  mode = els.mode.value === 'timbre' ? 'timbre' : 'track';
  stopPlayback();
  queue = [];
  index = 0;
  current = null;
  els.replay.disabled = true;
  els.skip.disabled = true;
  updateProgress();
  if (!started) {
    say(mode === 'timbre'
      ? 'Тембры: одна и та же партия, два инструмента. Нажмите «Начать».'
      : 'Нажмите «Начать» — браузер спросит разрешение на звук.');
    return;
  }
  say('Загружаем очередь…');
  try {
    await loadQueue();
    await showCurrent();
  } catch (err) {
    say(`Очередь не загрузилась: ${err?.message || err}`);
  }
});

els.skip.addEventListener('click', () => judge('skip'));

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
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    judge('skip');
  } else if (event.key === ' ') {
    event.preventDefault();
    els.replay.click();
  }
});
