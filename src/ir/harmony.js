// Гармония IR: римские цифры → аккорды движка.
//
// Ключевой факт, измеренный пробами (tests/spike/chord-symbols*.probe.mjs):
// движок понимает `C`, `Dm`, `Cm`, `Caug`, `Csus`, `Cm7b5`, `C5`, `Cadd9`,
// `C7`, `Cm9`, `C^7` — но НЕ понимает `Cmaj7`, `Csus2`, `Cdim` (аккорд без
// интерпретации, события не появляются). Поэтому maj7 пишется как `^7`,
// sus2 не используется, а «уменьшённый» цвет заменяется на
// полууменьшённый (m7b5) — ближайший поддерживаемый вариант.
//
// Отдельно: `Fmsus` (минорный sus) движок НЕ понимает и отдаёт ПУСТОЙ
// аккорд без ошибки. Sus не имеет третьей ступени, поэтому в нём нет и
// префикса «m»: `Dsus` (D G A) законен и в миноре.
//
// Качество аккорда задаётся СУФФИКСОМ, а не римской цифрой: `Dm` = ре-минор,
// `D` = ре-мажор. Римская цифра определяет СТУПЕНЬ, суффикс — КАЧЕСТВО.

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Полутоны ладов. Индекс — ступень (0 = тоника).
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  // Локриан обязателен: настроение «пустота» (void) выбирает лад locrian,
  // а без него modeOf() отдавал 'major' — и гармония трека была мажорной.
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

const MAJOR_STEPS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const MINOR_STEPS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];

/** Лад тональности по имени: 'c:minor' → 'minor'. */
export function modeOf(key) {
  const suffix = String(key ?? 'c:major').split(':')[1] ?? 'major';
  if (suffix.startsWith('min') || suffix === 'aeolian') return 'minor';
  if (suffix === 'dorian') return 'dorian';
  if (suffix === 'phrygian') return 'phrygian';
  if (suffix === 'lydian') return 'lydian';
  if (suffix === 'mixolydian') return 'mixolydian';
  if (suffix === 'locrian') return 'locrian';
  return 'major';
}

/**
 * Разбирает римскую цифру в ступень и качество.
 *
 * Поддерживаются: I V vi IV bII bVI bVII iv III (#) — с префиксом «b» (бемоль)
 * и без, со знаком качества в нижнем регистре (i = минор).
 * Возвращает null, если цифра не распознана.
 */
