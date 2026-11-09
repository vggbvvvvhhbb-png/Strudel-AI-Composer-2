// Извлечение музыкального содержания из Strudel-кода: партии, паттерны, цепочки.
//
// Разбор сделан сканером по символам, а не регулярками: код генерирует LLM,
// поэтому встречаются вложенные вызовы, строки в одинарных кавычках и т.д.
// Регулярки здесь давали бы ложные срабатывания на мусорных фрагментах.

import { parseMini } from './mini.js';
import { parseKey, noteToMidi, degreeToMidi, chordToMidi } from './notes.js';
import { getBpm, getKey } from '../../src/core/code-model.js';

// Сэмплы ударных: по ним партия опознаётся как барабаны.
const DRUM_NAMES = new Set([
  'bd', 'sd', 'hh', 'hh27', 'cp', 'oh', 'perc', 'clap', 'rim', 'tom', 'cowbell',
  '808', '808bd', '808sd', '808oh', '808mc', '808ht', '808lc', '909',
  'breaks125', 'breaks152', 'breaks157', 'breaks165', 'realclaps',
  'sh', 'rave', 'gab', 'industrial', 'jungle', 'techno', 'dr', 'dr2', 'dr55', 'house',
]);

// Синтезаторы Strudel — если s() содержит их, партия мелодическая, а не ударная.
const SYNTH_NAMES = new Set([
  'sawtooth', 'square', 'triangle', 'sine', 'piano', 'pulse', 'supersaw', 'fm', 'am', 'organ',
]);

const PART_HEADER = /^[ \t]*([_S]?)\$[ \t]*([A-Za-z]\w*)?[ \t]*:/;

// Методы цепочки, влияющие на время.
const TIME_METHODS = new Set(['fast', 'slow', 'rev', 'off', 'every', 'ply', 'euclid', 'segment']);

function isIdentChar(c) {
  return /[A-Za-z0-9_$]/.test(c);
}

/**
 * Сканер вызовов в фрагменте кода.
 * Возвращает список {name, method, args, strings, start, end}.
 */
export function scanCalls(code) {
  const calls = [];
  const src = String(code ?? '');
  let i = 0;
  let prevSignificant = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      prevSignificant = 'str';
      continue;
    }
    if (isIdentChar(c) && !isIdentChar(src[i - 1] || '')) {
      const start = i;
      while (i < src.length && isIdentChar(src[i])) i += 1;
      const name = src.slice(start, i);
      const method = prevSignificant === '.';
      // Аргументы: содержимое сбалансированных скобок сразу после имени.
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] === '(') {
        const args = [];
        const strings = [];
        let depth = 0;
        let k = j;
        let argStart = j + 1;
        for (; k < src.length; k++) {
          const ch = src[k];
          if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            let value = '';
            k += 1;
            while (k < src.length) {
              if (src[k] === '\\') {
                value += src[k + 1] ?? '';
                k += 2;
                continue;
              }
              if (src[k] === quote) break;
              value += src[k];
              k += 1;
            }
            strings.push(value);
            args.push(value);
            continue;
          }
          if (ch === '(' || ch === '[' || ch === '{') depth += 1;
          else if (ch === ')' || ch === ']' || ch === '}') {
            depth -= 1;
            if (depth === 0) {
              const raw = src.slice(argStart, k).trim();
              if (raw) args.push(raw);
              break;
            }
          } else if (ch === ',' && depth === 1) {
            const raw = src.slice(argStart, k).trim();
            args.push(raw);
            argStart = k + 1;
          }
        }
        calls.push({ name, method, args, strings, start, end: Math.min(k + 1, src.length) });
        i = k + 1;
        prevSignificant = ')';
        continue;
      }
      calls.push({ name, method, args: [], strings: [], start, end: i });
      prevSignificant = 'ident';
      continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }
  return calls;
}

// Разбор числа из аргумента вида "2" или "2.5" или 2.
function numArg(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^-?\d+(\.\d+)?$/);
  return m ? Number(m[0]) : null;
}

/**
 * Убирает markdown-обёртку и посторонний текст из ответа модели.
 * LLM иногда оборачивает код в ``` ... ``` или пишет пояснение перед кодом.
 */
export function stripCodeFences(text) {
  const raw = String(text ?? '');
  const first = raw.indexOf('```');
  if (first < 0) return raw.trim();
  const body = raw.slice(first + 3);
  const nl = body.indexOf('\n');
  const withoutLang = nl >= 0 ? body.slice(nl + 1) : body;
  const second = withoutLang.indexOf('```');
  const code = second >= 0 ? withoutLang.slice(0, second) : withoutLang;
  return code.trim();
}

/**
 * Разбирает весь код на партии.
 * @returns {{bpm: number|null, key: object|null, parts: Array}}
 */
export function extractTrack(code) {
  const text = String(code ?? '');
  const lines = text.split('\n');

  // Границы партий: заголовок и следующий заголовок.
  const headers = [];
  lines.forEach((line, index) => {
    const m = line.match(PART_HEADER);
    if (m) headers.push({ line: index, label: m[2] || '', muted: m[1] === '_', solo: m[1] === 'S' });
  });

  const parts = [];
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h];
    const end = h + 1 < headers.length ? headers[h + 1].line : lines.length;
    const region = lines.slice(header.line, end).join('\n');
    const calls = scanCalls(region);
    parts.push(buildPart(header.label, header.muted, header.solo, calls, region));
  }

  const keyRaw = getKey(text);
  return {
    bpm: getBpm(text),
    key: parseKey(keyRaw),
    keyRaw,
    parts,
  };
}

