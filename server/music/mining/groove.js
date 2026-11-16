// Грув-профиль паттерна и его согласование с измеренным стилем (D-112).
//
// ЗАЧЕМ. Библиотека стилей хранит числа (гистограмму атак, вес бэкбита).
// Чтобы композитор их ПОТРЕБЛЯЛ, а не просто держал в файле, нужен мост:
//      паттерн-кандидат → профиль → сравнение с измеренным → выбор.
//
// Мост детерминирован: один и тот же кандидат и одна и та же измеренная
// гистограмма дают один и тот же выбор. Обратная совместимость не ломается:
// когда измеренной гистограммы нет, выбор идёт по старому правилу.
//
// ЧЕСТНОСТЬ. Если измеренных данных нет — профиля нет, и мост молчит.

import { parseMini } from '../mini.js';

/** Слотов в гистограмме атак: шестнадцать (шестнадцатые доли такта). */
export const SLOTS = 16;

/**
 * Профиль ритмического паттерна: где стоят атаки.
 *
 * @param {string} pattern mini-нотация
 * @returns {{histogram16:number[], density:number, backbeatWeight:number}|null}
 */
export function profileFromPattern(pattern) {
  const parsed = parseMini(pattern, { cycles: 1 });
  if (!parsed?.events?.length) return null;
  const counts = new Array(SLOTS).fill(0);
  let total = 0;
  let onBackbeat = 0;
  for (const event of parsed.events) {
    const begin = Number(event?.begin);
    if (!Number.isFinite(begin) || begin < 0 || begin >= 1) continue;
    counts[Math.min(SLOTS - 1, Math.floor(begin * SLOTS))] += 1;
    total += 1;
    const beat = Math.floor(begin * 4);
    const inBar = ((beat % 4) + 4) % 4;
    if (inBar === 1 || inBar === 3) onBackbeat += 1;
  }
  if (!total) return null;
  const histogram16 = counts.map((value) => Number((value / total).toFixed(6)));
  return {
    histogram16,
    density: total,
    backbeatWeight: Number((onBackbeat / total).toFixed(6)),
  };
}

/**
 * Расстояние между двумя гистограммами (полная вариация, 0..1).
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number|null}
 */
export function histogramDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(Number(a[i] ?? 0) - Number(b[i] ?? 0));
  return Number((sum / 2).toFixed(6));
}

/**
 * Выбирает паттерн, ближайший к измеренному груву.
 *
 * @param {string[]} candidates мини-нотации
 * @param {object|null} mined измеренная статистика стиля
 * @returns {{pattern:string, index:number, distance:number}|null}
 */
export function matchMinedPattern(candidates, mined) {
  const list = Array.isArray(candidates) ? candidates.filter((item) => typeof item === 'string') : [];
  const target = mined?.groove?.onsetHistogram16;
  if (!list.length || !Array.isArray(target) || target.length !== SLOTS) return null;

  const targetBackbeat = Number(mined?.groove?.backbeatWeight);
  let best = null;
  for (let index = 0; index < list.length; index += 1) {
    const profile = profileFromPattern(list[index]);
    if (!profile) continue;
    const distance = histogramDistance(profile.histogram16, target);
    if (distance === null) continue;
    // Вес бэкбита — вторая подсказка: расхождение в нём штрафуется слабее,
    // но решает ничьи (например, 'bd*4' против 'bd*2 bd*2').
    const backbeatPenalty = Number.isFinite(targetBackbeat)
      ? Math.abs(profile.backbeatWeight - targetBackbeat) * 0.25
      : 0;
    const score = Number((distance + backbeatPenalty).toFixed(6));
    if (!best || score < best.score) best = { pattern: list[index], index, distance: score, score };
  }
  if (!best) return null;
  return { pattern: best.pattern, index: best.index, distance: best.distance };
}
