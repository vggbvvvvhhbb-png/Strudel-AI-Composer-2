// Метрики v1, посчитанные по событиям Strudel.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Старый `analyzeTrack` (server/music/features.js) работает
// по собственному парсеру mini-нотации. Тот парсер разбирает один-два такта
// и НЕ понимает `arrange`, `stack`, `<…>/n`, `.slow`, `.mask`, `.struct`
// (см. D-001 в docs/DECISIONS.md). Поэтому на структурированном треке,
// собранном компилятором, он находит НОЛЬ событий — и все десять старых
// критериев выдают мусор: «плотность 0 атак на такт», «диапазон 0 полутонов».
//
// Этот модуль даёт те же метрики, но по настоящим событиям Strudel.
// Формат результата совместим с `analyzeTrack`, поэтому `scoreTrack`
// (server/music/score.js) работает с ним без изменений — старый скор
// не ломается, но наконец видит структурированные треки.

import { runStrudel } from '../strudel-runtime.mjs';
import { noteToMidi, pitchClass, parseKey, MODES } from '../notes.js';
import { getBpm, getKey } from '../../../src/core/code-model.js';

const EPS = 1e-6;

/**
 * Роли партий — те же, что у extract.js, но по метке и по наличию высот.
 */
const ROLE_RULES = [
  [/BASS|SUB|LOW/, 'bass'],
  [/KICK|DRUM|DR$|PERC/, 'drums'],
  [/SNARE|CLAP|RIM/, 'snare'],
  [/HAT|HH/, 'hats'],
  [/PAD|STR|BED/, 'pad'],
  [/CHORD/, 'chords'],
  [/ARP|PLUCK/, 'arp'],
  [/LEAD|MEL/, 'melody'],
];

/**
 * Определяет роль партии по метке и по тому, есть ли в ней высоты.
 */
export function roleFor(label, hasPitch) {
  const upper = String(label || '').toUpperCase();
  for (const [re, role] of ROLE_RULES) {
    if (re.test(upper)) return role;
  }
  return hasPitch ? 'melody' : 'drums';
}

/** Округление позиции атаки до 1/16. */
function grid16(value) {
  return Math.round(value * 16) / 16;
}

/**
 * Разбор трека по событиям Strudel — в формате `analyzeTrack`.
 *
 * @param {string} code Strudel-код
 * @param {object} [options]
 * @param {number} [options.cycles] горизонт в тактах
 * @returns {Promise<object>} {bpm, key, parts, metrics, errors}
 */
export async function analyzeTrackFromEvents(code, { cycles = 8 } = {}) {
  const run = await runStrudel(code, { cycles });
  const errors = run.error ? [run.error] : [];

  const keyRaw = getKey(code);
  const declaredKey = keyRaw ? parseKey(keyRaw) : null;

  const parts = [];
  const allNotes = [];

  for (const label of run.order) {
    const events = run.parts[label] || [];
    const onsets = [];
    const midis = [];
    const partNotes = [];

    for (const event of events) {
      const begin = event.whole?.begin ?? 0;
      if (begin < 1 - EPS) onsets.push(grid16(begin));
      const note = event.value?.note;
      if (typeof note === 'string') {
        const midi = noteToMidi(note);
        if (midi !== null) {
          midis.push(midi);
          allNotes.push(midi);
          partNotes.push({ begin: grid16(begin), midi, kind: 'note' });
        }
      }
    }

    onsets.sort((a, b) => a - b);
    const signature = onsets.join(',');

    parts.push({
      label,
      role: roleFor(label, midis.length > 0),
      muted: false,
      solo: false,
      onsets: onsets.length,
      density: onsets.length,
      offbeat: offbeatShare(onsets),
      noteCount: midis.length,
      minMidi: midis.length ? Math.min(...midis) : null,
      maxMidi: midis.length ? Math.max(...midis) : null,
      avgMidi: midis.length ? midis.reduce((s, m) => s + m, 0) / midis.length : null,
      pitchClasses: [...new Set(midis.map(pitchClass))].sort((a, b) => a - b),
      signature,
      notes: partNotes,
      chain: {},
      // Всё, что нужно для счёта по сетке 1/16.
      onsetGrid: new Set(onsets.map((o) => Math.round(o * 16))),
    });
  }

  const totalOnsets = parts.reduce((sum, p) => sum + p.onsets, 0);
  const weightedOffbeat = totalOnsets
    ? parts.reduce((sum, p) => sum + p.offbeat * p.onsets, 0) / totalOnsets
    : 0;

  const detected = allNotes.length ? detectKeyFromMidis(allNotes) : null;
  const key = declaredKey || (detected ? { ...detected, detected: true } : null);

  const scaleHit = key
    ? allNotes.filter((m) => key.intervals.includes(((pitchClass(m) - key.pc) % 12 + 12) % 12)).length
    : 0;
  const scaleFit = allNotes.length && key ? scaleHit / allNotes.length : null;

  const pitchedParts = parts.filter((p) => p.avgMidi !== null);
  let separation = null;
  if (pitchedParts.length >= 2) {
    const sorted = [...pitchedParts].sort((a, b) => a.avgMidi - b.avgMidi);
    separation = sorted[sorted.length - 1].avgMidi - sorted[0].avgMidi;
  }

  const range = allNotes.length ? Math.max(...allNotes) - Math.min(...allNotes) : null;
  const motion = melodicMotion(parts);
  const signatures = new Set(parts.filter((p) => p.onsets > 0).map((p) => p.signature));
  const activeParts = parts.filter((p) => p.onsets > 0).length;
  const rhythmVariety = activeParts ? signatures.size / activeParts : 0;
  const space = restShare(parts);
  const roles = [...new Set(parts.map((p) => p.role))];

  return {
    bpm: getBpm(code),
    key: key ? { name: key.name, root: key.root, mode: key.mode, declared: Boolean(declaredKey) } : null,
    detectedKey: detected ? detected.name : null,
    outsideScale: declaredKey && allNotes.length
      ? outsideScaleNotes(allNotes, declaredKey)
      : [],
    parts,
    metrics: {
      bpm: getBpm(code),
      partCount: parts.length,
      activeParts,
      roles,
      density: totalOnsets,
      offbeat: weightedOffbeat,
      scaleFit,
      range,
      separation,
      motion,
      rhythmVariety,
      space,
      noteCount: allNotes.length,
    },
    errors,
  };
}

