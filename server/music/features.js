// Музыкальные метрики трека: всё, что можно измерить объективно.
//
// Метрики считаются по коду (см. extract.js), а не по звуку: код однозначно
// задаёт высоты и ритм, поэтому разбор детерминирован и воспроизводим.
// Все величины нормализованы: время в тактах (1 такт = 1.0), высоты в MIDI.

import { extractTrack, partEvents } from './extract.js';
import { parseKey, MODES, PITCH_NAMES, pitchClass, notesOutsideScale } from './notes.js';

const EPS = 1e-6;

// Округление позиции атаки до 1/16 — так ритмы сравниваются между партиями.
function grid16(value) {
  return Math.round(value * 16) / 16;
}

function onGrid(value, divisions) {
  const q = value * divisions;
  return Math.abs(q - Math.round(q)) < 1e-3;
}

/** Тональность по наличию нот: перебираем корни и лады, берём лучший по охвату. */
export function detectKey(midis) {
  if (!midis.length) return null;
  const pcs = midis.map(pitchClass);
  const counts = new Array(12).fill(0);
  for (const pc of pcs) counts[pc] += 1;

  let best = null;
  for (let root = 0; root < 12; root++) {
    for (const [mode, intervals] of Object.entries(MODES)) {
      if (intervals.length < 5) continue; // пентатоники не различаем между собой
      let hit = 0;
      for (let i = 0; i < 12; i++) {
        if (intervals.includes((i - root + 12) % 12)) hit += counts[i];
      }
      const ratio = hit / midis.length;
      if (!best || ratio > best.ratio + 1e-9) {
        best = { root: PITCH_NAMES[root].toLowerCase(), pc: root, mode, name: `${PITCH_NAMES[root].toLowerCase()}:${mode}`, intervals, ratio };
      }
    }
  }
  return best;
}

/**
 * Полный разбор трека.
 * @param {string} code Strudel-код
 * @returns {object} метрики и данные по партиям
 */
export function analyzeTrack(code) {
  const track = extractTrack(code);
  const errors = [];
  const parts = [];

  const allNotes = [];
  for (const part of track.parts) {
    const parsed = partEvents(part, track.key);
    errors.push(...parsed.errors);
    // Позиции атак первого такта — по ним ритмическая подпись партии.
    const onsets = parsed.firstBar;
    const pitched = parsed.notes.filter((n) => n.kind !== 'sample');
    const partMidis = pitched.map((n) => n.midi);
    for (const n of pitched) allNotes.push(n.midi);

    // Доля атак вне сетки 1/4 — «офф-бит» (хаты, синкопы).
    let onBeat = 0;
    for (const t of onsets) if (onGrid(t, 4)) onBeat += 1;
    const offbeat = onsets.length ? 1 - onBeat / onsets.length : 0;

    parts.push({
      label: part.label,
      role: part.role,
      muted: part.muted,
      solo: part.solo,
      // Атаки на такт: среднее по секциям, взвешенное по их длине.
      onsets: parsed.onsetsPerBar,
      density: parsed.onsetsPerBar,
      offbeat,
      noteCount: partMidis.length,
      minMidi: partMidis.length ? Math.min(...partMidis) : null,
      maxMidi: partMidis.length ? Math.max(...partMidis) : null,
      avgMidi: partMidis.length ? partMidis.reduce((a, b) => a + b, 0) / partMidis.length : null,
      pitchClasses: [...new Set(partMidis.map(pitchClass))].sort((a, b) => a - b),
      // Подпись ритма партии — по ней считаем разнообразие.
      signature: onsets.join(','),
      // Ноты первого такта — для мини-пиано-ролла в интерфейсе.
      notes: parsed.notes
        .filter((n) => n.begin < 1 - EPS)
        .map((n) => ({ begin: grid16(n.begin), midi: n.midi, kind: n.kind })),
      chain: part.chain,
    });
  }

  // Все высоты трека собраны выше, по партиям.
  const totalOnsets = parts.reduce((sum, p) => sum + p.onsets, 0);
  const weightedOffbeat = totalOnsets
    ? parts.reduce((sum, p) => sum + p.offbeat * p.onsets, 0) / totalOnsets
    : 0;

  const declaredKey = track.key;
  const detected = allNotes.length ? detectKey(allNotes) : null;
  const key = declaredKey || (detected ? { ...detected, detected: true } : null);

  const scaleHit = key
    ? allNotes.filter((m) => key.intervals.includes(((pitchClass(m) - key.pc) % 12 + 12) % 12)).length
    : 0;
  const scaleFit = allNotes.length && key ? scaleHit / allNotes.length : null;

  // Регистровое разделение: между самой низкой и самой высокой партией.
  const pitchedParts = parts.filter((p) => p.avgMidi !== null);
  let separation = null;
  if (pitchedParts.length >= 2) {
    const sorted = [...pitchedParts].sort((a, b) => a.avgMidi - b.avgMidi);
    separation = sorted[sorted.length - 1].avgMidi - sorted[0].avgMidi;
  }

  const range = allNotes.length ? Math.max(...allNotes) - Math.min(...allNotes) : null;

  // Движение мелодии: число разных интервалов между соседними нотами.
  const motion = melodicMotion(track, key);

  // Разнообразие: сколько разных ритмических подписей среди партий.
  const signatures = new Set(parts.filter((p) => p.onsets > 0).map((p) => p.signature));
  const activeParts = parts.filter((p) => p.onsets > 0).length;
  const rhythmVariety = activeParts ? signatures.size / activeParts : 0;

  // Паузы: доля тишин среди терминов в мелодических партиях.
  const space = restShare(track);

  const roles = [...new Set(parts.map((p) => p.role))];

  return {
    bpm: track.bpm,
    key: key ? { name: key.name, root: key.root, mode: key.mode, declared: Boolean(declaredKey) } : null,
    detectedKey: detected ? detected.name : null,
    outsideScale: declaredKey && allNotes.length ? notesOutsideScale(allNotes, declaredKey) : [],
    parts,
    metrics: {
      bpm: track.bpm,
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

// Интервалы между соседними нотами мелодических партий (в пределах такта).
function melodicMotion(track, key) {
  const intervals = new Set();
  for (const part of track.parts) {
    if (!['melody', 'arp', 'bass', 'pad'].includes(part.role)) continue;
    const parsed = partEvents(part, key);
    const notes = parsed.notes
      .filter((n) => n.kind !== 'sample' && n.begin < 1 - EPS)
      .sort((a, b) => a.begin - b.begin);
    for (let i = 1; i < notes.length; i++) {
      const diff = notes[i].midi - notes[i - 1].midi;
      if (diff === 0) continue;
      intervals.add(((diff % 12) + 12) % 12);
    }
  }
  return intervals.size;
}

// Доля пауз среди терминов в мелодических партиях.
function restShare(track) {
  let rests = 0;
  let terms = 0;
  for (const part of track.parts) {
    if (!['melody', 'arp', 'bass', 'pad'].includes(part.role)) continue;
    for (const source of part.sources) {
      if (source.kind === 's') continue;
      // Считаем тильды и термы прямо в исходной строке паттерна.
      const tokens = source.value.split(/[\s,]+/).filter(Boolean);
      for (const token of tokens) {
        if (token === '~') rests += 1;
        else if (!/^[[\]<>]/.test(token)) terms += 1;
      }
    }
  }
  const total = rests + terms;
  return total ? rests / total : 0;
}
