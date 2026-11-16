// Паспорт разбора → фичи для библиотеки стилей (D-112).
//
// ЗАЧЕМ. Глубокие разборы треков учили только человека: из отчёта нельзя
// было взять числа, на которых строится следующий трек. Этот модуль
// превращает паспорт в набор СТАТИСТИК, по которым композитор выбирает
// грув, энергию и тембр.
//
// ЛИЦЕНЗИОННАЯ ЧИСТОТА. Из паспорта берутся только распределения и факты:
// темп, лад, гистограмма атак, кривая энергии, спектральные центроиды.
// НОТНЫЕ ПОСЛЕДОВАТЕЛЬНОСТИ не копируются — из источника не переносится ни
// тройка подряд идущих высот. Поэтому библиотека не является переработкой
// чужих мелодий: это статистика, а не материал.
//
// ЧЕСТНОСТЬ. Чего в паспорте нет — null. «Нет данных» ≠ 0.

/** Число слотов в гистограмме атак: шестнадцать. */
export const ONSET_SLOTS = 16;

/**
 * Нормализация: число или null.
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * Гистограмма атак по шестнадцати долям такта.
 *
 * Считается из измеренных ударов: доля каждой доли от всех ударов. Сумма
 * гистограммы равна 1 — это доля, а не количество.
 *
 * @param {Array} hits измеренные удары {time_s}
 * @param {number|null} bpm темп (нужен, чтобы найти начало такта)
 * @returns {number[]|null}
 */
export function onsetHistogram16(hits, bpm) {
  if (!Array.isArray(hits) || !hits.length || !Number.isFinite(bpm) || bpm <= 0) return null;
  const secondsPerBeat = 60 / bpm;
  const counts = new Array(ONSET_SLOTS).fill(0);
  let total = 0;
  for (const hit of hits) {
    const time = Number(hit?.time_s);
    if (!Number.isFinite(time)) continue;
    const position = time / secondsPerBeat;
    const slot = Math.floor(((position % 4) + 4) % 4 * 4) % ONSET_SLOTS;
    counts[slot] += 1;
    total += 1;
  }
  if (!total) return null;
  const histogram = counts.map((value) => Number((value / total).toFixed(6)));
  // Сумма после округления может отличаться на 1e-6 — правим последним.
  const diff = Number((1 - histogram.reduce((sum, value) => sum + value, 0)).toFixed(6));
  histogram[0] = Number((histogram[0] + diff).toFixed(6));
  return histogram;
}

/**
 * Вес бэкбита: доля ударов на второй и четвёртой долях такта.
 * @param {Array} hits
 * @param {number|null} bpm
 * @returns {number|null}
 */
export function backbeatWeight(hits, bpm) {
  if (!Array.isArray(hits) || !hits.length || !Number.isFinite(bpm) || bpm <= 0) return null;
  const secondsPerBeat = 60 / bpm;
  let onBackbeat = 0;
  let total = 0;
  for (const hit of hits) {
    const time = Number(hit?.time_s);
    if (!Number.isFinite(time)) continue;
    const beat = Math.round(time / secondsPerBeat);
    const inBar = ((beat % 4) + 4) % 4;
    if (inBar === 1 || inBar === 3) onBackbeat += 1;
    total += 1;
  }
  if (!total) return null;
  return Number((onBackbeat / total).toFixed(6));
}

/**
 * Распределение интервалов между нотами: шаги от −12 до +12.
 *
 * Ноты берутся из измеренных MIDI-данных паспорта (если разбор их посчитал).
 * Если нот нет — null: выдумывать распределение нельзя.
 *
 * @param {Array<number>} midi ноты в порядке звучания
 * @returns {object|null}
 */
export function intervalDistribution(midi) {
  if (!Array.isArray(midi) || midi.length < 2) return null;
  const distribution = {};
  for (let i = 0; i < midi.length - 1; i += 1) {
    const step = Math.round(midi[i + 1] - midi[i]);
    if (!Number.isFinite(step) || Math.abs(step) > 12) continue;
    distribution[step] = Number(((distribution[step] ?? 0) + 1).toFixed(6));
  }
  if (!Object.keys(distribution).length) return null;
  const total = Object.values(distribution).reduce((sum, value) => sum + value, 0);
  for (const key of Object.keys(distribution)) {
    distribution[key] = Number((distribution[key] / total).toFixed(6));
  }
  return distribution;
}

/**
 * Энтропия распределения (нормированная, 0..1).
 * @param {object|null} distribution
 * @returns {number|null}
 */
