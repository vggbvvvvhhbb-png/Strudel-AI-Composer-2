// Быстрый символьный оракул: события трека из IR, без движка.
//
// ЗАЧЕМ. Бриф v2 §6 требует оценивать сотни кандидатов в секунду. Измерено
// (tests/spike/oracle-timing.probe.mjs):
//
//   queryArc движка, 32 такта:  ~91 мс  →  11 кандидатов/с
//   compileIR:                 ~0.7 мс →  1400 компиляций/с
//
// Движок даёт правду, но он слишком медленный для поиска. Поэтому оракул
// двухслойный:
//
//   1. БЫСТРЫЙ слой (этот файл) — события считаются из IR напрямую, по тем
//      же правилам, по которым компилятор строит код. Миллисекунды.
//   2. ТОЧНЫЙ слой (server/music/oracle.js) — те же события, но из
//      queryArc движка. Используется для финалистов и для сверки.
//
// Чтобы быстрый слой не разошёлся с реальностью, его сверяют с движком
// (tests/unit/oracle-consistency.test.js): расхождение = провал теста.
//
// ГРАНИЦА ТОЧНОСТИ. Ритмический и структурный скелет воспроизводится точно
// (все атаки, все длительности, все роли). Высоты аккордов — ПРИБЛИЖЕНИЕ:
// вокальный алгоритм движка не воспроизводится, вместо него берётся
// каноническое сомкнутое расположение от якоя. Для метрик (движение корней,
// напряжение, регистр) этого достаточно; для покадрового разбора голосов —
// нет. Такой контракт объявлен явно, а не спрятан.

import { grooveSteps } from '../ir/groove.js';
import { buildChordPlan, SCALES } from '../ir/harmony.js';
import { paletteForGenre } from '../ir/palette.js';
import { roleLevel, motifToMini, bassRhythm, resolveMotif } from '../ir/compiler.js';

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Формы аккордов движка — те, что реально поддерживаются (измерено пробами). */
const CHORD_SHAPES = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  m9: [0, 3, 7, 10, 14],
  '9': [0, 4, 7, 10, 14],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  sus: [0, 5, 7],
  aug: [0, 4, 8],
  '^7': [0, 4, 7, 11],
  '^9': [0, 4, 7, 11, 14],
};

/**
 * Тональность IR → класс высоты, полутоны лада, имя для движка.
 * @param {{tonic:string, mode:string}} key
 */
export function keyInfo(key) {
  const tonic = String(key?.tonic ?? 'C');
  const letter = tonic[0].toUpperCase();
  let pc = PITCH_CLASS[letter] ?? 0;
  if (tonic.includes('#')) pc += 1;
  if (tonic.includes('b')) pc -= 1;
  const mode = SCALES[key?.mode] ? key.mode : 'minor';
  return {
    pc: ((pc % 12) + 12) % 12,
    intervals: SCALES[mode],
    mode,
    name: `${tonic.toLowerCase()}:${mode}`,
  };
}

/**
 * Символ аккорда → корень (класс высоты) и форма.
 * @param {string} symbol например 'Dm9', 'Bb^7', 'Cadd9'
 */
