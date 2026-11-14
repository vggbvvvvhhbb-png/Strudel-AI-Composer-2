// Намерение → Composition IR.
//
// Это точка входа для LLM: модель получает схему IR и возвращает JSON,
// который здесь превращается в валидный план. Планировщик на тексте —
// детерминированная замена LLM, пока та не подключена (спринт S3.2).
//
// Правила разбора настроения живут в `emotion.js`, жанровые параметры —
// здесь. Значения взяты из жанровых карт скил-пака.

import { parseMood, compileEmotion } from './emotion.js';
import { PROGRESSIONS } from './harmony.js';
import { planSections } from './arrangement.js';
import { random01 } from './prng.js';

/** Жанровые параметры: диапазон темпа, арка, грув, ключ, смена аккорда. */
export const GENRES = {
  'trip-hop': {
    bpm: [70, 92], defaultBpm: 82, arc: 'slow-burn-48', groove: 'drunken',
    swing: 0.56, chordBars: 2, style: 'lo-fi',
    key: { tonic: 'D', mode: 'minor' },
  },
  lofi: {
    bpm: [72, 86], defaultBpm: 78, arc: 'song-64', groove: 'swing',
    swing: 0.56, chordBars: 1, style: 'lo-fi',
    key: { tonic: 'Eb', mode: 'major' },
  },
  synthpop: {
    bpm: [105, 128], defaultBpm: 118, arc: 'song-64', groove: 'straight',
    swing: 0.5, chordBars: 1, style: 'synthwave',
    key: { tonic: 'A', mode: 'minor' },
  },
  dnb: {
    bpm: [168, 178], defaultBpm: 174, arc: 'club-64', groove: 'halftime',
    swing: 0.5, chordBars: 2, style: 'synthwave',
    key: { tonic: 'D', mode: 'minor' },
  },
  ambient: {
    bpm: [50, 70], defaultBpm: 60, arc: 'bloom-40', groove: 'straight',
    swing: 0.5, chordBars: 4, style: 'ambient',
    key: { tonic: 'C', mode: 'major' },
  },
};

/** Ключевые слова → жанр. */
export const GENRE_KEYWORDS = [
  ['dnb', ['dnb', 'днб', 'drum and bass', 'drum&bass', 'фонк', 'funk', 'нейрофанк', 'neurofunk', 'jungle']],
  ['synthpop', ['синтипоп', 'synthpop', 'вечеринк', 'party', 'фестивал', 'festival', 'диско', 'disco', 'retrowave']],
  ['ambient', ['эмбиент', 'ambient', 'дрон', 'drone', 'космос', 'спейс', 'space',
    'эмбиентный', 'колыбельн', 'усыпля', 'медитац']],
  ['trip-hop', ['трип', 'trip', 'trip-hop', 'downtempo', 'даунтемпо', 'бристол']],
  ['lofi', ['лоуфай', 'lofi', 'lo-fi', 'лоу-фай', 'джаз', 'jazz', 'кассет', 'учёб', 'учеб', 'study', 'чилл', 'chill']],
];

/**
 * Определяет жанр по тексту запроса.
 * @param {string} text
 * @returns {{genre:string, explicit:boolean}}
 */
export function detectGenre(text) {
  const source = String(text || '').toLowerCase();
  for (const [genre, words] of GENRE_KEYWORDS) {
    for (const word of words) {
      if (source.includes(word)) return { genre, explicit: true };
    }
  }
  return { genre: 'lofi', explicit: false };
}

/**
 * Строит IR из свободного текста.
 *
 * @param {string} text запрос пользователя
 * @param {object} [options]
 * @param {number} [options.seed] зерно детерминизма
 * @param {string} [options.genre] жанр принудительно
 * @param {number} [options.bpm] темп принудительно
 * @returns {object} CompositionIR
 */
