// Метрики v2: измеряем РАЗВИТИЕ трека, а не один его цикл.
//
// Источник истины — события настоящего Strudel (`runStrudel`), а не собственный
// парсер mini-нотации. Причина зафиксирована в docs/DECISIONS.md (D-001): свой
// парсер разбирает один-два такта и не понимает `arrange`, `stack`, `<…>/n`,
// `.slow`, `.mask`, `.struct`. На `<0 5 2 6>/2` он даёт 1 событие, Strudel — 4.
//
// Что измеряем, по кадрам (окнам в 4 такта):
//   • энергия E_b = 0.5·A_b/A_max + 0.5·D_b/D_max;
//   • гармонический ритм и смены аккордов;
//   • новизна соседних окон (и доля почти-повторов);
//   • вариативность рисунка каждой партии;
//   • разнообразие партий (Жаккар сеток онсетов);
//   • автоматизация параметров.
//
// Все расчёты детерминированы и по коду: никакого FFT, никакого звука.

import { runStrudel } from '../strudel-runtime.mjs';
import { noteToMidi, pitchClass } from '../notes.js';
import { formsForStyle } from '../knowledge/forms.js';
import { scanCalls } from '../extract.js';

/** Окно анализа в тактах. */
export const WINDOW_BARS = 4;

/** Порог «почти-повтор»: расстояние между окнами меньше этого — тот же материал. */
export const NEAR_REPEAT_EPS = 0.08;

/**
 * Стили, где одна гармония держится долго — это норма, а не дефект.
 * В этих стилях флаг «обои» не ставится.
 */
export const PEDAL_STYLES = new Set(['ambient', 'lofi', 'cinematic']);

/**
 * Целевые диапазоны динамического диапазона энергии по стилям.
 * Электронные жанры — широкие (интро и дроп различаются сильно),
 * lo-fi и эмбиент — узкие (трек ровный по замыслу).
 */
export const ENERGY_RANGE_TARGETS = {
  techno: [0.25, 0.6],
  house: [0.25, 0.6],
  dnb: [0.25, 0.65],
  trap: [0.2, 0.55],
  synthwave: [0.2, 0.55],
  lofi: [0.08, 0.3],
  ambient: [0.05, 0.25],
  jazz: [0.1, 0.35],
  rock: [0.2, 0.55],
  cinematic: [0.15, 0.5],
  generic: [0.1, 0.5],
};

/**
 * Пороги новизны: ниже — «развития нет», выше — «хаос».
 */
export const NOVELTY_LOW = 0.05;
export const NOVELTY_HIGH = 0.6;

/** Цели по доле уникальных тактов партии. */
export const VARIATION_TARGETS = {
  melodic: 0.3,
  percussive: 0.15,
};

/**
 * Партии, которые считаются гармоническими: их высоты образуют аккорды.
 */
const HARMONIC_HINT = /BASS|SUB|PAD|CHORD|ARP|LEAD|KEY|BASSLINE|STR|PAD/i;

/** Партии-ударные: у них нет высот, только ритм. */
const PERCUSSIVE_HINT = /KICK|SNARE|HAT|PERC|DRUM|DR\b|CLAP|RIM|TOM/i;

/**
 * Роль партии по её метке и по наличию высот.
 * @param {string} label метка партии ($BASS → BASS)
 * @param {Array} events события партии
 */
export function roleOf(label, events) {
  const upper = String(label || '').toUpperCase();
  const hasPitch = events.some((e) => typeof e.value?.note === 'string');
  if (PERCUSSIVE_HINT.test(upper) && !hasPitch) return 'percussive';
  if (HARMONIC_HINT.test(upper) && hasPitch) return 'harmonic';
  if (hasPitch) return 'harmonic';
  return 'percussive';
}

/**
 * Значение параметра из события. `note` и `s` — не параметры, а содержание.
 */
const PARAM_KEYS = ['gain', 'cutoff', 'room', 'pan', 'speed', 'shape', 'crush', 'delay', 'hcutoff'];