export function parseRoman(roman) {
  const text = String(roman ?? '').trim();
  const match = /^([b#]?)([ivIV]+)(o|u)?$/.exec(text);
  if (!match) return null;
  const [, accidental, numeral] = match;
  const lowered = numeral.toLowerCase();
  const index = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'].indexOf(lowered);
  if (index === -1) return null;
  const isMinor = numeral === lowered;
  const degree = index + 1;
  return {
    degree,
    accidental: accidental === 'b' ? -1 : accidental === '#' ? 1 : 0,
    quality: isMinor ? 'minor' : 'major',
  };
}

/**
 * Тональная высота ступени в полутонах от До.
 *
 * Ступень берётся из лада, а случайная ступень (accidental) — из натурального
 * лада мажора, иначе bII превратился бы в ту же ноту, что и II.
 */
export function degreePitchClass(key, degree, accidental = 0) {
  const mode = modeOf(key);
  const scale = SCALES[mode] ?? SCALES.major;
  const natural = SCALES.major;
  const index = Math.min(Math.max(degree, 1), 7) - 1;
  const root = String(key ?? 'c:major').split(':')[0];
  const letter = root[0].toUpperCase();
  const rootPc = PITCH_CLASS[letter] + (root.includes('#') ? 1 : root.includes('b') ? -1 : 0);
  const step = scale[index] ?? natural[index];
  const accidentalStep = accidental !== 0 ? natural[index] + accidental : step;
  return (rootPc + accidentalStep + 120) % 12;
}

/** Имя ноты по классу высоты: 9 → 'A', 1 → 'Db'. */
export function pitchName(pitchClass) {
  // Регистр важен: tonal разбирает 'Dm', но не 'dm' — молча даёт пустой аккорд.
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  return names[((pitchClass % 12) + 12) % 12];
}

/**
 * Аккорд из римской цифры и цвета.
 *
 * color: 'sus' | 'add9' | '7' | 'borrowed' | 'picardy' | undefined
 * Возвращает символ аккорда движка или null, если цифра не распознана.
 */
export function chordSymbol(key, roman, color) {
  const parsed = parseRoman(roman);
  if (!parsed) return null;
  const pitchClass = degreePitchClass(key, parsed.degree, parsed.accidental);
  const root = pitchName(pitchClass);
  const quality = parsed.quality;

  if (quality === 'minor') {
    // Измерено: «Fmsus» движок НЕ понимает — аккорд выходит ПУСТЫМ, без
    // ошибки. Sus не имеет третьей ступени, поэтому префикс «m» в нём и не
    // нужен: тот же Dsus4 (D G A) законен и в миноре.
    if (color === 'sus') return `${root}sus`;
    if (color === 'add9') return `${root}madd9`;
    if (color === '7') return `${root}m7`;
    return `${root}m`;
  }
  if (quality === 'major') {
    if (color === 'sus') return `${root}sus`;
    if (color === 'add9') return `${root}add9`;
    if (color === '7') return `${root}7`;
    return root;
  }
  return root;
}

/**
 * Прогрессия по настроению (harmony-recipes из скил-пака).
 * Каждый рецепт — массив римских цифр; цвет задаётся по умолчанию для жанра.
 */
export const PROGRESSIONS = {
  joy: ['I', 'V', 'vi', 'IV'],
  euphoria: ['I', 'V', 'vi', 'IV'],
  tender: ['Imaj7', 'vi', 'IV', 'V'],
  hope: ['vi', 'IV', 'I', 'V'],
  nostalgia: ['ii', 'V', 'I', 'vi'],
  melancholy: ['i', 'VI', 'III', 'VII'],
  dark: ['i', 'iv', 'VI', 'V'],
  anxiety: ['i', 'bII', 'i', 'bII'],
  anger: ['i', 'VI', 'V'],
  void: ['I', 'IV'],
};

/** Римская цифра → символ; 'Imaj7' разворачивается в тонику с септимой. */
export function symbolForRoman(key, roman, color) {
  const special = /^([b#]?)([ivIV]+)(maj7|min7|7)$/.exec(String(roman ?? ''));
  if (special) {
    const [, accidental, numeral, suffix] = special;
    const lowered = numeral.toLowerCase();
    const index = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'].indexOf(lowered);
    if (index === -1) return null;
    const pitchClass = degreePitchClass(key, index + 1, accidental === 'b' ? -1 : accidental === '#' ? 1 : 0);
    const root = pitchName(pitchClass);
    if (suffix === 'maj7') return `${root}^7`;
    if (suffix === 'min7') return `${root}m7`;
    return `${root}7`;
  }
  return chordSymbol(key, roman, color);
}

/**
 * Строит список аккордов секции: сколько тактов каждый аккорд держится.
 *
 * @param {string} key тональность вида 'c:minor'
 * @param {Array<{rn:string, bars?:number, color?:string}>} harmony
 * @param {number} bars длина секции в тактах
 * @returns {Array<{symbol:string, bars:number, roman:string}>}
 */
export function buildChordPlan(key, harmony, bars) {
  if (!harmony || !harmony.length) {
    const symbol = symbolForRoman(key, 'I') || 'C';
    return [{ symbol, bars, roman: 'I' }];
  }
  // Если сумма тактов не совпадает с длиной секции, доли пересчитываются
  // пропорционально — так план остаётся согласованным с длиной секции.
  const declared = harmony.reduce((sum, item) => sum + (item.bars || 1), 0);
  const out = [];
  let cursor = 0;
  harmony.forEach((item, index) => {
    const symbol = symbolForRoman(key, item.rn, item.color);
    if (!symbol) return;
    const share = index === harmony.length - 1
      ? Math.max(1, bars - cursor)
      : Math.max(1, Math.round((item.bars || 1) * bars / declared));
    out.push({ symbol, bars: share, roman: item.rn });
    cursor += share;
  });
  return out;
}

/** Римские цифры для лада — используются в отчётах и линтере. */
export function romanNames(key) {
  const mode = modeOf(key);
  return mode === 'major' ? MAJOR_STEPS : MINOR_STEPS;
}