function buildPart(label, muted, solo, calls, region) {
  // Паттерны — вызовы без точки: note(...), n(...), chord(...), s(...).
  const patterns = [];
  const methods = new Map();

  for (const call of calls) {
    if (call.method) {
      methods.set(call.name, call);
      continue;
    }
    if (!['note', 'n', 'chord', 's'].includes(call.name)) continue;
    const value = call.strings[0];
    if (value === undefined) continue;
    patterns.push({ kind: call.name, value });
  }

  // Цепочка времени.
  const fastCall = methods.get('fast');
  const slowCall = methods.get('slow');
  const offCall = methods.get('off');
  const revCall = methods.get('rev');
  const gainCall = methods.get('gain');
  const scaleCall = methods.get('scale');

  const chain = {
    fast: fastCall ? numArg(fastCall.args[0]) ?? null : null,
    slow: slowCall ? numArg(slowCall.args[0]) ?? null : null,
    off: offCall ? numArg(offCall.args[0]) ?? null : null,
    rev: Boolean(revCall),
    gain: gainCall ? numArg(gainCall.args[0]) ?? null : null,
    scaled: Boolean(scaleCall),
  };

  const sources = [];
  for (const p of patterns) {
    // s() без точки — паттерн сэмплов: его ритм тоже разбирается mini-нотацией.
    // .s("sawtooth") — выбор синтезатора, это метод цепочки, в паттерны не попадает.
    sources.push({ kind: p.kind, value: p.value });
  }

  return {
    label,
    muted,
    solo,
    region,
    chain,
    patterns,
    sources,
    role: detectRole(label, sources),
  };
}

function detectRole(label, sources) {
  const upper = (label || '').toUpperCase();
  const hasSample = sources.some((s) => s.kind === 's' && hasDrumToken(s.value));
  const hasPitch = sources.some((s) => s.kind === 'note' || s.kind === 'n' || s.kind === 'chord');

  if (hasPitch) {
    if (/BASS|SUB|LOW|BASSLINE/.test(upper)) return 'bass';
    if (/PAD|STR|CHORD|BED|ATMO/.test(upper)) return 'pad';
    if (/ARP|PLUCK/.test(upper)) return 'arp';
    if (/DRUM|DR|BEAT|PERC|HAT|KICK|SNARE/.test(upper)) return 'drums';
    return 'melody';
  }
  if (hasSample) {
    if (/HAT|HH/.test(upper)) return 'hats';
    return 'drums';
  }
  return 'other';
}

// Есть ли в строке паттерна хоть один настоящий сэмпл (а не имя синтезатора).
// Модификаторы отбрасываем: «bd*4» — это тот же сэмпл «bd».
function hasDrumToken(value) {
  return String(value)
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((token) => {
      const base = token
        .replace(/[*\/!@][\d.]*$/g, '')
        .replace(/^[[\]<>]+/, '')
        .replace(/[[\]<>]+$/, '');
      return DRUM_NAMES.has(base) && !SYNTH_NAMES.has(base);
    });
}

/**
 * Разворачивает паттерн партии в список событий с временем и высотами.
 *
 * @param {object} part партия из extractTrack
 * @param {object|null} key тональность трека
 * @returns {{events: Array, notes: Array<{midi:number, begin:number}>, errors: string[]}}
 */
export function partEvents(part, key) {
  const errors = [];
  const events = [];
  const notes = [];

  for (const source of part.sources) {
    const parsed = parseMini(source.value, { cycles: 2 });
    for (const err of parsed.errors) errors.push(`$ ${part.label}: ${err}`);

    for (const ev of parsed.events) {
      const value = ev.value;
      if (source.kind === 's') {
        // Сэмпл ударных — ритмическое событие без высоты.
        if (SYNTH_NAMES.has(value)) continue;
        events.push({ begin: ev.begin, end: ev.end, value, kind: 'sample', midis: [] });
        continue;
      }
      let midis = null;
      if (source.kind === 'note') {
        const midi = noteToMidi(value);
        if (midi !== null) midis = [midi];
      } else if (source.kind === 'n') {
        const degree = Number(value);
        if (Number.isFinite(degree)) {
          const midi = degreeToMidi(degree, key);
          if (midi !== null) midis = [midi];
        }
      } else if (source.kind === 'chord') {
        midis = chordToMidi(value);
      }
      events.push({
        begin: ev.begin,
        end: ev.end,
        value,
        kind: source.kind,
        midis: midis || [],
      });
    }
  }

  // Цепочка времени: fast/slow сжимают и растягивают, off сдвигает, rev переворачивает.
  const { fast, slow, off, rev } = part.chain;
  const rate = (fast || 1) / (slow || 1);
  for (const ev of events) {
    ev.begin *= rate;
    ev.end *= rate;
    if (off) ev.begin += off;
  }
  if (rev) {
    const span = Math.max(...events.map((e) => e.end), 1);
    for (const ev of events) {
      const nb = span - ev.end;
      const ne = span - ev.begin;
      ev.begin = nb;
      ev.end = ne;
    }
  }

  for (const ev of events) {
    for (const midi of ev.midis || []) {
      notes.push({ midi, begin: ev.begin, kind: ev.kind });
    }
  }

  return { events, notes, errors };
}