function paramsOf(event) {
  const value = event?.value;
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of PARAM_KEYS) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  // Некоторые эффекты Strudel кладут значение под своим именем.
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'note' || key === 's') continue;
    if (PARAM_KEYS.includes(key)) continue;
    if (typeof raw === 'number') out[key] = raw;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Длина трека в тактах — по блокам `arrange`.
 *
 * ПОЧЕМУ НЕ ПО СОБЫТИЯМ: `arrange` зацикливает материал, поэтому события
 * идут бесконечно и по ним длину не определить. А длина нужна: без неё
 * не сработает правило «трек короче 16 тактов — нет формы».
 *
 * `arrange([4, A], [8, B])` — это 12 тактов. Разбирается существующим
 * сканером вызовов (extract.js), а не регуляркой.
 *
 * @param {string} code
 * @returns {number} такты, 0 — если arrange не найден
 */
export function arrangeLength(code) {
  const calls = scanCalls(String(code ?? '')).filter((call) => call.name === 'arrange' && !call.method);
  let best = 0;
  for (const call of calls) {
    let total = 0;
    let found = false;
    for (const arg of call.args) {
      // Блок вида [4, PATTERN] — берём первое число.
      const m = String(arg).match(/^\s*\[?\s*(\d+)/);
      if (!m) continue;
      total += Number(m[1]);
      found = true;
    }
    if (found && total > best) best = total;
  }
  return best;
}

/**
 * Анализирует трек по событиям Strudel.
 *
 * @param {string} code Strudel-код
 * @param {object} [options]
 * @param {number} [options.cycles] сколько тактов опросить (по умолчанию 64)
 * @param {string} [options.style] стиль — для целевых диапазонов и формы
 * @returns {Promise<object>} метрики v2
 */
export async function analyzeProgression(code, { cycles = 64, style = 'generic' } = {}) {
  const run = await runStrudel(code, { cycles });
  const errors = run.error ? [run.error] : [];

  // --- события по партиям ---
  const parts = [];
  for (const label of run.order) {
    const events = run.parts[label] || [];
    const pitched = [];
    for (const event of events) {
      const note = event.value?.note;
      const midi = typeof note === 'string' ? noteToMidi(note) : null;
      pitched.push({ ...event, midi });
    }
    parts.push({
      label,
      role: roleOf(label, events),
      events,
      pitched,
      midis: pitched.filter((e) => e.midi !== null).map((e) => e.midi),
    });
  }

  // Длина трека — по блокам arrange: arrange зацикливает материал, поэтому
  // по событиям длину не определить. Если arrange не найден (свободный код),
  // берём горизонт опроса.
  const arranged = arrangeLength(code);
  const totalBars = Math.max(1, arranged ? Math.min(cycles, arranged) : Math.ceil(cycles));
  const frames = buildFrames(parts, totalBars);
  const windows = buildWindows(frames);
  const totalEvents = parts.reduce((sum, part) => sum + part.events.length, 0);

  return {
    ok: run.ok && totalEvents > 0,
    errors,
    bars: totalBars,
    parts: parts.map((part) => ({
      label: part.label,
      role: part.role,
      onsets: part.events.length,
      notes: part.midis.length,
      minMidi: part.midis.length ? Math.min(...part.midis) : null,
      maxMidi: part.midis.length ? Math.max(...part.midis) : null,
    })),
    frames,
    windows,
    energy: energyMetrics(frames, windows, style),
    harmony: harmonyMetrics(parts, totalBars, style),
    novelty: noveltyMetrics(windows),
    variability: variabilityMetrics(parts, totalBars),
    diversity: diversityMetrics(parts),
    automation: automationMetrics(parts),
  };
}

/**
 * Кадры по тактам: активные партии, плотность, гистограмма, регистр.
 */
function buildFrames(parts, totalBars) {
  const frames = [];
  for (let bar = 0; bar < totalBars; bar += 1) {
    let onsets = 0;
    let activeParts = 0;
    const histogram = new Array(12).fill(0);
    const midis = [];
    const roots = new Set();
    const chordPcs = new Set();

    for (const part of parts) {
      let partHasEvent = false;
      for (const event of part.pitched) {
        const begin = event.whole?.begin ?? 0;
        if (begin < bar || begin >= bar + 1) continue;
        partHasEvent = true;
        onsets += 1;
        if (event.midi === null) continue;
        midis.push(event.midi);
        if (part.role === 'harmonic') {
          const pc = pitchClass(event.midi);
          histogram[pc] += 1;
          chordPcs.add(pc);
        }
      }
      if (partHasEvent) activeParts += 1;
    }

    // Корень гармонии — самый низкий класс высоты в баре: он задаёт основу.
    if (chordPcs.size) {
      const lowest = midis.length ? Math.min(...midis) : null;
      if (lowest !== null) roots.add(pitchClass(lowest));
    }

    const total = histogram.reduce((sum, n) => sum + n, 0) || 1;
    frames.push({
      bar,
      activeParts,
      onsets,
      density: onsets,
      histogram: histogram.map((n) => n / total),
      centroid: midis.length ? midis.reduce((s, m) => s + m, 0) / midis.length : null,
      roots: [...roots].sort((a, b) => a - b),
      chordPcs: [...chordPcs].sort((a, b) => a - b),
    });
  }
  return frames;
}

/** Окна по 4 такта: усреднение кадров. */
function buildWindows(frames) {
  const windows = [];
  for (let start = 0; start < frames.length; start += WINDOW_BARS) {
    const slice = frames.slice(start, start + WINDOW_BARS);
    if (!slice.length) break;
    const histogram = new Array(12).fill(0);
    let density = 0;
    let activeParts = 0;
    const centroids = [];
    for (const frame of slice) {
      density += frame.density;
      activeParts += frame.activeParts;
      for (let i = 0; i < 12; i += 1) histogram[i] += frame.histogram[i];
      if (frame.centroid !== null) centroids.push(frame.centroid);
    }
    const total = histogram.reduce((sum, n) => sum + n, 0) || 1;
    windows.push({
      startBar: start,
      bars: slice.length,
      density: density / slice.length,
      activeParts: activeParts / slice.length,
      histogram: histogram.map((n) => n / total),
      centroid: centroids.length
        ? centroids.reduce((s, c) => s + c, 0) / centroids.length
        : null,
    });
  }
  return windows;
}

/* --- 1. Энергия --- */

/**
 * Кривая энергии, динамический диапазон и сходство с кривой формы.
 */
export function energyMetrics(frames, windows, style) {
  const maxA = Math.max(1, ...frames.map((f) => f.activeParts));
  const maxD = Math.max(1, ...frames.map((f) => f.density));
  const curve = frames.map((f) => 0.5 * (f.activeParts / maxA) + 0.5 * (f.density / maxD));

  const sorted = [...curve].sort((a, b) => a - b);
  const percentile = (p) => {
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[index];
  };
  const dynamicRange = percentile(0.9) - percentile(0.1);

  // Сходство с кривой шаблона формы: 1 − нормированный L1.
  const target = ENERGY_RANGE_TARGETS[style] || ENERGY_RANGE_TARGETS.generic;
  const [low, high] = target;
  const expected = curve.map((_, index) => {
    // Форма трека: энергия идёт волной — низ в начале, пик в середине.
    const position = curve.length > 1 ? index / (curve.length - 1) : 0;
    return low + (high - low) * Math.sin(Math.PI * position);
  });
  const l1 = curve.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0);
  const formSimilarity = curve.length ? Math.max(0, 1 - l1 / curve.length) : 0;

  return {
    curve,
    dynamicRange,
    formSimilarity,
    // Целевой диапазон размаха — как в ENERGY_RANGE_TARGETS: [минимум, максимум].
    target: [low, high],
    inRange: dynamicRange >= low && dynamicRange <= high,
    max: curve.length ? Math.max(...curve) : 0,
    min: curve.length ? Math.min(...curve) : 0,
  };
}

