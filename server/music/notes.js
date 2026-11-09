// Нотный слой: имена нот, тональности, аккорды.
// Чистые функции без зависимостей — тестируются в node.

const NOTE_LETTERS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// Лады и миноры Strudel. Значение — полутоны ступени.
export const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicminor: [0, 2, 3, 5, 7, 8, 11],
  majpent: [0, 2, 4, 7, 9],
  minpent: [0, 3, 5, 7, 10],
  wholetone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

// Короткие синонимы, которые встречаются в промптах и тональностях.
const MODE_ALIASES = {
  maj: 'major',
  min: 'minor',
  ionian: 'major',
  aeolian: 'minor',
  harmonicminor: 'harmonicminor',
  harmonic: 'harmonicminor',
  pentatonic: 'majpent',
  majorpent: 'majpent',
  minorpent: 'minpent',
};

/**
 * Разбирает «a:minor» / «c#:major» / «a» в тональность.
 * @returns {{root: string, pc: number, mode: string, name: string, intervals: number[]}|null}
 */
export function parseKey(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim().replace(/^["'`]|["'`]$/g, '');
  if (!raw) return null;
  const [rootPart, modePart] = raw.split(':');
  const letter = (rootPart || '').trim().toLowerCase();
  const letterMatch = letter.match(/^([a-g])([#b]?)$/);
  if (!letterMatch) return null;
  const root = letterMatch[1];
  const accidental = letterMatch[2];
  let pc = NOTE_LETTERS[root];
  if (accidental === '#') pc += 1;
  if (accidental === 'b') pc -= 1;
  pc = ((pc % 12) + 12) % 12;

  let mode = (modePart || 'major').trim().toLowerCase().replace(/\s+/g, '');
  mode = MODE_ALIASES[mode] || mode;
  const intervals = MODES[mode];
  if (!intervals) return null;
  return {
    root: `${root}${accidental}`,
    pc,
    mode,
    name: `${root}${accidental}:${mode}`,
    intervals,
  };
}

/**
 * Имя ноты → MIDI. «c3» = 48, «a#4» = 70, «eb2» = 39.
 * Без октавы берётся октава 3 (как в Strudel).
 */
export function noteToMidi(token) {
  if (typeof token !== 'string') return null;
  const m = token.trim().toLowerCase().match(/^([a-g])([#b]?)(-?\d+)?$/);
  if (!m) return null;
  const letter = m[1];
  const accidental = m[2];
  const octave = m[3] === undefined ? 3 : Number(m[3]);
  let pc = NOTE_LETTERS[letter];
  if (accidental === '#') pc += 1;
  if (accidental === 'b') pc -= 1;
  pc = ((pc % 12) + 12) % 12;
  return (octave + 1) * 12 + pc;
}

/**
 * Ступень лада → MIDI-высота. Степень 0 — тоника, 7 — тоника следующей октавы.
 * key — разобранная тональность (parseKey).
 */
export function degreeToMidi(degree, key, { octave = 3 } = {}) {
  if (!Number.isFinite(degree)) return null;
  const intervals = key?.intervals || MODES.major;
  const len = intervals.length;
  const idx = Math.trunc(degree);
  const oct = Math.floor(idx / len);
  const step = ((idx % len) + len) % len;
  const rootPc = key?.pc ?? 0;
  const base = (octave + 1) * 12 + rootPc;
  return base + intervals[step] + 12 * oct;
}

const CHORD_QUALITIES = [
  ['maj7', [0, 4, 7, 11]],
  ['min7', [0, 3, 7, 10]],
  ['min9', [0, 3, 7, 10, 14]],
  ['maj9', [0, 4, 7, 11, 14]],
  ['dim7', [0, 3, 6, 9]],
  ['sus4', [0, 5, 7]],
  ['sus2', [0, 2, 7]],
  ['dim', [0, 3, 6]],
  ['aug', [0, 4, 8]],
  ['maj', [0, 4, 7]],
  ['min', [0, 3, 7]],
  ['dom7', [0, 4, 7, 10]],
  ['m7', [0, 3, 7, 10]],
  ['maj6', [0, 4, 7, 9]],
  ['min6', [0, 3, 7, 9]],
  ['6', [0, 4, 7, 9]],
  ['7', [0, 4, 7, 10]],
  ['9', [0, 4, 7, 10, 14]],
  ['5', [0, 7]],
  ['3', [0, 4]],
  ['m', [0, 3, 7]],
  ['+', [0, 4, 8]],
  ['o', [0, 3, 6]],
];

/**
 * Название аккорда → набор MIDI-высот. «Am» → A-moll (45, 48, 52 при октаве 3),
 * «F#m7» → F#-минор7. Без указания качества — мажорный трезвучие.
 */
export function chordToMidi(token, { octave = 3 } = {}) {
  if (typeof token !== 'string') return null;
  const m = token.trim().match(/^([a-gA-G])([#b]?)(.*)$/);
  if (!m) return null;
  const letter = m[1].toLowerCase();
  const accidental = m[2];
  const quality = (m[3] || '').trim().toLowerCase();
  let pc = NOTE_LETTERS[letter];
  if (accidental === '#') pc += 1;
  if (accidental === 'b') pc -= 1;
  pc = ((pc % 12) + 12) % 12;

  let intervals = [0, 4, 7];
  for (const [name, iv] of CHORD_QUALITIES) {
    if (quality === name) {
      intervals = iv;
      break;
    }
  }
  const base = (octave + 1) * 12;
  return intervals.map((iv) => base + pc + iv);
}

/** Класс высоты (0–11) из MIDI. */
export function pitchClass(midi) {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** Название класса высоты для отчётов. */
export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Столбец из 12 «гридов» — доля класса высоты среди всех высот (0..1). */
export function pitchClassHistogram(midis) {
  const hist = new Array(12).fill(0);
  for (const m of midis) hist[pitchClass(m)] += 1;
  const total = midis.length || 1;
  return hist.map((v) => v / total);
}

/** Строки класса высоты, вне лада — потенциальные «фальшивые» ноты. */
export function notesOutsideScale(midis, key) {
  if (!key) return [];
  const allowed = new Set(key.intervals.map((i) => (key.pc + i) % 12));
  const counts = new Map();
  for (const m of midis) {
    const pc = pitchClass(m);
    if (allowed.has(pc)) continue;
    const label = PITCH_NAMES[pc];
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}
