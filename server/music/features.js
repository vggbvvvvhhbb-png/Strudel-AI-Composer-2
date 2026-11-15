// Музыкальные метрики трека: всё, что можно измерить объективно.
//
// Метрики считаются по коду (см. extract.js), а не по звуку: код однозначно
// задаёт высоты и ритм, поэтому разбор детерминирован и воспроизводим.
// Все величины нормализованы: время в тактах (1 такт = 1.0), высоты в MIDI.

import { extractTrack, partEvents } from './extract.js';
import { parseKey, MODES, PITCH_NAMES, pitchClass, notesOutsideScale } from './notes.js';

const EPS = 1e-6;

// Устойчивые ступени для каденции.
//
// Это тон трезвучия тоники: тоника (0), её терция (2) и квинта (4).
// В миноре это C-Eb-G в тональности c:minor, в мажоре C-E-G в c:major —
// одна и та же формула, потому что трезвучие тоники всегда состоит из
// ступеней 0, 2 и 4 лада. Доминанта (квинта тоники) входит сюда же:
// конец фразы на квинте — тоже устойчивая точка, просто половинная
// каденция, а не полное разрешение.
//
// Не входит субтоника (6) и вторая ступень в мажоре: это уже не точка
// опоры, а проходящая ступень.
const STABLE_DEGREES = new Set([0, 2, 4]);

// Одинаковый ли набор высот: секция повторяет первую или нет.
function samePitches(a, b) {
  if (!a.length || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

// Роли, в которых живёт мелодия.
//
// Прежний список ('melody', 'arp', 'bass', 'pad') не ловил почти ничего:
// роли 'melody' в проекте не существует (D-100 перенёс роль в атрибут),
// а оркестровые роли (violin, horn, choir_*) в него не входили вовсе.
// Из-за этого «движение мелодии» и «доля пауз» считались почти по пустому.
export const MELODIC_ROLES = new Set([
  'lead', 'melody', 'arp', 'pad', 'chords', 'texture', 'bass', 'sub',
  'violin', 'viola', 'cello', 'contrabass',
  'horn', 'trumpet', 'trombone', 'tuba',
  'flute', 'oboe', 'clarinet', 'bassoon',
  'piano', 'organ', 'harp',
  'choir', 'choir_soprano', 'choir_alto', 'choir_tenor', 'choir_bass',
]);

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

  // L1-метрики мелодии (фаза D): связность, развитие, каденция, энтропия.
  const melody = melodyMetrics(track, key);

  const roles = [...new Set(parts.map((p) => p.role))];

  return {
    bpm: track.bpm,
    key: key ? { name: key.name, root: key.root, mode: key.mode, declared: Boolean(declaredKey) } : null,
    detectedKey: detected ? detected.name : null,
    outsideScale: declaredKey && allNotes.length ? notesOutsideScale(allNotes, declaredKey) : [],
    parts,
    melody,
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
      // L1 мелодии — в общий набор метрик, чтобы скор их видел.
      motifCoherence: melody.motifCoherence,
      motifDevelopment: melody.motifDevelopment,
      cadenceClarity: melody.cadenceClarity,
      resolution: melody.resolution,
      contourEntropy: melody.contourEntropy,
      melodyRange: melody.melodyRange,
    },
    errors,
  };
}