/* --- 2. Гармонический ритм --- */

/**
 * Смены аккордов, разнообразие гармонии и флаг «обои».
 */
export function harmonyMetrics(parts, totalBars, style) {
  // Аккорд в такте — множество классов высот гармонических партий.
  const perBar = [];
  for (let bar = 0; bar < totalBars; bar += 1) {
    const pcs = new Set();
    for (const part of parts) {
      if (part.role !== 'harmonic') continue;
      for (const event of part.pitched) {
        const begin = event.whole?.begin ?? 0;
        if (begin < bar || begin >= bar + 1) continue;
        if (event.midi === null) continue;
        pcs.add(pitchClass(event.midi));
      }
    }
    perBar.push([...pcs].sort((a, b) => a - b));
  }

  // Смена аккорда: аккорд бара отличается от предыдущего.
  const changes = [];
  for (let bar = 1; bar < perBar.length; bar += 1) {
    const before = perBar[bar - 1];
    const after = perBar[bar];
    if (!before.length && !after.length) continue;
    if (before.join(',') !== after.join(',')) changes.push(bar);
  }

  // Расстояние между соседними аккордами — Жаккар по множествам классов.
  const distances = [];
  for (let bar = 1; bar < perBar.length; bar += 1) {
    distances.push(jaccard(perBar[bar - 1], perBar[bar]));
  }

  // Самая длинная полоса одной гармонии подряд.
  let longest = 0;
  let current = 0;
  let currentKey = '';
  for (const pcs of perBar) {
    const key = pcs.join(',');
    if (key === currentKey) current += 1;
    else {
      current = 1;
      currentKey = key;
    }
    if (current > longest) longest = current;
  }

  const distinct = new Set(perBar.filter((pcs) => pcs.length).map((pcs) => pcs.join(','))).size;
  const changesPer4Bars = totalBars ? (changes.length / totalBars) * 4 : 0;

  const pedal = PEDAL_STYLES.has(style);
  const wallpaper = !pedal && longest > 8
    ? { flag: true, bars: longest, from: longest ? 0 : 0, to: longest }
    : { flag: false, bars: longest, from: 0, to: longest };

  return {
    changes: changes.length,
    changesPer4Bars,
    distinct,
    distinctRatio: totalBars ? distinct / totalBars : 0,
    distances,
    meanDistance: distances.length ? distances.reduce((s, d) => s + d, 0) / distances.length : 0,
    longestRun: longest,
    wallpaper,
    pedal,
    perBar,
  };
}