export function planIR(text, options = {}) {
  const seed = options.seed ?? hashSeed(text);
  const detected = options.genre ? { genre: options.genre, explicit: true } : detectGenre(text);
  const genre = GENRES[detected.genre] ? detected.genre : 'lofi';
  const params = GENRES[genre];

  const mood = parseMood(text);
  const emotion = compileEmotion(mood, { bpmRange: params.bpm });

  // Темп: жанровый диапазон, но запрос может увести.
  let bpm = options.bpm ?? emotion.bpm;
  bpm = Math.min(params.bpm[1], Math.max(params.bpm[0], Math.round(bpm)));
  // Явно заданный темп — закон команды: жанровый дефолт его не перебивает.
  // (Раньше `if (!mood.label) bpm = params.defaultBpm;` стоял ПОСЛЕ этого
  // присваивания и затирал запрошенный темп.)
  if (options.bpm === undefined && !mood.label) bpm = params.defaultBpm;

  // Ключ: жанровый, но мрачное настроение переводит мажор в минор.
  const key = { ...params.key };
  if ((mood.valence ?? 0) < -0.25 && key.mode === 'major' && genre !== 'ambient') {
    key.mode = 'minor';
  }

  const sections = planSections({ arc: params.arc, id: 'sec' });
  const progression = PROGRESSIONS[mood.label] || PROGRESSIONS.nostalgia;

  // Гармония секции: аккорды прокручиваются по прогрессии настроения.
  let step = 0;
  for (const section of sections) {
    const harmony = [];
    let bars = section.bars;
    while (bars > 0) {
      const rn = progression[step % progression.length];
      const color = colorFor(mood.label, rn, genre);
      const length = Math.min(bars, params.chordBars);
      harmony.push({ rn, color, bars: length });
      bars -= length;
      step += 1;
    }
    section.harmony = harmony;
  }

  const ir = {
    v: 1,
    seed,
    meta: {
      title: String(text || '').slice(0, 80) || 'Без названия',
      bpm,
      meter: '4/4',
      key,
      mood: {
        valence: mood.valence,
        arousal: mood.arousal,
        label: mood.label,
        modifiers: mood.modifiers,
      },
      genre,
      style: params.style,
    },
    palette: {},
    motifs: { hook: buildMotif(seed, mood) },
    sections,
    groove: {
      template: params.groove,
      amount: 1,
      swing: params.swing,
      offsetMs: 0,
    },
    mix: {
      sidechain: sidechainFor(genre),
      pan: {},
      orbit: {},
    },
  };

  // Плотность из эмоции влияет на вес ударных в активных секциях.
  applyDensity(ir, emotion.density);
  return ir;
}

/**
 * Цвет аккорда по настроению и жанру.
 * Джазовая окраска (9/13) — только для lofi и ностальгии.
 */
function colorFor(moodLabel, rn, genre) {
  if (genre === 'lofi' || moodLabel === 'nostalgia') {
    if (rn === 'I' || rn === 'IV') return 'add9';
    if (rn === 'V') return '7';
    return undefined;
  }
  if (moodLabel === 'melancholy' || moodLabel === 'dark') {
    return rn.startsWith('V') ? '7' : undefined;
  }
  if (moodLabel === 'euphoria' && (rn === 'I' || rn === 'IV')) return 'add9';
  return undefined;
}

/** Сайдчейн: кик дакит бас и аккорды — сердце танцевальных жанров. */
function sidechainFor(genre) {
  if (genre === 'synthpop') {
    return [
      { src: 'kick', dst: 'bass', depth: 0.8 },
      { src: 'kick', dst: 'chords', depth: 0.35 },
    ];
  }
  if (genre === 'dnb') {
    return [
      { src: 'kick', dst: 'bass', depth: 0.7 },
      { src: 'kick', dst: 'chords', depth: 0.3 },
    ];
  }
  if (genre === 'trip-hop') {
    return [{ src: 'kick', dst: 'bass', depth: 0.5 }];
  }
  return [];
}

/**
 * Мотив-хук: 4–6 нот, детерминированно по зерну.
 * Повторяемость — то, что делает трек запоминающимся (карта synthpop).
 *
 * Степени — ИНДЕКСЫ лада (0…6), а не полутоны: `n("8")` в Strudel — это уже
 * октава тоники, а не септима.
 */
function buildMotif(seed, mood) {
  const degrees = [];
  const steps = [];
  const count = 4 + Math.floor(random01(seed, 'motif', 'count') * 3);
  let step = 0;
  for (let i = 0; i < count; i += 1) {
    degrees.push(Math.floor(random01(seed, 'motif', i) * 7));
    steps.push(step);
    // Ритм: чаще шестнадцатые, иногда с паузой.
    const gap = random01(seed, 'motif', 'gap', i) < 0.3 ? 3 : 2;
    step += gap;
    if (step > 14) break;
  }
  return { degrees, steps };
}

/**
 * Плотность эмоции переводится в вес ударных: чем выше arousal, тем плотнее.
 *
 * Шкала непрерывная и не «процент шагов»: полный шаблон грува — это уже
 * устоявшийся ритм, его нельзя выкашивать в ноль. Диапазон 0.55…1 означает
 * «шаблон целиком» … «шаблон с третью-четвертью шагов».
 */
function applyDensity(ir, density) {
  const target = Math.min(1, Math.max(0.55, 0.45 + density / 16));
  for (const section of ir.sections) {
    for (const role of ['kick', 'snare', 'hats']) {
      const layer = section.layers[role];
      if (!layer) continue;
      layer.density = target;
    }
  }
}

/** Стабильный seed из текста — без случайности. */
export function hashSeed(text) {
  let hash = 0x811c9dc5;
  const source = String(text || '');
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash & 0x7fffffff) >>> 0;
}
