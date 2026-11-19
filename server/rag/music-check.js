// Музыкальные проверки записей знаний и сгенерированного кода (D-135):
// нормализация тоники, принадлежность звучащих нот заявленному ладу.
// Работает по реальным событиям queryArc (server/music/strudel-runtime.mjs),
// а не по тексту кода — проверяется то, что звучит.

import { MODE_INTERVALS } from './harmony.js';

const SHARP_TO_FLAT = {
  'c#': 'db', 'd#': 'eb', 'e#': 'f', 'f#': 'gb', 'g#': 'ab', 'a#': 'bb', 'b#': 'c',
};

const LETTER_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Нормализация тоники: регистр, диезы → бемоли. Возвращает канон или null. */
export function normalizeTonic(tonic) {
  if (typeof tonic !== 'string') return null;
  const t = tonic.trim().toLowerCase();
  return SHARP_TO_FLAT[t] || (/^[a-g](b|#)?$/.test(t) ? t : null);
}

/** Питч-класс ноты вида 'C3', 'eb4', 'F#2' или null (не нота / без октавы). */
export function pitchClassOfNote(note) {
  if (typeof note !== 'string') return null;
  const m = note.trim().match(/^([a-gA-G])(#{1,2}|b{1,2})?(-?\d+)$/);
  if (!m) return null;
  let pc = LETTER_PC[m[1].toLowerCase()];
  for (const ch of m[2] || '') pc += ch === '#' ? 1 : -1;
  return ((pc % 12) + 12) % 12;
}

/** Питч-классы лада от тоники (0..11). */
export function scalePitchClasses(tonic, mode) {
  const t = normalizeTonic(tonic);
  const intervals = MODE_INTERVALS[mode];
  if (t === null || !intervals) return null;
  const root = LETTER_PC[t[0]] + (t[1] === 'b' ? -1 : t[1] === '#' ? 1 : 0);
  return intervals.map((i) => (((root + i) % 12) + 12) % 12);
}

/** Извлекает имя ноты из значения hap (note-паттерны и n().scale()). */
function noteOfValue(value) {
  if (value && typeof value === 'object' && typeof value.note === 'string') return value.note;
  if (typeof value === 'string' && pitchClassOfNote(value) !== null) return value;
  return null;
}

/**
 * Проверка принадлежности звучащих нот ладу по событиям queryArc.
 * Ударные/сэмплы без высоты пропускаются; числовые ступени без scale()
 * не проверяются (высота неизвестна — «нет данных», не нарушение).
 * @param {Record<string, Array>} parts события по партиям из runStrudel
 * @returns {{ok: boolean, checked: number, offenders: Array<{part: string, note: string, pitchClass: number}>}}
 */
export function checkScaleMembership(parts, tonic, mode) {
  const scale = scalePitchClasses(tonic, mode);
  if (!scale) return { ok: false, checked: 0, offenders: [], error: `неизвестный лад ${tonic}:${mode}` };
  const allowed = new Set(scale);
  const offenders = [];
  let checked = 0;
  for (const [part, haps] of Object.entries(parts || {})) {
    for (const hap of haps) {
      const note = noteOfValue(hap.value);
      if (!note) continue;
      const pc = pitchClassOfNote(note);
      if (pc === null) continue;
      checked += 1;
      if (!allowed.has(pc)) offenders.push({ part, note, pitchClass: pc });
    }
  }
  return { ok: offenders.length === 0, checked, offenders };
}