export function normalizedEntropy(distribution) {
  if (!distribution || typeof distribution !== 'object') return null;
  const values = Object.values(distribution).filter((value) => value > 0);
  if (!values.length) return null;
  const entropy = -values.reduce((sum, value) => sum + value * Math.log2(value), 0);
  return Number((entropy / Math.log2(values.length)).toFixed(6));
}

/**
 * Диапазон высот в полутонах.
 * @param {Array<number>} midi
 * @returns {number|null}
 */
export function rangeSemitones(midi) {
  if (!Array.isArray(midi) || !midi.length) return null;
  const values = midi.map(Number).filter(Number.isFinite);
  if (!values.length) return null;
  return Math.max(...values) - Math.min(...values);
}

/**
 * Доля пауз: тишина между нотами против общей длины.
 * @param {Array<number>} midi
 * @param {number|null} [stepSec]
 * @returns {number|null}
 */
export function pauseShare(midi, stepSec = null) {
  if (!Array.isArray(midi) || midi.length < 2 || !Number.isFinite(stepSec) || stepSec <= 0) return null;
  const sorted = midi.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  let gaps = 0;
  let total = 0;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const gap = sorted[i + 1] - sorted[i];
    total += gap;
    if (gap > stepSec * 1.5) gaps += 1;
  }
  if (!total) return null;
  return Number((gaps / (sorted.length - 1)).toFixed(6));
}

/**
 * Фичи одного паспорта.
 *
 * @param {object} passport результат задачи разбора (job.json → result)
 * @param {{style?:string|null}} [options] стиль — в паспорте его нет
 * @returns {object} фичи по схеме ТЗ; всё неизвестное — null
 */
export function extractFeatures(passport, { style = null } = {}) {
  const source = passport ?? {};
  const measurements = source.measurements ?? {};
  const tempo = measurements.tempo ?? {};
  const key = measurements.key ?? {};
  const drums = source.stem_descriptors?.drums?.onsets ?? null;
  const hits = Array.isArray(drums?.hits) ? drums.hits : null;
  const bpm = num(tempo.bpm);

  const melodic = melodicNotes(source);
  const interval = intervalDistribution(melodic);

  const sections = Array.isArray(source.structure) ? source.structure : [];
  const curve = sections.length
    ? sections.map((section) => Number(num(section?.energy) ?? 0)).map((value) => Math.max(0, Math.min(1, value)))
    : null;
  const peakPosition = curve && curve.length
    ? Number((curve.indexOf(Math.max(...curve)) / curve.length).toFixed(6))
    : null;

  return {
    sourceJobId: source.track?.id ?? null,
    style: style ?? null,
    bpm,
    key: key.tonic ? `${key.tonic} ${key.mode ?? 'unknown'}` : null,
    groove: {
      onsetHistogram16: onsetHistogram16(hits, bpm),
      swingRatio: num(drums?.swing),
      backbeatWeight: backbeatWeight(hits, bpm),
    },
    contour: {
      intervalDistribution: interval,
      entropy: normalizedEntropy(interval),
      rangeSemitones: rangeSemitones(melodic),
      pauseShare: pauseShare(melodic, bpm ? 60 / bpm / 2 : null),
    },
    energy: {
      perSectionCurve: curve,
      peakPosition,
    },
    timbre: {
      byRole: timbreByRole(source),
    },
  };
}

/**
 * Ноты мелодических слоёв из паспорта (если разбор их посчитал).
 * @param {object} passport
 * @returns {number[]}
 */
function melodicNotes(passport) {
  const stems = passport?.stem_descriptors ?? {};
  const notes = [];
  for (const [layer, descriptor] of Object.entries(stems)) {
    if (!['lead', 'melody', 'synth_lead', 'keys', 'pads', 'pad'].includes(layer)) continue;
    const list = descriptor?.notes ?? descriptor?.midi ?? null;
    if (!Array.isArray(list)) continue;
    for (const note of list) {
      const value = Number(note?.midi ?? note?.pitch ?? note);
      if (Number.isFinite(value)) notes.push(value);
    }
  }
  return notes.sort((a, b) => a - b);
}

/**
 * Тембровые дескрипторы по ролям: центроид, спад, плоскость.
 * @param {object} passport
 * @returns {object}
 */
function timbreByRole(passport) {
  const stems = passport?.stem_descriptors ?? {};
  const byRole = {};
  for (const [layer, descriptor] of Object.entries(stems)) {
    const spectral = descriptor?.spectral ?? null;
    if (!spectral) continue;
    byRole[layer] = {
      centroidHz: num(spectral.centroid_hz ?? spectral.centroidHz),
      rolloffHz: num(spectral.rolloff_hz ?? spectral.rolloffHz),
      flatness: num(spectral.flatness),
    };
  }
  return byRole;
}
