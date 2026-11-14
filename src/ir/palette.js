// Палитра: какие звуки вообще можно назвать.
//
// Правило брифа: «никогда не выдумывай имена сэмплов». Поэтому белый список
// явный: имена из локального манифеста банков (dirt-samples) плюс
// синтезаторы движка. Всё, чего в списке нет, компилятор не назовёт —
// палитра проверяется до генерации кода, а не после.

// Голоса движка: работают всегда, без загрузки сэмплов.
export const SYNTH_VOICES = [
  'sine', 'sawtooth', 'square', 'triangle', 'supersaw', 'piano',
  'pink', 'brown', 'white',
];

// Сэмплы из локального банка `github:tidalcycles/dirt-samples`.
export const DRUM_SAMPLES = ['bd', 'sd', 'hh', 'cp', 'oh'];

export const SOUND_WHITELIST = new Set([...SYNTH_VOICES, ...DRUM_SAMPLES]);

/**
 * Палитры жанров. Источник — скил-карты genre-*.
 * Значения выбраны из реально доступных имён: вендорённые банки
 * (RolandTR707/909, LinnDrum, clean-breaks) в репозитории пока не лежат,
 * поэтому их фигурируют как цели вендоринга (S1.C), а не как источник кода.
 */
export const GENRE_PALETTES = {
  'trip-hop': {
    kick: 'bd', snare: 'sd', hats: 'hh', perc: 'hh',
    bass: 'sine', chords: 'piano', pad: 'triangle',
    lead: 'triangle', arp: 'triangle', fx: 'brown', texture: 'brown', sub: 'sine',
  },
  lofi: {
    kick: 'bd', snare: 'sd', hats: 'hh', perc: 'hh',
    bass: 'sine', chords: 'piano', pad: 'triangle',
    lead: 'triangle', arp: 'triangle', fx: 'white', texture: 'white', sub: 'sine',
  },
  synthpop: {
    kick: 'bd', snare: 'sd', hats: 'hh', perc: 'cp',
    bass: 'sawtooth', chords: 'supersaw', pad: 'sawtooth',
    lead: 'square', arp: 'square', fx: 'pink', texture: 'pink', sub: 'sine',
  },
  dnb: {
    kick: 'bd', snare: 'sd', hats: 'hh', perc: 'cp',
    bass: 'sine', chords: 'triangle', pad: 'triangle',
    lead: 'sawtooth', arp: 'sawtooth', fx: 'pink', texture: 'pink', sub: 'sine',
  },
  ambient: {
    kick: 'bd', snare: 'sd', hats: 'hh', perc: 'hh',
    bass: 'sine', chords: 'triangle', pad: 'triangle',
    lead: 'sine', arp: 'sine', fx: 'pink', texture: 'pink', sub: 'sine',
  },
};

/**
 * Orbit по ролям (mix-roles): один delay/reverb на orbit — роли не делят.
 */
export const ROLE_ORBIT = {
  kick: 1, snare: 1, hats: 1, perc: 1,
  bass: 2, sub: 2,
  chords: 3, pad: 3,
  lead: 4, arp: 4,
  fx: 5, texture: 5,
};

/**
 * Стартовые уровни ролей относительно кика (dB) — mix-roles.
 * Это НАЧАЛО для autoMix, а не догма.
 */
export const ROLE_GAIN_DB = {
  kick: 0, snare: -5, bass: -4, chords: -8, lead: -6,
  hats: -14, perc: -12, fx: -18, texture: -18, pad: -9, sub: -6, arp: -10,
};

/** Территория роли по частотам (Гц) — для ориентира в линтере. */
export const ROLE_BAND = {
  kick: [50, 100], snare: [200, 4000], hats: [5000, 12000],
  bass: [40, 250], sub: [30, 120], chords: [200, 2000], pad: [200, 2000],
  lead: [1000, 6000], arp: [500, 6000], fx: [100, 12000], texture: [100, 12000],
  perc: [200, 8000],
};

/**
 * Палитра жанра. Неизвестный жанр → нейтральная палитра.
 * @param {string} genre
 */
export function paletteForGenre(genre) {
  return { ...(GENRE_PALETTES[genre] || GENRE_PALETTES.lofi) };
}

/**
 * Проверяет, что имя звука известно движку.
 * @param {string} ref
 */
export function isKnownSound(ref) {
  if (!ref) return false;
  // `bank:...` и `synth:...` разрешаем только для зарегистрированных банков.
  if (ref.includes(':')) {
    const [kind, name] = ref.split(':');
    if (kind === 'synth') return SYNTH_VOICES.includes(name);
    return false;
  }
  return SOUND_WHITELIST.has(ref);
}