/** Доля атак вне сетки 1/4. */
function offbeatShare(onsets) {
  if (!onsets.length) return 0;
  let onBeat = 0;
  for (const t of onsets) {
    const q = t * 4;
    if (Math.abs(q - Math.round(q)) < 1e-3) onBeat += 1;
  }
  return 1 - onBeat / onsets.length;
}

/** Движение мелодии: число разных интервалов между соседними нотами. */
function melodicMotion(parts) {
  const intervals = new Set();
  for (const part of parts) {
    if (!['melody', 'arp', 'bass', 'pad', 'chords'].includes(part.role)) continue;
    const notes = [...part.notes].sort((a, b) => a.begin - b.begin);
    for (let i = 1; i < notes.length; i += 1) {
      const diff = notes[i].midi - notes[i - 1].midi;
      if (diff === 0) continue;
      intervals.add(((diff % 12) + 12) % 12);
    }
  }
  return intervals.size;
}

/**
 * Доля пауз: пустые слоты сетки 1/16 в мелодических партиях.
 *
 * Считается по сетке, а не по тильдам в тексте: события — единственный
 * источник истины.
 */
function restShare(parts) {
  let empty = 0;
  let total = 0;
  for (const part of parts) {
    if (!['melody', 'arp', 'bass', 'pad', 'chords'].includes(part.role)) continue;
    if (!part.onsetGrid?.size) continue;
    // Слоты, занятые в первом такте партии.
    for (let slot = 0; slot < 16; slot += 1) {
      total += 1;
      if (!part.onsetGrid.has(slot)) empty += 1;
    }
  }
  return total ? empty / total : 0;
}

/** Тональность по наличию нот. */
function detectKeyFromMidis(midis) {
  if (!midis.length) return null;
  const counts = new Array(12).fill(0);
  for (const pc of midis.map(pitchClass)) counts[pc] += 1;

  let best = null;
  for (let root = 0; root < 12; root += 1) {
    for (const [mode, intervals] of Object.entries(MODES)) {
      if (intervals.length < 5) continue;
      let hit = 0;
      for (let i = 0; i < 12; i += 1) {
        if (intervals.includes((i - root + 12) % 12)) hit += counts[i];
      }
      const ratio = hit / midis.length;
      if (!best || ratio > best.ratio + 1e-9) {
        const names = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
        best = {
          root: names[root],
          pc: root,
          mode,
          name: `${names[root]}:${mode}`,
          intervals,
          ratio,
        };
      }
    }
  }
  return best;
}

/** Ноты вне лада. */
function outsideScaleNotes(midis, key) {
  const allowed = new Set(key.intervals.map((i) => (key.pc + i) % 12));
  const counts = new Map();
  for (const m of midis) {
    const pc = pitchClass(m);
    if (allowed.has(pc)) continue;
    const label = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][pc];
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}
