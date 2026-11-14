// Эмоция → музыкальные параметры.
//
// Настроение в IR хранится непрерывно (valence/arousal), а не как одно из
// десяти имён: так «мрачно, но живо» не разваливается на ложный выбор.
//
// Слой делает три вещи:
//   1. разбирает свободный текст запроса в пару (valence, arousal) + ярлык;
//   2. по паре выбирает лад, темп, плотность, регистр и артикуляцию;
//   3. выбирает гармоническую прогрессию по настроению.
//
// Источники: skills/emotion-map.md, skills/harmony-recipes.md.

/**
 * Таблица настроений. Значения — из карты emotion-map (v1).
 * register — MIDI-номер опорной ноты: c2=36, c3=48, c4=60.
 */
export const MOODS = {
  joy: {
    valence: 0.7, arousal: 0.6, mode: 'major', bpm: [112, 128],
    density: [8, 14], register: 60, articulation: 'staccato',
    progression: ['I', 'V', 'vi', 'IV'],
  },
  euphoria: {
    valence: 0.8, arousal: 0.9, mode: 'lydian', bpm: [124, 140],
    density: [10, 16], register: 60, articulation: 'gated',
    progression: ['I', 'V', 'vi', 'IV'],
  },
  tender: {
    valence: 0.5, arousal: -0.4, mode: 'major', bpm: [66, 84],
    density: [1, 4], register: 60, articulation: 'legato',
    progression: ['I', 'vi', 'IV', 'V'],
  },
  hope: {
    valence: 0.4, arousal: 0.1, mode: 'major', bpm: [90, 110],
    density: [4, 8], register: 60, articulation: 'legato',
    progression: ['vi', 'IV', 'I', 'V'],
  },
  nostalgia: {
    valence: 0.1, arousal: -0.3, mode: 'dorian', bpm: [72, 92],
    density: [4, 8], register: 60, articulation: 'soft',
    progression: ['ii', 'V', 'I', 'I'],
  },
  melancholy: {
    valence: -0.4, arousal: -0.5, mode: 'minor', bpm: [70, 92],
    density: [3, 7], register: 48, articulation: 'legato',
    progression: ['i', 'VI', 'III', 'VII'],
  },
  dark: {
    valence: -0.7, arousal: -0.2, mode: 'phrygian', bpm: [70, 95],
    density: [4, 8], register: 36, articulation: 'dragging',
    progression: ['i', 'iv', 'VI', 'V'],
  },
  anxiety: {
    valence: -0.6, arousal: 0.6, mode: 'phrygian', bpm: [118, 140],
    density: [6, 12], register: 48, articulation: 'ragged',
    progression: ['i', 'bII'],
  },
  anger: {
    valence: -0.7, arousal: 0.9, mode: 'minor', bpm: [128, 150],
    density: [10, 18], register: 36, articulation: 'harsh',
    progression: ['i', 'VI', 'V', 'V'],
  },
  void: {
    valence: -0.2, arousal: -0.8, mode: 'locrian', bpm: [50, 66],
    density: [0.5, 2], register: 72, articulation: 'sustained',
    progression: ['I', 'IV'],
  },
};

/**
 * Шкала яркости лада: от светлого к тёмному.
 * valence выбирает позицию на этой шкале.
 */
export const BRIGHTNESS_SCALE = [
  'lydian', 'major', 'mixolydian', 'dorian', 'minor', 'phrygian', 'locrian',
];

/**
 * Словарь запроса → настроение.
 * Порядок важен: побеждает ПОСЛЕДНЕЕ совпадение в тексте.
 */
export const MOOD_KEYWORDS = [
  ['void', ['пустот', 'космос', 'холод', 'медитац', 'сон', 'бесконечн', 'ambient', 'эмбиент']],
  ['anger', ['зл', 'агресс', 'ярост', 'фонк', 'жёстк', 'жестк', 'бешен', 'angry', 'rage']],
  ['anxiety', ['тревог', 'паник', 'напряж', 'саспенс', 'нервн', 'тревожн', 'anxious', 'nervous']],
  ['dark', ['мрачн', 'тёмн', 'темн', 'ночь', 'зловещ', 'мрач', 'dark', 'grim']],
  ['melancholy', ['меланхол', 'груст', 'осень', 'дождь', 'тоск', 'sad', 'melanchol']],
  ['nostalgia', ['ностальг', 'кассет', 'детств', 'ретро', 'учёба', 'учеба', 'студ', 'nostalg', 'lofi', 'vintage']],
  ['hope', ['надежд', 'вдохнов', 'рассвет', 'hope', 'inspir']],
  ['tender', ['нежн', 'колыбельн', 'тепл', 'уют', 'tender', 'soft', 'calm', 'спокойн']],
  ['euphoria', ['эйфори', 'экстаз', 'драйв', 'euphor', 'rave', 'клубн']],
  ['joy', ['радост', 'весел', 'весёл', 'праздник', 'party', 'happy', 'joy', 'fun']],
];

