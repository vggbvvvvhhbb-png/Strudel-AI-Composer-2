// Bradley–Terry: выученная цель (бриф §7.4).
//
// Модель сравнения пар: P(A лучше B) = σ(w · (x_A − x_B)), где x —
// стандартизованный вектор признаков.
//
// Почему именно так:
//   • логистическая регрессия на разности — классическая Bradley–Terry;
//   • разность означает, что модель УЧИТ, КАКОЕ ОТЛИЧИЕ важно, а не какой
//     абсолютный уровень: «громче» и «дольше» сами по себе не качество;
//   • обучается на JS, без новой инфраструктуры: логистика на весах — это
//     несколько строк, и её можно проверить тестом.
//
// Детерминизм: инициализация нулями, полный батч, фиксированное число
// эпох, никакой случайности. Один и тот же набор пар → один и тот же
// вектор весов, побайтно.
//
// Взвешивание данных: человеческая пара — вес 1, прокси-пара от
// best-of-N — вес ≤0.2 (бриф §7.4). Прокси размечены ТЕМ ЖЕ символьным
// скором, на котором модель обучается, поэтому они не должны перевешивать
// живые суждения.

import { standardizeValues, standardizer } from './features.js';

/** Сигмоида с защитой от переполнения. */
export function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const exp = Math.exp(z);
  return exp / (1 + exp);
}

/**
 * Обучает модель на парах.
 *
 * @param {Array<object>} pairs
 *   {prompt, ids, xA, xB, y} — y = 1, если победила сторона A;
 *   дополнительно: {weight, source}
 * @param {object} [options]
 * @param {number} [options.epochs] число эпох (по умолчанию 400)
 * @param {number} [options.lr] скорость обучения (по умолчанию 0.1)
 * @param {number} [options.lambda] сила L2 (по умолчанию 0.01)
 * @param {object} [options.stats] готовые mean/std (иначе считаются по данным)
 * @returns {object|null} модель; null, если учить не на чем
 */
export function trainTaste(pairs, options = {}) {
  const epochs = Math.max(1, Math.min(5000, Number(options.epochs) || 400));
  const lr = Number.isFinite(options.lr) ? options.lr : 0.1;
  const lambda = Number.isFinite(options.lambda) ? options.lambda : 0.01;

  const usable = (pairs || []).filter((pair) => (
    pair
    && Array.isArray(pair.xA)
    && Array.isArray(pair.xB)
    && pair.xA.length
    && pair.xA.length === pair.xB.length
    && (pair.y === 0 || pair.y === 1)
    && (pair.weight === undefined || Number.isFinite(pair.weight))
  ));
  if (!usable.length) return null;

  const ids = usable[0].ids ?? [];
  const width = usable[0].xA.length;

  // Стандартизация: по обучающей выборке, если не передана готовая.
  const stats = options.stats ?? standardizer(usable.flatMap((pair) => [pair.xA, pair.xB]));

  const rows = usable.map((pair) => {
    const zA = standardizeValues(pair.xA, stats);
    const zB = standardizeValues(pair.xB, stats);
    const diff = zA.map((value, index) => value - zB[index]);
    return {
      diff,
      y: pair.y,
      weight: pair.weight === undefined ? 1 : pair.weight,
      source: pair.source ?? 'explicit',
      prompt: pair.prompt ?? null,
    };
  });

  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0) || 1;
  const weights = new Array(width).fill(0);

  let loss = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = new Array(width).fill(0);
    let epochLoss = 0;
    for (const row of rows) {
      let dot = 0;
      for (let i = 0; i < width; i += 1) dot += weights[i] * row.diff[i];
      const p = sigmoid(dot);
      const error = p - row.y;
      for (let i = 0; i < width; i += 1) gradient[i] += row.weight * error * row.diff[i];
      const safe = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
      epochLoss += row.weight * -(row.y * Math.log(safe) + (1 - row.y) * Math.log(1 - safe));
    }
    for (let i = 0; i < width; i += 1) {
      const g = gradient[i] / totalWeight + 2 * lambda * weights[i];
      weights[i] -= lr * g;
    }
    loss = epochLoss / totalWeight + lambda * weights.reduce((sum, w) => sum + w * w, 0);
  }

  const trainAccuracy = accuracyOf(rows, weights);

  return {
    v: 1,
    ids: [...ids],
    mean: stats.mean,
    std: stats.std,
    weights: weights.map((value) => round(value, 6)),
    epochs,
    lr,
    lambda,
    loss: round(loss, 6),
    trainAccuracy: round(trainAccuracy, 4),
    n: rows.length,
    nHuman: rows.filter((row) => row.source === 'explicit').length,
    nProxy: rows.filter((row) => row.source === 'proxy').length,
  };
}

