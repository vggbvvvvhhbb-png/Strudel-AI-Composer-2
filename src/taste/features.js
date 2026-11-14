// Признаки для выученной цели (бриф §7.4).
//
// Taste Model обучается на РАЗНОСТИ векторов двух треков:
//
//     P(A лучше B) = σ(w · (x_A − x_B))
//
// Поэтому вектор должен быть (а) сопоставим между треками, (б) одного
// и того же состава для всех, (в) нормированным — иначе веса выучатся
// масштаб вместо смысла.
//
// Требование брифа: признаки = L0 (звук) + L1 (структура), ≈40–80 штук,
// стандартизованные. Здесь 43 признака: 37 символьных + 6 аудио.
//
// Честная оговорка: символьные признаки — гипотезы о том, что слышит
// человек (§6). Пока модель не сверена с человеческими парами (H3),
// обучение на них просто учит модель воспроизводить символьный скор.
// Поэтому модель допускается в Score только после leave-prompt-out CV
// (см. src/taste/cv.js), а данные с весом ≤0.2 (прокси от best-of-N)
// никогда не идут в «решающий» счёт.

import { extractMetrics } from '../metrics/extract.js';

/**
 * Признаки по умолчанию: L1 (структура) + L0 (звук).
 * Порядок фиксирован — он входит в сериализованную модель.
 */
export const TASTE_FEATURE_IDS = [
  // --- L1: форма ---
  'symbolic.form.sections',
  'symbolic.form.minContrast',
  'symbolic.form.contrastMean',
  'symbolic.form.contrastMax',
  // --- L1: энергия ---
  'symbolic.energy.correlation',
  'symbolic.energy.range',
  'symbolic.energy.profileMean',
  'symbolic.energy.profileStd',
  'symbolic.energy.profileSlope',
  // --- L1: тональность ---
  'symbolic.tonality.scaleFit',
  'symbolic.tonality.harmonicFit',
  // --- L1: мотив и фраза ---
  'symbolic.motif.count',
  'symbolic.motif.sectionCount',
  'symbolic.motif.variations',
  'symbolic.motif.hook',
  'symbolic.phrase.closureRatio',
  'symbolic.phrase.openRatio',
  'symbolic.phrase.count',
  // --- L1: грув ---
  'symbolic.groove.bassKickLock',
  'symbolic.groove.microtimingStdMs',
  'symbolic.groove.microtimingMeanMs',
  // --- L1: плотность и разнообразие ---
  'symbolic.density.eventsPerSecond',
  'symbolic.density.roleEntropy',
  'symbolic.variation.ratio',
  'symbolic.kinetics.distinctVelocities',
  // --- L1: регистры ---
  'symbolic.register.bassSpan',
  'symbolic.register.chordsSpan',
  'symbolic.register.padSpan',
  'symbolic.register.leadSpan',
  'symbolic.register.arpSpan',
  // --- L1: роли ---
  'symbolic.role.perBar.kick',
  'symbolic.role.perBar.snare',
  'symbolic.role.perBar.hats',
  'symbolic.role.perBar.bass',
  'symbolic.role.perBar.chords',
  'symbolic.role.perBar.lead',
  // --- L0: звук ---
  'audio.lufsI',
  'audio.lufsS',
  'audio.truePeakDbtp',
  'audio.peakDbfs',
  'audio.crestDb',
  'audio.clipCount',
];

/**
 * Собирает вектор признаков одного трека.
 *
 * @param {object} sources {symbolic: отчёт, audio: отчёт о рендере}
 * @param {Array<string>} [ids] состав признаков (по умолчанию TASTE_FEATURE_IDS)
 * @returns {{ids:Array<string>, values:Array<number|null>, missing:Array<string>}}
 */
export function featureVector(sources = {}, ids = TASTE_FEATURE_IDS) {
  const wanted = ids && ids.length ? ids : TASTE_FEATURE_IDS;
  const symbolic = extractMetrics(sources.symbolic, wanted);
  const audio = extractMetrics(sources.audio, wanted);
  const values = [];
  const missing = [];
  for (const id of wanted) {
    const value = symbolic.values[id] ?? audio.values[id];
    if (value === null || value === undefined) {
      missing.push(id);
      values.push(null);
    } else {
      values.push(value);
    }
  }
  return { ids: [...wanted], values, missing };
}

/**
 * Стандартизация: среднее и отклонение по каждому признаку.
 *
 * Отклонение = 0 (признак постоянный) даёт std = 1, иначе такой признак
 * после нормировки стал бы делением на ноль. Признак, который нигде не
 * измерен (все значения null), получает mean = 0, std = 1 — при
 * применении он даёт z = 0, то есть «нейтрально», а не «минус бесконечность».
 *
 * @param {Array<Array<number|null>>} vectors
 * @returns {{mean:Array<number>, std:Array<number>, counts:Array<number>}}
 */
export function standardizer(vectors) {
  const width = vectors.reduce((max, vector) => Math.max(max, vector.length), 0);
  const mean = new Array(width).fill(0);
  const std = new Array(width).fill(1);
  const counts = new Array(width).fill(0);

  for (let column = 0; column < width; column += 1) {
    const values = [];
    for (const vector of vectors) {
      const value = vector[column];
      if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
    }
    counts[column] = values.length;
    if (!values.length) continue;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    mean[column] = average;
    if (values.length < 2) {
      std[column] = 1;
      continue;
    }
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
    std[column] = variance > 1e-12 ? Math.sqrt(variance) : 1;
  }

  return { mean, std, counts };
}

/**
 * Применяет стандартизацию к одному вектору.
 * Пропуски заменяются средним (z = 0) — «нечем измерить» ≠ «ноль».
 *
 * @param {Array<number|null>} values
 * @param {{mean:Array<number>, std:Array<number>}} stats
 * @returns {Array<number>}
 */
export function standardizeValues(values, stats) {
  return values.map((value, index) => {
    const mean = stats?.mean?.[index] ?? 0;
    const std = stats?.std?.[index] || 1;
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return (value - mean) / std;
  });
}
