// Рецепты переходов — ФУНКЦИИ, а не строки.
//
// Почему функции: переход — это изменение партии (какой ритм, какая
// автоматизация, какой фильтр). Строкой это выражается плохо: строку нельзя
// ни проверить, ни скомбинировать. Функция принимает дескриптор партии и
// длину секции в тактах и возвращает новый дескриптор.
//
// Все рецепты чистые: они не меняют исходный дескриптор.
//
// Проверка: tests/unit/knowledge.test.js прогоняет каждый рецепт через
// настоящий парсер Strudel — рецепт, который даёт неисполняемый код,
// в репозиторий не попадает.

import { clonePattern, withMethod, withMethods, signal, num } from './descriptor.js';

/**
 * Build: энергия растёт, фильтр открывается.
 * @param {object} pattern дескриптор партии
 * @param {number} barsLen длина секции в тактах
 */
export function build(pattern, barsLen) {
  const p = clonePattern(pattern);
  return withMethods(p, [
    ['gain', signal('sine', Math.max(1, barsLen), [0.35, 0.85])],
    ['lpf', signal('sine', Math.max(1, barsLen), [400, 3000])],
  ]);
}

/**
 * Drop: полная энергия, широкий фильтр, максимальная плотность.
 * @param {object} pattern
 * @param {number} barsLen
 */
export function drop(pattern, barsLen) {
  const p = clonePattern(pattern);
  return withMethods(p, [
    ['gain', num(0.95)],
    ['lpf', num(6000)],
  ]);
}

/**
 * Breakdown: энергия падает, партия приглушается и фильтруется.
 * @param {object} pattern
 * @param {number} barsLen
 */
export function breakdown(pattern, barsLen) {
  const p = clonePattern(pattern);
  return withMethods(p, [
    ['gain', signal('sine', Math.max(1, barsLen), [0.6, 0.2])],
    ['lpf', num(900)],
    ['room', num(0.6)],
  ]);
}

/**
 * Riser: резкий подъём громкости и фильтра перед drop.
 * @param {object} pattern
 * @param {number} barsLen
 */
export function riser(pattern, barsLen) {
  const p = clonePattern(pattern);
  return withMethods(p, [
    ['gain', signal('saw', Math.max(1, barsLen), [0.2, 0.95])],
    ['lpf', signal('saw', Math.max(1, barsLen), [300, 7000])],
  ]);
}

/**
 * Fill: уплотнение ритма в конце секции — удвоение последнего такта.
 * @param {object} pattern
 * @param {number} barsLen
 */
export function fill(pattern, barsLen) {
  const p = clonePattern(pattern);
  return withMethod(p, 'ply', num(2));
}

/** Рецепты по имени. */
export const TRANSITIONS = {
  build,
  drop,
  breakdown,
  riser,
  fill,
};

/** Типы переходов, поддерживаемые схемой. */
export const TRANSITION_TYPES = Object.keys(TRANSITIONS);

/**
 * Применяет переход к дескриптору.
 * @param {object} pattern
 * @param {string} type имя перехода
 * @param {number} barsLen
 */
export function applyTransition(pattern, type, barsLen) {
  const recipe = TRANSITIONS[type];
  if (!recipe) return clonePattern(pattern);
  return recipe(pattern, barsLen);
}
