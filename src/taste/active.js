// Активный отбор пар (бриф §7.4, последний пункт).
//
// Пара, на которой модель и так уверена, не учит её ничему: ответ
// предсказан заранее. Полезная пара — та, где модель максимально
// неуверенна (p ≈ 0.5) и где ответ может что-то изменить.
//
// Правила:
//   1. Неуверенность: uncertainty = 1 − |2p − 1| (максимум при p = 0.5).
//   2. Страты: не больше `perPromptLimit` пар от одного промта в одной
//      выдаче — иначе батл уйдёт в один жанр.
//   3. Разнообразие: при равной неуверенности предпочитаем промт, который
//      в выдаче ещё не встречался (тот же приём, что в active learning).
//   4. Повторы для надёжности рецензента (§7.1) идут отдельной очередью
//      и в активный отбор не попадают: они меряют человека, а не модель.

import { tasteProbability } from './model.js';

/**
 * Ранжирует пары по неуверенности модели.
 *
 * @param {Array<object>} pairs {pairId, prompt, ids, xA, xB}
 * @param {object} model
 * @returns {Array<{pair:object, probability:number, uncertainty:number}>}
 */
export function rankByUncertainty(pairs, model) {
  const out = [];
  for (const pair of pairs || []) {
    if (!pair || !Array.isArray(pair.xA) || !Array.isArray(pair.xB)) continue;
    const probability = tasteProbability(model, pair.xA, pair.xB);
    out.push({
      pair,
      probability: round(probability, 4),
      uncertainty: round(1 - Math.abs(2 * probability - 1), 4),
    });
  }
  // Сначала максимальная неуверенность; при равенстве — стабильный
  // порядок по id, чтобы выдача была воспроизводимой.
  return out.sort((a, b) => (
    b.uncertainty - a.uncertainty
    || String(a.pair.pairId ?? '').localeCompare(String(b.pair.pairId ?? ''))
  ));
}

/**
 * Выбирает следующие пары для суждения.
 *
 * @param {Array<object>} pairs кандидаты
 * @param {object} model
 * @param {object} [options]
 * @param {number} [options.count] сколько пар взять
 * @param {number} [options.perPromptLimit] максимум пар от одного промта
 * @param {number} [options.perPromptTotal] максимум пар от одного промта
 *   за всю историю (стратификация по промтам)
 * @param {Array<object>} [options.history] уже показанные пары
 * @returns {Array<object>} выбранные пары (исходные объекты)
 */
export function selectNextPairs(pairs, model, options = {}) {
  const count = Math.max(1, Math.min(60, Number(options.count) || 10));
  const perPromptLimit = Math.max(1, Number(options.perPromptLimit) || 2);
  const perPromptTotal = Math.max(1, Number(options.perPromptTotal) || 6);

  const history = options.history || [];
  const shownByPrompt = new Map();
  for (const item of history) {
    const prompt = item?.prompt ?? item?.pair?.prompt;
    if (typeof prompt !== 'string') continue;
    shownByPrompt.set(prompt, (shownByPrompt.get(prompt) ?? 0) + 1);
  }

  const ranked = rankByUncertainty(pairs, model);
  const inBatch = new Map();
  const selected = [];

  for (const entry of ranked) {
    if (selected.length >= count) break;
    const prompt = entry.pair.prompt ?? '';
    const batchCount = inBatch.get(prompt) ?? 0;
    const totalCount = shownByPrompt.get(prompt) ?? 0;
    if (batchCount >= perPromptLimit) continue;
    if (totalCount >= perPromptTotal) continue;
    inBatch.set(prompt, batchCount + 1);
    selected.push(entry.pair);
  }

  // Если страты съели всё (например, один промт исчерпал лимит) — добираем
  // лучшими из оставшихся, чтобы очередь не пустела.
  if (selected.length < count) {
    const chosen = new Set(selected.map((pair) => pair.pairId ?? pair));
    for (const entry of ranked) {
      if (selected.length >= count) break;
      const key = entry.pair.pairId ?? entry.pair;
      if (chosen.has(key)) continue;
      chosen.add(key);
      selected.push(entry.pair);
    }
  }

  return selected;
}

/**
 * Строит пары «повтор» для измерения надёжности рецензента: те же треки,
 * стороны переставлены. Такие пары НЕ входят в активный отбор.
 *
 * @param {Array<object>} pairs исходные пары
 * @param {number} [every] каждая N-я пара — повтор (по умолчанию 10)
 * @returns {Array<object>}
 */
export function buildRepeatPairs(pairs, every = 10) {
  const step = Math.max(2, Number(every) || 10);
  const out = [];
  for (let index = 0; index < (pairs || []).length; index += 1) {
    if (index % step !== step - 1) continue;
    const source = pairs[index - (step - 1)];
    if (!source) continue;
    out.push({
      ...source,
      pairId: `${source.pairId}-repeat`,
      repeat: true,
      swapped: !source.swapped,
      a: source.b,
      b: source.a,
    });
  }
  return out;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
