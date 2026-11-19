// Детерминированное объяснение кода (D-140, фаза G): распознавание
// аккордовой прогрессии по символам chord(), функции T/S/D, каденция,
// предложения замен из правил гармонии. Без LLM — машинно-проверяемо;
// прозаическое объяснение поверх может добавить ассистент, но факты
// отсюда не переписываются моделью.

import { parseKeyCode } from './code-validator.js';
import { scalePitchClasses } from './music-check.js';
import { functionOfDegree, cadenceType, HARMONY_RULES } from './harmony.js';

const LETTER_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const PC_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const PROGRESSIONS = [
  { degrees: [1, 4, 0], name: 'ii–V–I', hint: 'классическая джазовая связка S→D→T' },
  { degrees: [0, 5, 3, 4], name: 'I–vi–IV–V', hint: 'поп-стандарт 50-х' },
  { degrees: [0, 4, 5, 3], name: 'I–V–vi–IV', hint: 'четыре аккорда поп-хита' },
  { degrees: [5, 3, 0, 4], name: 'vi–IV–I–V', hint: 'минорный поп-круг' },
  { degrees: [0, 6, 5, 4], name: 'i–VII–VI–V', hint: 'андалузская каденция (фригийский оттенок)' },
  { degrees: [0, 3, 4, 0], name: 'I–IV–V–I', hint: 'простая функциональная петля' },
  { degrees: [0, 5], name: 'i–VI', hint: 'ностальгическая смена' },
  { degrees: [0, 3], name: 'i–IV (dorian vamp)', hint: 'соул-вамп с большой шестой' },
];

function rootPc(symbol) {
  const m = String(symbol).match(/^([A-Ga-g])([#b]?)/);
  if (!m) return null;
  let pc = LETTER_PC[m[1].toLowerCase()];
  if (m[2] === '#') pc += 1;
  if (m[2] === 'b') pc -= 1;
  return ((pc % 12) + 12) % 12;
}

function qualityOf(symbol) {
  const suffix = symbol.replace(/^[A-Ga-g][#b]?/, '');
  if (/^(maj|M7)/.test(suffix)) return 'major7';
  if (/^m(?!aj)/.test(suffix)) return 'minor';
  if (/7$/.test(suffix) || /^7/.test(suffix)) return 'dominant7';
  if (/^dim/.test(suffix)) return 'diminished';
  if (/6$/.test(suffix)) return 'sixth';
  if (/9$/.test(suffix)) return 'ninth';
  return 'major';
}

/** Символы аккордов из кода: chord("...") включая секвенции <...>. */
export function extractChordSymbols(code) {
  const out = [];
  for (const m of String(code).matchAll(/chord\(\s*"([^"]+)"\s*\)/g)) {
    for (const s of m[1].replace(/[<>]/g, ' ').split(/\s+/).filter(Boolean)) out.push(s);
  }
  return out;
}

/**
 * Разбор прогрессии кода.
 * @returns {{ok: boolean, key: object|null, chords: object[], progression: object|null,
 *   cadence: string|null, suggestions: object[], lines: string[], reason?: string}}
 */
export function explainCode(code) {
  const key = parseKeyCode(code);
  const symbols = extractChordSymbols(code);
  if (symbols.length === 0) {
    return { ok: false, key, chords: [], progression: null, cadence: null, suggestions: [], lines: [], reason: 'в коде нет chord() — объяснять нечего' };
  }
  if (!key) {
    return { ok: false, key: null, chords: [], progression: null, cadence: null, suggestions: [], lines: [], reason: 'нет key="тоника:лад" — ступени не определить' };
  }
  const scale = scalePitchClasses(key.tonic, key.mode);
  const chords = symbols.map((symbol) => {
    const pc = rootPc(symbol);
    const degree = pc === null ? -1 : scale.indexOf(pc);
    const fn = degree >= 0 ? functionOfDegree(degree, key.mode) : null;
    return {
      symbol,
      root: pc === null ? null : PC_NAMES[pc],
      quality: qualityOf(symbol),
      degree: degree >= 0 ? degree : null,
      function: fn,
      chromatic: degree < 0,
    };
  });

  const degrees = chords.map((c) => c.degree);
  let progression = null;
  if (degrees.every((d) => d !== null)) {
    for (const p of PROGRESSIONS) {
      const n = p.degrees.length;
      if (degrees.length >= n && p.degrees.every((d, i) => degrees[i] === d)) {
        progression = p;
        break;
      }
    }
  }

  const lastTwo = chords.slice(-2);
  const cadence = lastTwo.length === 2 && lastTwo.every((c) => c.degree !== null)
    ? cadenceType(lastTwo[0].degree, lastTwo[1].degree, key.mode)
    : null;

  const suggestions = [];
  for (const c of chords) {
    if (c.function !== 'D' || c.chromatic) continue;
    const tritone = HARMONY_RULES.substitutions.find((s) => s.id === 'tritone-sub');
    if (tritone.allowedModes.includes(key.mode)) {
      const subRoot = PC_NAMES[(rootPc(c.symbol) + 6) % 12];
      suggestions.push({
        kind: 'tritone-sub', target: c.symbol,
        text: `${c.symbol} можно заменить на ${subRoot}7 (тритоновая замена): общие направляющие тоны, бас движется хроматически.`,
      });
    }
  }
  if (cadence === 'authentic') {
    suggestions.push({ kind: 'cadence', target: null, text: 'Каденция аутентическая (D→T) — фраза разрешается устойчиво; для открытости замени последний аккорд на vi (прерванный оборот).' });
  }

  const lines = [
    `Тональность: ${key.tonic} ${key.mode}.`,
    `Аккорды: ${chords.map((c) => `${c.symbol}=${c.degree === null ? 'хроматика' : `ступень ${c.degree}`} (${c.function || '?'})`).join(', ')}.`,
  ];
  if (progression) lines.push(`Прогрессия: ${progression.name} — ${progression.hint}.`);
  if (cadence) lines.push(`Каденция последних двух аккордов: ${cadence}.`);
  for (const s of suggestions) lines.push(`Совет: ${s.text}`);

  return { ok: true, key, chords, progression, cadence, suggestions, lines };
}