// Интервалы между соседними нотами мелодических партий (в пределах такта).
function melodicMotion(track, key) {
  const intervals = new Set();
  for (const part of track.parts) {
    if (!MELODIC_ROLES.has(part.role)) continue;
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
    if (!MELODIC_ROLES.has(part.role)) continue;
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

/**
 * Ступень лада для MIDI-ноты: 0 — тоника, 4 — доминанта.
 * @param {number} midi
 * @param {object|null} key
 * @returns {number|null} ступень или null, если нота вне лада
 */
function scaleDegree(midi, key) {
  if (!key || !Array.isArray(key.intervals)) return null;
  const pc = (((midi - key.pc) % 12) + 12) % 12;
  const index = key.intervals.indexOf(pc);
  return index === -1 ? null : index;
}

/**
 * Перекрытие двух множеств интервалов: |A∩B| / min(|A|,|B|).
 *
 * Именно перекрытие, а не Жаккар: материал секции — часто НАЧАЛО общей
 * темы (хор поёт две ноты из четырёх), и мера «сколько общих интервалов
 * на двоих» сказала бы «ничего общего». Перекрытие отвечает на вопрос
 * «это часть той же темы?» — а это и есть связность.
 *
 * @param {Set<number>} a
 * @param {Set<number>} b
 * @returns {number} 0..1
 */
function overlapCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * L1-метрики мелодии (фаза D).
 *
 * Четыре вопроса, на которые должен отвечать разбор трека:
 *   • СВЯЗНОСТЬ — мелодия держится одной темой или это набор случайных
 *     нот? Транспозиция сохраняет интервальный рисунок, поэтому варианты
 *     темы (A, A') считаются родными.
 *   • РАЗВИТИЕ — мелодия идёт дальше или повторяет одно и то же? Без
 *     этого метрики статичный трек получит идеальную связность, а это
 *     ровно тот дефект, который фаза D и лечит. Развитие меряется по
 *     ВЫСОТАМ: транспозиция фразы (A' против A) сохраняет рисунок, но
 *     это развитие, а не повтор.
 *   • КАДЕНЦИОННАЯ ЯСНОСТЬ — конец фразы приходит на устойчивую ступень
 *     (тон трезвучия тоники), а не на проходящую.
 *   • КОНТУРНАЯ ЭНТРОПИЯ — насколько разнообразен контур: один интервал
 *     подряд (скучный) или настоящее движение.
 *
 * Все величины честные: если данных нет — null («нет данных»), а не 0.
 *
 * @param {object} track результат extractTrack
 * @param {object|null} key тональность
 * @returns {object} метрики мелодии
 */
export function melodyMetrics(track, key) {
  const perPart = [];
  const intervalCounts = new Map();
  const allMelodicNotes = [];
  const partIntervals = new Map();   // партия -> множество беззнаковых интервалов
  let endings = 0;
  let stableEndings = 0;
  let tonicEndings = 0;

  for (const part of track.parts) {
    if (!MELODIC_ROLES.has(part.role)) continue;
    const parsed = partEvents(part, key);
    const sections = parsed.sections.filter((section) => section.notes.length >= 2);
    if (!sections.length) continue;

    const signatures = sections.map((section) => {
      const midis = section.notes.map((note) => note.midi);
      for (const midi of midis) allMelodicNotes.push(midi);
      const signature = [];
      for (let i = 1; i < midis.length; i += 1) {
        const step = midis[i] - midis[i - 1];
        signature.push(step);
        const bucket = String(step);
        intervalCounts.set(bucket, (intervalCounts.get(bucket) ?? 0) + 1);
      }
      return signature;
    });

    // Материал партии: множество БЕЗЗНАКОВЫХ интервалов. Транспозиция
    // сохраняет рисунок, инверсия меняет знак, но не величину.
    const material = new Set();
    for (const signature of signatures) {
      for (const step of signature) material.add(Math.abs(step));
    }
    partIntervals.set(part.label, material);

    // Связность партии с остальными: перекрытие материалов.
    let coherenceSum = 0;
    let coherenceCount = 0;
    for (const [otherLabel, other] of partIntervals) {
      if (otherLabel === part.label) continue;
      coherenceSum += overlapCoefficient(material, other);
      coherenceCount += 1;
    }

    // Высоты по секциям. Развитие — это про ВЫСОТЫ: транспозиция фразы
    // сохраняет интервальный рисунок, но музыкально это уже другое
    // событие. Рисунок (интервалы) — материал связности.
    const pitches = sections.map((section) => section.notes.map((note) => note.midi));

    // Развитие: доля секций, отличных от первой.
    let different = 0;
    for (let i = 1; i < pitches.length; i += 1) {
      if (!samePitches(pitches[0], pitches[i])) different += 1;
    }

    // Каденция: последняя нота секции — устойчивая ступень?
    for (const section of sections) {
      const last = section.notes[section.notes.length - 1];
      const degree = scaleDegree(last.midi, key);
      if (degree === null) continue;
      endings += 1;
      if (degree === 0) tonicEndings += 1;
      if (STABLE_DEGREES.has(degree)) stableEndings += 1;
    }

    perPart.push({
      role: part.role,
      label: part.label,
      sections: sections.length,
      coherence: coherenceCount ? coherenceSum / coherenceCount : null,
      development: signatures.length > 1 ? different / (signatures.length - 1) : null,
    });
  }

  // Общая связность: средняя связность партии с материалом ТЕМЫ трека.
  // Тема — материал, который встречается чаще всего.
  const materialCount = new Map();
  for (const material of partIntervals.values()) {
    const key = [...material].sort((a, b) => a - b).join(',');
    materialCount.set(key, (materialCount.get(key) ?? 0) + 1);
  }
  let themeMaterial = null;
  let themeHits = 0;
  for (const [key, count] of materialCount) {
    if (count > themeHits) {
      themeHits = count;
      themeMaterial = new Set(key.split(',').filter(Boolean).map(Number));
    }
  }
  const coherences = themeMaterial
    ? [...partIntervals.values()].map((material) => overlapCoefficient(material, themeMaterial))
    : [];
  const developments = perPart.map((item) => item.development).filter((value) => value !== null);

  // Энтропия распределения интервалов: 0 — всегда один и тот же интервал,
  // 1 — равномерное разнообразие.
  let entropy = null;
  const totalIntervals = [...intervalCounts.values()].reduce((sum, value) => sum + value, 0);
  if (totalIntervals > 0 && intervalCounts.size > 1) {
    let h = 0;
    for (const count of intervalCounts.values()) {
      const p = count / totalIntervals;
      h -= p * Math.log(p);
    }
    entropy = h / Math.log(intervalCounts.size);
  }

  return {
    motifCoherence: coherences.length ? coherences.reduce((a, b) => a + b, 0) / coherences.length : null,
    motifDevelopment: developments.length ? developments.reduce((a, b) => a + b, 0) / developments.length : null,
    cadenceClarity: endings ? stableEndings / endings : null,
    resolution: endings ? tonicEndings / endings : null,
    contourEntropy: entropy,
    melodyRange: allMelodicNotes.length
      ? Math.max(...allMelodicNotes) - Math.min(...allMelodicNotes)
      : null,
    melodicParts: perPart.length,
    endings,
    parts: perPart,
  };
}
