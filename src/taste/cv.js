// Проверка выученной цели: leave-prompt-out CV и допуск в Score.
//
// Допуск (бриф §7.4) — не формальность. Пока модель не прошла проверку,
// её веса НЕЛЬЗЯ подставлять в скор: оптимизация непроверенной метрики
// — это Goodhart (бриф §2.8), а символьный скор сам по себе — гипотеза.
//
// Почему leave-prompt-out, а не random split: пары одного промта не
// независимы (бриф §7.2: «пары одного промта не независимы — считай
// кластерами»). Обычная случайная разбивка дала бы модели подсказку:
// она видела бы другие пары того же трека и «выучила» конкретный
// промт, а не обобщение. Leave-prompt-out отвечает на вопрос, который
// реально волнует: «на НОВОМ промте модель полезна?».
//
// Базовые линии обязательны: модель, обученная на символьном скоре,
// должна побеждать (а) «всегда-громче» и (б) текущий символьный скор.
// Иначе она просто переименовала то, что и так было.

import { trainTaste } from './model.js';

/**
 * Интервал Уилсона для доли (95% по умолчанию).
 * Нужен потому, что обычный нормальный интервал на малых n даёт
 * неправдоподобные границы и иногда выходит за [0, 1].
 *
 * @param {number} successes
 * @param {number} n
 * @param {number} [z]
 * @returns {{lower:number, upper:number, center:number}}
 */
export function wilsonInterval(successes, n, z = 1.96) {
  if (!n) return { lower: 0, upper: 1, center: 0 };
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    center: p,
  };
}

/**
 * Leave-prompt-out кросс-валидация.
 *
 * @param {Array<object>} rows {prompt, ids, xA, xB, y, weight, source,
 *   scoreA, scoreB, lufsA, lufsB}
 * @param {object} [options] параметры обучения (epochs, lr, lambda)
 * @returns {object} отчёт CV
 */
export function leavePromptOutCV(rows, options = {}) {
  const usable = (rows || []).filter((row) => row && typeof row.prompt === 'string' && row.prompt.length);
  const prompts = [...new Set(usable.map((row) => row.prompt))].sort();

  const folds = [];
  const predictions = [];

  for (const prompt of prompts) {
    const train = usable.filter((row) => row.prompt !== prompt);
    const test = usable.filter((row) => row.prompt === prompt);
    if (!train.length || !test.length) {
      folds.push({ prompt, n: test.length, accuracy: null, skipped: true });
      continue;
    }
    const model = trainModel(train, options);
    if (!model) {
      folds.push({ prompt, n: test.length, accuracy: null, skipped: true });
      continue;
    }
    let correct = 0;
    for (const row of test) {
      const predicted = predictSide(model, row);
      const ok = predicted === row.y;
      if (ok) correct += 1;
      predictions.push({
        prompt,
        y: row.y,
        predicted,
        ok,
        source: row.source ?? 'explicit',
      });
    }
    folds.push({
      prompt,
      n: test.length,
      accuracy: round(correct / test.length, 4),
      skipped: false,
    });
  }

  const decided = predictions.filter((entry) => entry.source === 'explicit');
  const successes = decided.filter((entry) => entry.ok).length;
  const ci = wilsonInterval(successes, decided.length);

  return {
    n: decided.length,
    nAll: usable.length,
    prompts: prompts.length,
    accuracy: decided.length ? round(successes / decided.length, 4) : null,
    ci: {
      lower: round(ci.lower, 4),
      upper: round(ci.upper, 4),
    },
    folds,
    baselines: baselines(usable, predictions),
  };
}

/**
 * Базовые линии на тех же парах.
 *
 * @param {Array<object>} rows
 * @param {Array<object>} predictions
 * @returns {object}
 */
function baselines(rows, predictions) {
  const explicit = rows.filter((row) => (row.source ?? 'explicit') === 'explicit');

  const symbolic = scoreBy(explicit, (row) => {
    if (!Number.isFinite(row.scoreA) || !Number.isFinite(row.scoreB)) return null;
    return row.scoreA >= row.scoreB ? 1 : 0;
  });

  const louder = scoreBy(explicit, (row) => {
    if (!Number.isFinite(row.lufsA) || !Number.isFinite(row.lufsB)) return null;
    return row.lufsA >= row.lufsB ? 1 : 0;
  });

  const chance = { n: explicit.length, accuracy: 0.5, ci: wilsonInterval(Math.round(explicit.length / 2), explicit.length) };

  return {
    symbolic: symbolic ? { ...symbolic, label: 'текущий символьный скор' } : null,
    louder: louder ? { ...louder, label: 'всегда-громче' } : null,
    chance: {
      ...chance,
      label: 'случайность',
      accuracy: round(chance.accuracy, 4),
      ci: { lower: round(chance.ci.lower, 4), upper: round(chance.ci.upper, 4) },
    },
  };
}