/** Жаккар двух множеств. */
export function jaccard(a, b) {
  const setA = a instanceof Set ? a : new Set(a || []);
  const setB = b instanceof Set ? b : new Set(b || []);
  if (!setA.size && !setB.size) return 1;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}

/* --- 3. Новизна секций --- */

/**
 * Расстояние между соседними окнами и доля почти-повторов.
 */
export function noveltyMetrics(windows) {
  const vectors = windows.map((w) => ({
    histogram: w.histogram,
    density: w.density,
    activeParts: w.activeParts,
    centroid: w.centroid ?? 0,
  }));

  const distances = [];
  for (let i = 1; i < vectors.length; i += 1) {
    distances.push(windowDistance(vectors[i - 1], vectors[i]));
  }

  // Почти-повторы: окно, похожее на ОДНО из более ранних.
  let nearRepeats = 0;
  for (let i = 1; i < vectors.length; i += 1) {
    let best = Infinity;
    for (let j = 0; j < i; j += 1) {
      const d = windowDistance(vectors[j], vectors[i]);
      if (d < best) best = d;
    }
    if (best < NEAR_REPEAT_EPS) nearRepeats += 1;
  }

  const mean = distances.length ? distances.reduce((s, d) => s + d, 0) / distances.length : 0;
  const max = distances.length ? Math.max(...distances) : 0;

  return {
    distances,
    mean,
    max,
    nearRepeatShare: windows.length > 1 ? nearRepeats / (windows.length - 1) : 0,
    developing: mean > NOVELTY_LOW,
    chaotic: max > NOVELTY_HIGH,
    thresholds: { low: NOVELTY_LOW, high: NOVELTY_HIGH, eps: NEAR_REPEAT_EPS },
  };
}

