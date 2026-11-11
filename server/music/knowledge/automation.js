// Рецепты автоматизации: кривые движения параметров.
//
// Автоматизация в Strudel — это СИГНАЛ в аргументе метода:
//   .gain(sine.slow(8).range(0.2, 0.9))
//   .lpf(perlin.range(300, 4000))
//
// Статичное .gain(0.5) — не автоматизация: параметр не меняется.
// Доля автоматизации считается по значениям событий (см. DECISIONS.md D-008),
// поэтому здесь важно, чтобы сигнал действительно менялся.
//
// Диапазоны по стилям: у EDM-стилей размах больше, у lofi/ambient — уже.

import { signal } from './descriptor.js';

/**
 * Диапазоны по стилям для каждой кривой.
 * sweep  — фильтр: нижняя и верхняя частота
 * swell  — громкость: от и до
 * fade   — громкость: затухание
 * motion — «дыхание» громкости вокруг значения
 */
export const CURVE_RANGES = {
  techno: { sweep: [300, 6000], swell: [0.3, 0.95], fade: [0.9, 0.05], motion: [0.55, 0.8] },
  house: { sweep: [400, 5000], swell: [0.35, 0.9], fade: [0.9, 0.05], motion: [0.6, 0.85] },
  dnb: { sweep: [250, 7000], swell: [0.3, 1.0], fade: [0.95, 0.05], motion: [0.5, 0.85] },
  trap: { sweep: [200, 5500], swell: [0.25, 0.95], fade: [0.9, 0.05], motion: [0.45, 0.8] },
  synthwave: { sweep: [350, 5500], swell: [0.3, 0.9], fade: [0.9, 0.05], motion: [0.5, 0.8] },
  lofi: { sweep: [400, 2800], swell: [0.35, 0.8], fade: [0.8, 0.05], motion: [0.6, 0.75] },
  ambient: { sweep: [300, 2400], swell: [0.25, 0.75], fade: [0.75, 0.02], motion: [0.5, 0.7] },
  jazz: { sweep: [300, 4500], swell: [0.35, 0.85], fade: [0.85, 0.05], motion: [0.55, 0.8] },
  rock: { sweep: [350, 5000], swell: [0.35, 0.95], fade: [0.9, 0.05], motion: [0.55, 0.85] },
  cinematic: { sweep: [250, 6000], swell: [0.2, 0.9], fade: [0.9, 0.02], motion: [0.4, 0.75] },
  generic: { sweep: [300, 4500], swell: [0.3, 0.85], fade: [0.85, 0.05], motion: [0.5, 0.78] },
};

/**
 * Рецепты кривых. Каждый возвращает описание сигнала, а не строку.
 *
 * sweep  — открытие/закрытие фильтра
 * swell  — нарастание громкости
 * fade   — затухание громкости
 * motion — «дыхание» громкости (perlin, неповторяемое движение)
 */
export const CURVES = {
  sweep: (style, barsLen) => {
    const [from, to] = rangeFor(style, 'sweep');
    return signal('sine', Math.max(1, barsLen), [from, to]);
  },
  swell: (style, barsLen) => {
    const [from, to] = rangeFor(style, 'swell');
    return signal('sine', Math.max(1, barsLen), [from, to]);
  },
  fade: (style, barsLen) => {
    const [from, to] = rangeFor(style, 'fade');
    // Диапазон всегда по возрастанию, направление задаётся отдельно:
    // затухание идёт от большего к меньшему.
    return signal('sine', Math.max(1, barsLen), [to, from], 'down');
  },
  motion: (style, barsLen) => {
    const [from, to] = rangeFor(style, 'motion');
    return signal('perlin', Math.max(1, barsLen), [from, to]);
  },
};

/** Имена кривых. */
export const CURVE_NAMES = Object.keys(CURVES);

/** Диапазон кривой по стилю (с запасным вариантом). */
export function rangeFor(style, curve) {
  const profile = CURVE_RANGES[style] || CURVE_RANGES.generic;
  return profile[curve] || CURVE_RANGES.generic[curve];
}

/**
 * Строит описание сигнала для кривой.
 * @param {string} name имя кривой
 * @param {string} style стиль
 * @param {number} barsLen длина участка в тактах
 */
export function buildCurve(name, style, barsLen) {
  const recipe = CURVES[name];
  if (!recipe) return null;
  return recipe(style, barsLen);
}