/**
 * Разбирает текст запроса в настроение.
 *
 * Правило разрешения конфликтов (emotion-map): побеждает последнее
 * совпадение; слово «но» отменяет всё, сказанное до него.
 *
 * @param {string} text
 * @returns {{valence:number, arousal:number, label:string|null, modifiers:string[], conflicts:string[]}}
 */
export function parseMood(text) {
  const source = String(text || '').toLowerCase();
  const conflicts = [];

  // «но» (и его синонимы) отсекает всё, что было до него.
  let scope = source;
  const contrast = [' но ', ' however ', ' хотя ', ' но ', 'вместо'];
  for (const word of contrast) {
    const index = scope.lastIndexOf(word);
    if (index >= 0) {
      const before = scope.slice(0, index);
      if (before.trim()) conflicts.push(before.trim());
      scope = scope.slice(index + word.length - 1);
    }
  }

  let best = null;
  for (const [label, words] of MOOD_KEYWORDS) {
    for (const word of words) {
      const index = scope.lastIndexOf(word);
      if (index < 0) continue;
      if (!best || index > best.index) best = { label, index, word };
    }
  }

  if (!best) {
    // Нет явного настроения — нейтрально-спокойное состояние.
    return { valence: 0, arousal: 0, label: null, modifiers: [], conflicts };
  }
  const mood = MOODS[best.label];
  return {
    valence: mood.valence,
    arousal: mood.arousal,
    label: best.label,
    modifiers: [],
    conflicts,
  };
}

/**
 * Лад по непрерывной яркости настроения.
 * Ярлык настроения, если он есть, важнее интерполяции: карта — источник истины.
 * @param {number} valence
 * @param {string|null} label
 * @returns {string} название лада
 */
export function modeForMood(valence, label) {
  if (label && MOODS[label]) return MOODS[label].mode;
  const index = Math.round((1 - clamp(valence, -1, 1)) / 2 * (BRIGHTNESS_SCALE.length - 1));
  return BRIGHTNESS_SCALE[Math.min(BRIGHTNESS_SCALE.length - 1, Math.max(0, index))];
}

/**
 * Собирает музыкальные параметры из настроения.
 *
 * @param {{valence:number, arousal:number, label?:string|null}} mood
 * @param {{bpmRange?:[number,number], bpm?:number, genre?:string}} options
 * @returns {object} параметры компиляции
 */
export function compileEmotion(mood, options = {}) {
  const label = mood.label && MOODS[mood.label] ? mood.label : null;
  const base = label ? MOODS[label] : null;
  const valence = clamp(mood.valence ?? 0, -1, 1);
  const arousal = clamp(mood.arousal ?? 0, -1, 1);

  // Темп: arousal тянет вверх, жанровый диапазон — рамка.
  const range = options.bpmRange || (base ? base.bpm : [60, 140]);
  const wanted = 60 + ((arousal + 1) / 2) * 80;         // 60..140
  let bpm = options.bpm ?? Math.round(wanted);
  bpm = Math.min(range[1], Math.max(range[0], bpm));

  // Плотность (событий в секунду) — из arousal и таблицы настроения.
  const densityRange = base ? base.density : [2, 12];
  const density = Math.round(
    densityRange[0] + ((arousal + 1) / 2) * (densityRange[1] - densityRange[0]),
  );

  return {
    label,
    mode: modeForMood(valence, label),
    bpm,
    density,
    register: base ? base.register : 60,
    articulation: base ? base.articulation : 'plain',
    progression: base ? base.progression : ['I', 'V', 'vi', 'IV'],
    valence,
    arousal,
  };
}

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
