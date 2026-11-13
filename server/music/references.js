// Референсные профили стилей: что считать «хорошим» для конкретного жанра.
//
// Профили задают целевые диапазоны метрик. Скор считается прозрачно: видно,
// какая метрика не попала в цель и сколько баллов она стоила.
// Диапазоны ориентировочные — их калибрует scripts/calibrate.mjs по оценкам
// человека (слепой A/B на размеченных примерах).

export const PROFILES = {
  techno: {
    id: 'techno',
    name: 'Techno',
    nameRu: 'Техно',
    bpm: [124, 142],
    density: [10, 26],
    offbeat: [0.25, 0.7],
    scaleFit: 0.8,
    range: [24, 48],
    separation: 12,
    parts: [4, 6],
    motion: [2, 10],
    space: [0.05, 0.45],
    variety: 0.5,
  },
  house: {
    id: 'house',
    name: 'House',
    nameRu: 'Хаус',
    bpm: [116, 128],
    density: [10, 26],
    offbeat: [0.2, 0.65],
    scaleFit: 0.8,
    range: [20, 45],
    separation: 10,
    parts: [4, 6],
    motion: [2, 10],
    space: [0.05, 0.4],
    variety: 0.5,
  },
  dnb: {
    id: 'dnb',
    name: 'Drum & Bass',
    nameRu: 'Драм-н-бейс',
    bpm: [166, 180],
    density: [14, 32],
    offbeat: [0.25, 0.75],
    scaleFit: 0.75,
    range: [24, 52],
    separation: 12,
    parts: [4, 7],
    motion: [3, 12],
    space: [0.05, 0.4],
    variety: 0.5,
  },
  lofi: {
    id: 'lofi',
    name: 'Lo-fi',
    nameRu: 'Лоу-фай',
    bpm: [65, 90],
    density: [3, 12],
    offbeat: [0.05, 0.45],
    scaleFit: 0.7,
    range: [18, 45],
    separation: 8,
    parts: [3, 6],
    motion: [1, 9],
    space: [0.2, 0.6],
    variety: 0.4,
  },
  ambient: {
    id: 'ambient',
    name: 'Ambient',
    nameRu: 'Эмбиент',
    bpm: [50, 85],
    density: [2, 9],
    offbeat: [0, 0.35],
    scaleFit: 0.65,
    range: [12, 55],
    separation: 5,
    parts: [2, 5],
    motion: [1, 8],
    space: [0.3, 0.8],
    variety: 0.35,
  },
  synthwave: {
    id: 'synthwave',
    name: 'Synthwave',
    nameRu: 'Синтвейв',
    bpm: [80, 118],
    density: [5, 20],
    offbeat: [0.1, 0.55],
    scaleFit: 0.8,
    range: [20, 48],
    separation: 10,
    parts: [3, 6],
    motion: [2, 11],
    space: [0.1, 0.55],
    variety: 0.45,
  },
  trap: {
    id: 'trap',
    name: 'Trap',
    nameRu: 'Трэп',
    bpm: [120, 160],
    density: [6, 20],
    offbeat: [0.1, 0.5],
    scaleFit: 0.75,
    range: [18, 45],
    separation: 8,
    parts: [3, 6],
    motion: [1, 10],
    space: [0.15, 0.6],
    variety: 0.4,
  },
  hiphop: {
    id: 'hiphop',
    name: 'Hip-hop',
    nameRu: 'Хип-хоп',
    bpm: [80, 100],
    density: [6, 20],
    offbeat: [0.1, 0.5],
    scaleFit: 0.75,
    range: [18, 42],
    separation: 10,
    parts: [3, 6],
    motion: [2, 10],
    space: [0.15, 0.55],
    variety: 0.45,
  },
  generic: {
    id: 'generic',
    name: 'Generic',
    nameRu: 'Без стиля',
    bpm: [70, 140],
    density: [3, 26],
    offbeat: [0, 0.7],
    scaleFit: 0.6,
    range: [12, 55],
    separation: 4,
    parts: [2, 7],
    motion: [1, 12],
    space: [0.05, 0.75],
    variety: 0.3,
  },
};

export const PROFILE_IDS = Object.keys(PROFILES);

const STYLE_HINTS = [
  ['dnb', ['dnb', 'drum n bass', 'drum and bass', 'drum & bass', 'днб', 'драм-н-бейс', 'нейрофанк', 'neurofunk']],
  ['techno', ['techno', 'техно', 'club', 'клэб', 'industrial', 'индастриал', 'rave', 'рейв']],
  ['house', ['house', 'хаус', 'disco', 'диско', 'deep house', 'tech house', 'afro house']],
  ['lofi', ['lo-fi', 'lofi', 'лоу-фай', 'лофай', 'chill', 'чилл', 'jazz', 'джаз', 'boom bap', 'бум-бэп']],
  ['ambient', ['ambient', 'эмбиент', 'эмбиент', 'drone', 'дрон', 'спокойн', 'calm', 'meditat', 'медитац']],
  ['synthwave', ['synthwave', 'синтвейв', 'retrowave', 'ретроволн', '80s', 'восьмидесят', 'outrun']],
  ['trap', ['trap', 'трэп', 'трейп']],
  ['hiphop', ['hip hop', 'hip-hop', 'хип-хоп', 'хип-хоп', 'boom bap', 'drill', 'дрилл']],
];

/**
 * Определяет стиль по свободному тексту запроса.
 * @returns {string} id профиля
 */
export function detectStyle(text) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return 'generic';
  for (const [id, needles] of STYLE_HINTS) {
    if (needles.some((n) => hay.includes(n))) return id;
  }
  return 'generic';
}

/**
 * Подбирает профиль: явный id важнее угаданного по тексту.
 */
export function resolveProfile(styleId, fallbackText = '') {
  // Каноническое имя TrackSpec и исторический id профиля обозначают один жанр.
  if (styleId === 'lo-fi') return PROFILES.lofi;
  if (styleId && PROFILES[styleId]) return PROFILES[styleId];
  return PROFILES[detectStyle(fallbackText)] || PROFILES.generic;
}
