// Ноты, темп и лад: перевод MIDI ↔ имя ноты, выбор темпа и лада,
// нормализация аккордов в токены гармонии.
//
// Здесь нет ни одного числа, что не пришло из измерений: темп берётся из
// measurements.tempo, лад — из measurements.key, а интервалы аккорда
// выводятся из измеренного качества.

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** MIDI → имя ноты с октавой: 60 → 'c4'. */
export function midiToNoteName(midi) {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

/** 'c#3' → MIDI. Возвращает null, если имя не разобрано. */
export function noteNameToMidi(name) {
  const match = String(name ?? '').match(/^([a-g])(#|b)?(-?\d+)$/);
  if (!match) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[match[1]];
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  return (Number(match[3]) + 1) * 12 + base + accidental;
}

/** Темп: берём из измерений, приводим в диапазон схемы (60..180). */
export function chooseTempo(tempo) {
  const candidates = [];
  if (tempo?.bpm) candidates.push({ bpm: tempo.bpm, kind: 'primary', confidence: tempo.confidence ?? 0 });
  for (const candidate of tempo?.candidates ?? []) {
    if (candidate.bpm && !candidates.some((c) => Math.abs(c.bpm - candidate.bpm) < 0.01)) {
      candidates.push(candidate);
    }
  }
  const usable = candidates.find((c) => c.bpm >= 60 && c.bpm <= 180);
  if (usable) {
    return {
      bpm: Number(usable.bpm.toFixed(3)),
      source: usable.kind ?? 'primary',
      shifted: usable.kind === 'half_time' || usable.kind === 'double_time' ? usable.kind : null,
      candidates: candidates.map((c) => ({ bpm: c.bpm, kind: c.kind ?? 'alternative', confidence: c.confidence ?? 0 })),
      note: usable.kind === 'half_time' || usable.kind === 'double_time'
        ? `выбран ${usable.kind}: ${usable.bpm} BPM (двойная/половинная сетка)`
        : null,
    };
  }
  const fallback = candidates[0]?.bpm ?? 120;
  const clamped = Math.min(180, Math.max(60, fallback));
  return {
    bpm: Number(clamped.toFixed(3)),
    source: 'clamped',
    shifted: null,
    candidates: candidates.map((c) => ({ bpm: c.bpm, kind: c.kind ?? 'alternative', confidence: c.confidence ?? 0 })),
    note: `измеренный темп ${fallback} BPM вне диапазона схемы 60..180 — взят ${clamped}`,
  };
}

/** Лад: тоника + режим → строка вида 'Cmin' (её ждёт keyScale в компиляторе). */
export function chooseKey(key) {
  const tonic = String(key?.tonic ?? 'C').replace(/^([a-g])/i, (m) => m.toUpperCase());
  const mode = String(key?.mode ?? 'major').toLowerCase();
  const suffix = mode === 'minor' ? 'min' : mode === 'major' ? 'major' : mode;
  return { key: `${tonic}${suffix}`, confidence: key?.confidence ?? 0 };
}

/** Аккорд-гипотеза → нормализованный токен гармонии ('Cmin' / 'Fmaj'). */
export function harmonyToken(chord) {
  const root = String(chord?.root ?? '').replace(/^([a-g])/i, (m) => m.toUpperCase());
  if (!/^[A-G][#b]?$/.test(root)) return null;
  const quality = String(chord?.quality ?? '').toLowerCase();
  const minor = /^(m|min|minor|-)/.test(quality) || quality.includes('dim') || quality.includes('phryg');
  const major = /^(maj|major|)$/.test(quality) || quality.includes('maj');
  if (minor) return `${root}min`;
  if (major) return `${root}maj`;
  return null;
}

/**
 * Ноты аккорда → триада в конкретной октаве.
 * Измеряем только корень и качество, поэтому интервалы берём из качества:
 * мажор — 0/4/7, минор — 0/3/7. Для «сырых» гипотез — 0/3/7 (минор) как
 * консервативное допущение, помеченное в отчёте.
 */
export function chordTriad(chord, rootMidi = 60) {
  const rootName = String(chord?.root ?? '').toLowerCase();
  const rootMidiValue = noteNameToMidi(`${rootName}3`);
  if (rootMidiValue === null) return null;
  const quality = String(chord?.quality ?? '').toLowerCase();
  const minor = /^(m|min|minor|-)/.test(quality) || quality.includes('dim') || quality.includes('phryg');
  const intervals = minor ? [0, 3, 7] : [0, 4, 7];
  const base = rootMidiValue + (rootMidi - rootMidiValue) % 12;
  return intervals.map((interval) => midiToNoteName(base + interval));
}