/**
 * Доля верных предсказаний по заданному правилу.
 * @param {Array<object>} rows
 * @param {(row:object)=>number|null} rule
 * @returns {{n:number, accuracy:number, ci:object}|null}
 */
function scoreBy(rows, rule) {
  let n = 0;
  let correct = 0;
  for (const row of rows) {
    const predicted = rule(row);
    if (predicted === null) continue;
    n += 1;
    if (predicted === row.y) correct += 1;
  }
  if (!n) return null;
  const ci = wilsonInterval(correct, n);
  return {
    n,
    accuracy: round(correct / n, 4),
    ci: { lower: round(ci.lower, 4), upper: round(ci.upper, 4) },
  };
}

/**
 * Решение о допуске модели в Score (бриф §7.4).
 *
 * Условия:
 *   1. человеческих пар ≥ 60 (иначе модель не используется вовсе);
 *   2. CV-accuracy ≥ 60%;
 *   3. CV-accuracy выше базовых линий, и нижняя граница 95% CI модели
 *      больше точечной оценки лучшей базовой линии;
 *   4. модель не вырождена (веса не нулевые).
 *
 * @param {object} input {cv, model, explicitPairs}
 * @returns {{admitted:boolean, reasons:Array<string>, checks:object}}
 */export function admitDecision(input = {}) {
  const cv = input.cv ?? null;
  const model = input.model ?? null;
  const explicitPairs = Number(input.explicitPairs) || 0;
  const reasons = [];
  const checks = {};

  checks.pairsEnough = explicitPairs >= 60;
  if (!checks.pairsEnough) {
    reasons.push(`человеческих пар ${explicitPairs} < 60 — модель не используется`);
  }

  checks.accuracyEnough = Boolean(cv && Number.isFinite(cv.accuracy) && cv.accuracy >= 0.6);
  if (!checks.accuracyEnough) {
    reasons.push(`CV-accuracy ${cv?.accuracy ?? '—'} < 0.6`);
  }

  const baselineList = [cv?.baselines?.symbolic, cv?.baselines?.louder].filter(Boolean);
  const bestBaseline = baselineList.reduce(
    (best, item) => (best === null || item.accuracy > best.accuracy ? item : best),
    null,
  );
  checks.beatsBaselines = Boolean(
    bestBaseline
    && cv
    && Number.isFinite(cv.accuracy)
    && cv.ci.lower > bestBaseline.accuracy,
  );
  if (!checks.beatsBaselines) {
    reasons.push(
      bestBaseline
        ? `нижняя граница CI ${cv?.ci?.lower ?? '—'} не выше лучшей базовой линии ${bestBaseline.accuracy}`
        : 'нет базовых линий для сравнения',
    );
  }

  const weightsMagnitude = Array.isArray(model?.weights)
    ? model.weights.reduce((sum, weight) => sum + Math.abs(weight), 0)
    : 0;
  checks.modelAlive = weightsMagnitude > 1e-6;
  if (!checks.modelAlive) {
    reasons.push(model
      ? 'веса модели вырождены — признаки не различают пары'
      : 'модель не обучена');
  }

  return {
    admitted: Object.values(checks).every(Boolean),
    reasons,
    checks,
    explicitPairs,
    bestBaseline: bestBaseline
      ? { label: bestBaseline.label, accuracy: bestBaseline.accuracy, n: bestBaseline.n }
      : null,
  };
}

/**
 * Предсказание стороны: 1 = лучше A, 0 = лучше B.
 * @param {object} model
 * @param {object} row
 * @returns {number}
 */
function predictSide(model, row) {
  const zA = standardize(row.xA, model);
  const zB = standardize(row.xB, model);
  let dot = 0;
  for (let i = 0; i < model.weights.length; i += 1) dot += model.weights[i] * (zA[i] - zB[i]);
  return dot >= 0 ? 1 : 0;
}

/** Стандартизация значения по сохранённым mean/std. */
function standardize(values, model) {
  const mean = model.mean ?? [];
  const std = model.std ?? [];
  return values.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    const m = mean[index] ?? 0;
    const s = std[index] || 1;
    return (value - m) / s;
  });
}

/**
 * Обучение внутри folds. Вынесено, чтобы параметры обучения (эпохи,
 * скорость, L2) задавались в одном месте.
 */
function trainModel(rows, options) {
  return trainTaste(rows, options);
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