/**
 * Вероятность, что сторона A лучше стороны B.
 *
 * @param {object} model
 * @param {Array<number|null>} xA
 * @param {Array<number|null>} xB
 * @returns {number} 0…1
 */
export function tasteProbability(model, xA, xB) {
  if (!model || !Array.isArray(model.weights)) return 0.5;
  const zA = standardizeValues(xA, model);
  const zB = standardizeValues(xB, model);
  let dot = 0;
  for (let i = 0; i < model.weights.length; i += 1) dot += model.weights[i] * (zA[i] - zB[i]);
  return sigmoid(dot);
}

/**
 * Абсолютная «ценность» трека по модели: чем выше, тем лучше этот трек
 * по выученным признакам. Нужна, чтобы ранжировать одиночные треки
 * (например, финалисты поиска), а не только пары.
 *
 * @param {object} model
 * @param {Array<number|null>} x
 * @returns {number}
 */
export function tasteScore(model, x) {
  if (!model || !Array.isArray(model.weights)) return 0;
  const z = standardizeValues(x, model);
  let dot = 0;
  for (let i = 0; i < model.weights.length; i += 1) dot += model.weights[i] * z[i];
  return round(dot, 6);
}

/**
 * Топ признаков по модулю веса — для человеческого чтения модели
 * (бриф §7.4: «веса читаются человеком»).
 *
 * @param {object} model
 * @param {number} [limit]
 * @returns {Array<{id:string, weight:number}>}
 */
export function topFeatures(model, limit = 12) {
  if (!model || !Array.isArray(model.weights)) return [];
  return model.weights
    .map((weight, index) => ({ id: model.ids[index] ?? `#${index}`, weight: round(weight, 6) }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * Проверяет, что модель вообще что-то значит: все веса нулевые — модель
 * вырождена (например, данных не хватило, чтобы что-то различить).
 * @param {object} model
 * @returns {{ok:boolean, reason:string|null}}
 */
export function modelSanity(model) {
  if (!model) return { ok: false, reason: 'модель не обучена' };
  if (!model.n) return { ok: false, reason: 'нет ни одной пары' };
  const magnitude = model.weights.reduce((sum, weight) => sum + Math.abs(weight), 0);
  if (magnitude < 1e-6) return { ok: false, reason: 'все веса нулевые — признаки не различают пары' };
  return { ok: true, reason: null };
}

/** Сериализация в JSON-безопасный объект. */
export function serializeModel(model) {
  return JSON.parse(JSON.stringify(model));
}

/** Разбор сохранённой модели с проверкой формы. */
export function parseModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.weights) || !Array.isArray(raw.ids)) return null;
  if (raw.weights.length !== raw.ids.length) return null;
  if (!Array.isArray(raw.mean) || !Array.isArray(raw.std)) return null;
  if (raw.mean.length !== raw.weights.length || raw.std.length !== raw.weights.length) return null;
  return raw;
}

// --- внутреннее ---

function accuracyOf(rows, weights) {
  if (!rows.length) return 0;
  let correct = 0;
  for (const row of rows) {
    let dot = 0;
    for (let i = 0; i < weights.length; i += 1) dot += weights[i] * row.diff[i];
    const predicted = dot >= 0 ? 1 : 0;
    if (predicted === row.y) correct += 1;
  }
  return correct / rows.length;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