/**
 * Расстояние между окнами по вектору [H, D, A, регистр].
 *
 * Гистограмма сравнивается по L1, остальные компоненты — по разнице
 * нормированных величин. Всё приводится к [0, 1].
 */
export function windowDistance(a, b) {
  const histogram = a.histogram.reduce((sum, value, index) => sum + Math.abs(value - b.histogram[index]), 0) / 2;
  const density = Math.min(1, Math.abs(a.density - b.density) / 16);
  const parts = Math.min(1, Math.abs(a.activeParts - b.activeParts) / 8);
  const centroid = Math.min(1, Math.abs(a.centroid - b.centroid) / 48);
  return (histogram + density + parts + centroid) / 4;
}

/* --- 4. Вариативность по партиям --- */

/**
 * Доля уникальных рисунков партии.
 *
 * Уникальность считается по ОКНАМ (4 такта), а не по отдельным тактам.
 * Причина: в треке с секциями по 8–16 тактов рисунок внутри секции
 * закономерно один и тот же, и доля уникальных ТАКТОВ падает
 * математически (6 уникальных из 64 = 0.09) — цель 0.15/0.3 становится
 * недостижимой для любого нормального трека. По окнам тот же трек даёт
 * 6–8 уникальных окон из 16 — это и есть «рисунок меняется по ходу трека».
 *
 * Внутри окна рисунок описывается сеткой онсетов и классами высот.
 */
export function variabilityMetrics(parts, totalBars) {
  const perPart = {};
  let bassIdentical = null;
  const windowCount = Math.ceil(totalBars / WINDOW_BARS);

  for (const part of parts) {
    // Окна партии: сетка онсетов + классы высот внутри окна.
    const windowKeys = [];
    for (let start = 0; start < totalBars; start += WINDOW_BARS) {
      const onsets = [];
      const pcs = [];
      for (const event of part.pitched) {
        const begin = event.whole?.begin ?? 0;
        if (begin < start || begin >= start + WINDOW_BARS) continue;
        onsets.push(Math.round((begin - start) * 16));
        if (event.midi !== null) pcs.push(pitchClass(event.midi));
      }
      windowKeys.push(`${onsets.join(',')}|${pcs.join(',')}`);
    }

    const nonEmpty = windowKeys.filter((key) => key !== '|');
    const unique = new Set(nonEmpty).size;
    const uniqueRatio = nonEmpty.length ? unique / nonEmpty.length : 0;

    // Фразовые n-граммы: сколько раз встречается тройка окон подряд.
    const phrases = new Map();
    for (let i = 0; i + 2 < windowKeys.length; i += 1) {
      const gram = `${windowKeys[i]}>${windowKeys[i + 1]}>${windowKeys[i + 2]}`;
      phrases.set(gram, (phrases.get(gram) || 0) + 1);
    }
    const phraseCounts = [...phrases.values()];
    const phraseDiversity = phrases.size
      ? new Set(phraseCounts).size / Math.max(...phraseCounts)
      : 0;

    perPart[part.label] = {
      role: part.role,
      uniqueRatio,
      uniqueWindows: unique,
      totalWindows: nonEmpty.length,
      windowCount,
      phraseDiversity,
      target: part.role === 'percussive'
        ? VARIATION_TARGETS.percussive
        : VARIATION_TARGETS.melodic,
    };

    // «Бас идентичен»: два куска трека с одинаковым рисунком баса.
    if (/BASS/i.test(part.label) && !bassIdentical) {
      bassIdentical = findIdenticalSpan(windowKeys, WINDOW_BARS);
    }
  }

  return {
    perPart,
    bassIdentical,
    targets: VARIATION_TARGETS,
  };
}

/**
 * Ищет два одинаковых куска рисунка баса (не менее 8 тактов подряд).
 * @returns {{from:number,to:number,bars:number}|null}
 */