export function chordShape(symbol) {
  const match = /^([A-G][#b]?)(.*)$/.exec(String(symbol ?? ''));
  if (!match) return null;
  const letter = match[1][0].toUpperCase();
  let pc = PITCH_CLASS[letter] ?? 0;
  if (match[1].includes('#')) pc += 1;
  if (match[1].includes('b')) pc -= 1;
  const quality = match[2] ?? '';
  const shape = CHORD_SHAPES[quality] ?? CHORD_SHAPES[quality.toLowerCase()];
  if (!shape) return null;
  return { pc: ((pc % 12) + 12) % 12, shape, root: match[1] };
}

/** MIDI-корень в ближайшей к якорю октаве. */
function rootNearAnchor(pc, anchor) {
  let best = anchor;
  let bestDistance = Infinity;
  for (let midi = anchor - 24; midi <= anchor + 24; midi += 1) {
    if (((midi % 12) + 12) % 12 !== pc) continue;
    const distance = Math.abs(midi - anchor);
    if (distance < bestDistance) {
      best = midi;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Каноническое сомкнутое расположение аккорда вокруг якоря.
 * Это ПРИБЛИЖЕНИЕ вокального алгоритма движка — см. шапку файла.
 */
export function chordPitches(symbol, anchor) {
  const parsed = chordShape(symbol);
  if (!parsed) return [];
  const rootMidi = rootNearAnchor(parsed.pc, anchor);
  const out = [];
  for (const interval of parsed.shape) {
    let midi = rootMidi + interval;
    while (midi > anchor + 12) midi -= 12;
    while (midi < anchor - 12) midi += 12;
    if (!out.includes(midi)) out.push(midi);
  }
  return out.sort((a, b) => a - b);
}

/** Степень лада → MIDI (октава 3 — как в движке). */
export function degreeToMidi(degree, info) {
  if (!Number.isFinite(degree)) return null;
  const len = info.intervals.length;
  const index = Math.trunc(degree);
  const oct = Math.floor(index / len);
  const step = ((index % len) + len) % len;
  const base = 48 + info.pc; // октава 3
  return base + info.intervals[step] + 12 * oct;
}

/** Сдвиг миллисекунд → циклы (1 цикл = 1 такт). */
export function msToCycles(ms, bpm) {
  return (ms * bpm) / 240000;
}

/** Слоты mini-строки «x ~ x»: индексы занятых позиций. */
export function miniSlots(mini, count = 16) {
  const slots = [];
  const tokens = String(mini || '').trim().split(/\s+/);
  for (let i = 0; i < count; i += 1) {
    const token = tokens[i];
    if (token === undefined || token === '~' || token === '') continue;
    slots.push(i);
  }
  return slots;
}

/**
 * Строит события трека прямо из IR.
 *
 * @param {object} ir CompositionIR
 * @returns {{events: Array, bars: number, bpm: number, sections: Array, key: object}}
 */
export function irEvents(ir) {
  const info = keyInfo(ir.meta.key);
  const bpm = ir.meta.bpm;
  const genre = ir.meta.genre || 'lofi';
  const palette = { ...paletteForGenre(genre), ...paletteRefs(ir) };
  const events = [];
  const sections = [];
  let bar = 0;

  ir.sections.forEach((section, sectionIndex) => {
    const startBar = bar;
    const chords = buildChordPlan(info.name, section.harmony, section.bars);
    // Символ на каждый такт секции: аккорд держится bars тактов.
    const perBar = [];
    for (const chord of chords) {
      for (let i = 0; i < chord.bars; i += 1) perBar.push(chord.symbol);
    }
    const sectionEvents = [];

    for (const role of Object.keys(section.layers).sort()) {
      const layer = section.layers[role];
      const level = roleLevel(role, layer, section, ir);
      // Роль с нулевым весом в секции молчит: событий у неё нет.
      if (!(level > 0.0001)) continue;
      const sample = palette[role] || paletteOfRole(role);
      switch (layer.plan) {
        case 'drums':
          sectionEvents.push(...drumEvents({
            ir, section, role, level, sample, startBar, bpm,
          }));
          break;
        case 'bassline':
          sectionEvents.push(...bassEvents({
            ir, section, role, level, sample, perBar, startBar, info,
          }));
          break;
        case 'chords':
        case 'pad':
          sectionEvents.push(...chordEvents({
            section, role, level, sample, perBar, startBar, pad: layer.plan === 'pad',
          }));
          break;
        case 'melody':
          sectionEvents.push(...melodyEvents({
            ir, section, role, level, sample, startBar, info,
          }));
          break;
        case 'arp':
          sectionEvents.push(...arpEvents({
            section, role, level, sample, startBar, info,
          }));
          break;
        case 'texture':
        case 'fx':
          sectionEvents.push(...noiseEvents({
            section, role, level, sample, startBar,
          }));
          break;
        default:
          break;
      }
    }

    events.push(...sectionEvents);
    sections.push({
      id: section.id,
      kind: section.kind,
      index: sectionIndex,
      bars: section.bars,
      startBar,
      endBar: startBar + section.bars,
      energy: section.energy,
      tension: section.tension,
      events: sectionEvents.length,
    });
    bar += section.bars;
  });

  events.sort((a, b) => (a.t - b.t) || a.role.localeCompare(b.role));
  return { events, bars: bar, bpm, sections, key: info };
}

/** Палитра из IR (только известные звуки — иначе жанровая). */
function paletteRefs(ir) {
  const out = {};
  for (const [role, entry] of Object.entries(ir.palette || {})) {
    if (entry && typeof entry.ref === 'string') out[role] = entry.ref;
  }
  return out;
}

function paletteOfRole(role) {
  switch (role) {
    case 'kick': return 'bd';
    case 'snare': return 'sd';
    case 'hats': return 'hh';
    case 'perc': return 'hh';
    case 'bass':
    case 'sub': return 'sine';
    case 'chords': return 'piano';
    case 'pad': return 'triangle';
    case 'lead': return 'triangle';
    case 'arp': return 'square';
    default: return 'pink';
  }
}

/** Ударные: сетка 1/16 с микротаймингом из шаблона грува. */
function drumEvents({ ir, section, role, level, sample, startBar, bpm }) {
  const templateRole = role === 'perc' ? 'hats' : role;
  const steps = grooveSteps({
    template: ir.groove.template,
    role: templateRole,
    bpm,
    amount: ir.groove.amount,
    swing: ir.groove.swing,
    offsetMs: ir.groove.offsetMs,
    density: layerDensity(section, role),
    seed: ir.seed,
    address: `${section.id}:${role}`,
  });
  const out = [];
  // Рисунок повторяется на каждом такте секции: `arrange` раскладывает
  // паттерн на все такты секции, а паттерн сам живёт в одном цикле.
  for (let barIndex = 0; barIndex < section.bars; barIndex += 1) {
    for (const step of steps) {
      const t = startBar + barIndex + step.step / 16 + msToCycles(step.offsetMs, bpm);
      out.push({
        role,
        t,
        dur: 1 / 16,
        pitches: [],
        vel: round3(step.velocity * level),
        sample,
        section: section.index,
        bar: startBar + barIndex,
      });
    }
  }
  return out;
}

/** Плотность слоя (в IR она на слое, а не на треке). */
function layerDensity(section, role) {
  return section.layers[role]?.density ?? 1;
}

/** Бас: корни аккордов на ритме роли, октава — из регистра роли. */
function bassEvents({ ir, section, role, level, sample, perBar, startBar, info }) {
  const rhythm = bassRhythm(ir);
  const tokens = rhythm.trim().split(/\s+/);
  const octave = bassOctaveOf(section.layers[role]);
  const out = [];
  for (let barIndex = 0; barIndex < section.bars; barIndex += 1) {
    const symbol = perBar[barIndex];
    if (!symbol) continue;
    const parsed = chordShape(symbol);
    if (!parsed) continue;
    const midi = (octave + 1) * 12 + parsed.pc;
    for (let slot = 0; slot < tokens.length; slot += 1) {
      if (tokens[slot] !== 'x') continue;
      out.push({
        role,
        t: startBar + barIndex + slot / tokens.length,
        dur: 1 / tokens.length,
        pitches: [midi],
        vel: round3(level),
        sample,
        section: section.index,
        bar: startBar + barIndex,
      });
    }
  }
  return out;
}

/** Октава корня баса из регистра роли (MIDI 36 → октава 2). */
function bassOctaveOf(layer) {
  const register = layer?.register;
  if (!Array.isArray(register) || !Number.isFinite(register[0])) return 2;
  return Math.max(0, Math.min(7, Math.floor(register[0] / 12) - 1));
}

/** Сдвиг октавы мотива по регистру роли (в степенях лада). */
function octaveShiftOf(layer) {
  const register = layer?.register;
  if (!Array.isArray(register) || !Number.isFinite(register[0])) return 0;
  return Math.round((register[0] - 60) / 12) * 7;
}

/** Аккорды и пэды: один аккорд на такт, голоса от якоря. */
function chordEvents({ section, role, level, sample, perBar, startBar, pad }) {
  const anchor = pad ? 48 : 60;
  const out = [];
  for (let barIndex = 0; barIndex < section.bars; barIndex += 1) {
    const symbol = perBar[barIndex];
    if (!symbol) continue;
    const pitches = chordPitches(symbol, anchor);
    if (!pitches.length) continue;
    out.push({
      role,
      t: startBar + barIndex,
      dur: 1,
      pitches,
      vel: round3(level),
      sample,
      section: section.index,
      bar: startBar + barIndex,
      approximate: true,
    });
  }
  return out;
}

/** Лид: мотив в ладу тональности, 16 слотов на такт. */
function melodyEvents({ ir, section, role, level, sample, startBar, info }) {
  const layer = section.layers[role];
  const motif = resolveMotif(ir, layer, section, role);
  const shift = octaveShiftOf(layer);
  const mini = motifToMini(motif, shift / 7);
  const slots = miniSlots(mini);
  const tokens = mini.trim().split(/\s+/);
  const out = [];
  for (let barIndex = 0; barIndex < section.bars; barIndex += 1) {
    for (const slot of slots) {
      const degree = Number(tokens[slot]);
      if (!Number.isFinite(degree)) continue;
      const midi = degreeToMidi(degree, info);
      if (midi === null) continue;
      out.push({
        role,
        t: startBar + barIndex + slot / 16,
        dur: 1 / 16,
        pitches: [midi],
        vel: round3(level),
        sample,
        section: section.index,
        bar: startBar + barIndex,
      });
    }
  }
  return out;
}

/** Арпеджио: 12 слотов на такт (fast(2) по шести нотам). */
function arpEvents({ section, role, level, sample, startBar, info }) {
  const degrees = [0, 2, 4, 7, 4, 2];
  const out = [];
  for (let barIndex = 0; barIndex < section.bars; barIndex += 1) {
    for (let i = 0; i < 12; i += 1) {
      const midi = degreeToMidi(degrees[i % degrees.length], info);
      if (midi === null) continue;
      out.push({
        role,
        t: startBar + barIndex + i / 12,
        dur: 1 / 12,
        pitches: [midi],
        vel: round3(level),
        sample,
        section: section.index,
        bar: startBar + barIndex,
      });
    }
  }
  return out;
}

/** Шумовая подложка: одно событие на такт. */
function noiseEvents({ section, role, level, sample, startBar }) {
  const out = [];
  for (let barIndex = 0; barIndex < section.bars; barIndex += 1) {
    out.push({
      role,
      t: startBar + barIndex,
      dur: 1,
      pitches: [],
      vel: round3(level),
      sample,
      section: section.index,
      bar: startBar + barIndex,
    });
  }
  return out;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