function findIdenticalSpan(windowKeys, barsPerWindow) {
  const MIN_BARS = 8;
  const minWindows = Math.max(2, Math.ceil(MIN_BARS / barsPerWindow));
  const span = Math.floor(windowKeys.length / 2);
  for (let length = span; length >= minWindows; length -= 1) {
    for (let start = 0; start + length <= windowKeys.length; start += 1) {
      const first = windowKeys.slice(start, start + length).join('|');
      for (let other = start + length; other + length <= windowKeys.length; other += 1) {
        const second = windowKeys.slice(other, other + length).join('|');
        if (first === second) {
          return {
            from: start * barsPerWindow,
            to: (start + length) * barsPerWindow - 1,
            bars: length * barsPerWindow,
          };
        }
      }
    }
  }
  return null;
}

/* --- 5. Разнообразие партий --- */

/**
 * Попарный Жаккар сеток онсетов и число ролей/регистров.
 */
export function diversityMetrics(parts) {
  const grids = parts.map((part) => {
    const set = new Set();
    for (const event of part.events) {
      const begin = event.whole?.begin ?? 0;
      set.add(Math.round(begin * 16));
    }
    return set;
  });

  const pairs = [];
  for (let i = 0; i < grids.length; i += 1) {
    for (let j = i + 1; j < grids.length; j += 1) {
      pairs.push(jaccard(grids[i], grids[j]));
    }
  }

  const roles = new Set(parts.map((p) => p.role));
  const registers = new Set(
    parts
      .filter((p) => p.midis.length)
      .map((p) => Math.round((p.midis.reduce((s, m) => s + m, 0) / p.midis.length) / 12)),
  );

  return {
    meanJaccard: pairs.length ? pairs.reduce((s, d) => s + d, 0) / pairs.length : 0,
    maxJaccard: pairs.length ? Math.max(...pairs) : 0,
    pairs: pairs.length,
    roles: roles.size,
    registers: registers.size,
    parts: parts.length,
  };
}

/* --- 6. Автоматизация --- */

/**
 * Доля параметров эффектов, значение которых меняется во времени.
 *
 * Считается по ЗНАЧЕНИЯМ СОБЫТИЙ, а не по тексту: статичное `.gain(0.5)`
 * даёт одно и то же значение в каждом событии — это не автоматизация.
 * Чередующийся паттерн `<0.3 0.9>` и сигнал `sine.slow(4).range(0.2, 0.9)`
 * дают разные значения — это автоматизация.
 */
export function automationMetrics(parts) {
  let automated = 0;
  let total = 0;
  const details = [];

  for (const part of parts) {
    // Значение параметра по событию.
    const byParam = new Map();
    for (const event of part.events) {
      const params = paramsOf(event);
      if (!params) continue;
      for (const [key, raw] of Object.entries(params)) {
        if (!byParam.has(key)) byParam.set(key, []);
        byParam.get(key).push(raw);
      }
    }

    for (const [key, values] of byParam.entries()) {
      if (values.length < 2) continue;
      total += 1;
      const distinct = new Set(values.map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
      const isAutomated = distinct.size > 1;
      if (isAutomated) automated += 1;
      details.push({
        part: part.label,
        param: key,
        automated: isAutomated,
        distinct: distinct.size,
      });
    }
  }

  return {
    ratio: total ? automated / total : 0,
    automated,
    total,
    details,
  };
}

/**
 * Целевая кривая энергии для стиля — из формы библиотеки.
 * Используется как эталон сходства.
 */
export function templateEnergyCurve(style, length) {
  const forms = formsForStyle(style);
  const form = forms[0];
  if (!form) return null;
  const energies = form.sections.map((s) => s.energy);
  const curve = [];
  for (let i = 0; i < length; i += 1) {
    const position = (i / Math.max(1, length - 1)) * (energies.length - 1);
    const index = Math.min(energies.length - 2, Math.floor(position));
    const frac = position - index;
    curve.push(energies[index] * (1 - frac) + energies[index + 1] * frac);
  }
  return curve;
}
