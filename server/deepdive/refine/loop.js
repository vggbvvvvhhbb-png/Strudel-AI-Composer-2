// Цикл итераций: подготовка опций, рендер и крутилка «предложить →
// применить → отрендерить → сравнить».
//
// Модуль не знает про публичный API пакета: он получает всё нужное
// аргументами и возвращает сырой результат цикла.

import { compileTrackSpec } from '../../music/compiler/index.js';
import { compareTwin } from '../compare.js';
import { decodeWav } from '../../../src/core/wav.js';

import { clone, round4 } from './helpers.js';
import { LAYER_ROLES } from './helpers.js';
import { applyOperations, LAYER_SCORE_FIELD } from './ops.js';
import { buildModelPayload, parseModelOperations, REFINE_SYSTEM_PROMPT } from './prompt.js';
import { BASE_CAVEATS as SHARED_CAVEATS } from '../caveats.js';

/** Значения по умолчанию. Пороги узкие: план не должен уезжать от измерений. */
export const DEFAULT_OPTIONS = {
  iterations: 3,
  plateauThreshold: 0.01,
  bpmTolerancePct: 3,
  gainMin: 0,
  gainMax: 2,
  lateToleranceMs: 15,
  maxOperations: 8,
  temperature: 0.2,
};

/**
 * Рендерер на базе браузерного воркера (server/deepdive/render/render-worker.mjs).
 * Микс рендерится целиком, слои — по одной партии за раз: движок не умеет
 * сольный рендер, поэтому слой собирается из отдельных рендеров партий.
 */
export function createWorkerRenderer(worker, { fromCycle = 0, toCycle = 16, sampleRate = 48000, cps } = {}) {
  const renderCode = async (code) => {
    const result = await worker.render({ code, fromCycle, toCycle, sampleRate, cps });
    if (!result?.ok) throw new Error('рендер не удался');
    const audio = decodeWav(result.wav);
    return { channels: audio.channels, sampleRate: audio.sampleRate };
  };
  return async function renderCandidate({ code, spec }) {
    const mix = await renderCode(code);
    const layers = { mix };
    for (const [layer, roles] of Object.entries(LAYER_ROLES)) {
      const present = roles.filter((role) => spec?.parts?.roles?.[role]);
      if (!present.length) continue;
      const layerSpec = {
        ...spec,
        parts: { roles: Object.fromEntries(present.map((role) => [role, spec.parts.roles[role]])) },
      };
      layers[layer] = await renderCode(compileTrackSpec(layerSpec));
    }
    return layers;
  };
}

export function normalizeOptions(input) {
  const raw = input?.options ?? {};
  const pick = (key, fallback) => {
    for (const source of [raw, input]) {
      if (source && source[key] !== undefined && source[key] !== null) return source[key];
    }
    return fallback;
  };
  const iterations = Number(pick('iterations', DEFAULT_OPTIONS.iterations));
  const plateau = Number(pick('plateauThreshold', DEFAULT_OPTIONS.plateauThreshold));
  const tolerance = Number(pick('bpmTolerancePct', DEFAULT_OPTIONS.bpmTolerancePct));
  const gainMin = Number(pick('gainMin', DEFAULT_OPTIONS.gainMin));
  const gainMax = Number(pick('gainMax', DEFAULT_OPTIONS.gainMax));
  const lateTolerance = Number(pick('lateToleranceMs', DEFAULT_OPTIONS.lateToleranceMs));
  const maxOperations = Number(pick('maxOperations', DEFAULT_OPTIONS.maxOperations));
  const options = {
    iterations: Number.isFinite(iterations) && iterations > 0 ? Math.min(16, Math.floor(iterations)) : DEFAULT_OPTIONS.iterations,
    plateauThreshold: Number.isFinite(plateau) && plateau >= 0 ? plateau : DEFAULT_OPTIONS.plateauThreshold,
    bpmTolerancePct: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_OPTIONS.bpmTolerancePct,
    gainMin: Number.isFinite(gainMin) ? gainMin : DEFAULT_OPTIONS.gainMin,
    gainMax: Number.isFinite(gainMax) ? gainMax : DEFAULT_OPTIONS.gainMax,
    lateToleranceMs: Number.isFinite(lateTolerance) && lateTolerance >= 0 ? lateTolerance : DEFAULT_OPTIONS.lateToleranceMs,
    maxOperations: Number.isFinite(maxOperations) && maxOperations > 0 ? Math.floor(maxOperations) : DEFAULT_OPTIONS.maxOperations,
    temperature: Number(pick('temperature', DEFAULT_OPTIONS.temperature)),
    respond: pick('respond', pick('llm', null)),
    render: pick('render', null),
    worker: pick('worker', null),
    onIteration: pick('onIteration', null),
    reference: pick('reference', null),
    referenceBassNotes: pick('referenceBassNotes', null),
    referenceSwing: pick('referenceSwing', null),
    candidateBassNotes: pick('candidateBassNotes', null),
    candidateSwing: pick('candidateSwing', null),
    compare: pick('compare', null),
  };
  return options;
}

export function normalizeMetrics(metrics) {
  const overall = Number(metrics?.overall);
  return {
    overall: Number.isFinite(overall) ? overall : 0,
    layers: metrics?.layers && typeof metrics.layers === 'object' ? clone(metrics.layers) : {},
  };
}

/** Стандартный компаратор: существующий compareTwin. */
export function defaultCompare(reference, options) {
  return (candidate, { iteration, label, plan }) => compareTwin({
    reference,
    candidate,
    referenceBassNotes: options.referenceBassNotes ?? null,
    candidateBassNotes: options.candidateBassNotes
      ? options.candidateBassNotes(plan)
      : (candidate?.bassNotes ?? null),
    referenceSwing: options.referenceSwing ?? null,
    candidateSwing: options.candidateSwing
      ? options.candidateSwing(plan)
      : (candidate?.swing ?? null),
    iterationLabel: label,
    iteration,
  });
}

/** Стандартный ответ модели: LLM проекта. Сеть вызывается только здесь. */
export async function defaultRespond({ messages, temperature }) {
  const { completeChat } = await import('../../llm/client.js');
  return completeChat({
    messages,
    temperature,
    responseFormat: { type: 'json_object' },
  });
}

export const BASE_CAVEATS = SHARED_CAVEATS;

export function failedEntry(iteration, reason, rejected = []) {
  return {
    iteration,
    label: `iteration-${iteration}`,
    status: 'failed',
    changes: [],
    metrics: null,
    delta: null,
    rejected: rejected.map((item) => ({ op: item.op, reason: item.reason })),
    error: reason,
    honesty: {
      claims: [],
      caveats: [reason, 'итерация ничего не изменила: план остался прежним', ...BASE_CAVEATS],
    },
  };
}

/**
 * Сам цикл: baseline (iteration 0) — единственная точка отсчёта, дальше
 * каждая итерация предлагает правки плана, применяет их, рендерит и
 * сравнивает результат с оригиналом.
 *
 * @returns {Promise<{iterations:Array, best:object, log:string[], stopReason:string}>}
 */
export async function runRefineIterations({
  input,
  options,
  basePlan,
  baseline,
  measurements,
  stems,
  ctx,
  respond,
  render,
  compare,
}) {
  const iterations = [];
  const log = [];

  let currentPlan = clone(basePlan);
  let currentCode = typeof input.code === 'string' && input.code.trim()
    ? input.code
    : compileTrackSpec(currentPlan);
  let currentMetrics = baseline;
  let best = {
    iteration: 0,
    label: 'baseline',
    overall: baseline.overall,
    plan: clone(basePlan),
    code: currentCode,
    metrics: baseline,
  };

  iterations.push({
    iteration: 0,
    label: 'baseline',
    status: 'ok',
    changes: [],
    metrics: baseline,
    delta: { overall: 0 },
    rejected: [],
    honesty: {
      claims: [`базовая общая оценка ${baseline.overall} — из compareTwin`],
      caveats: [...BASE_CAVEATS],
    },
  });
  log.push(`baseline: общая оценка ${baseline.overall}`);

  let stopReason = null;
  let stopReasonCode = null;
  let stopReasonDetail = null;

  // Прогресс цикла: маршрут отдаёт его пользователю через SSE.
  // Ошибка в обработчике не должна ломать цикл.
  const notify = (entry) => {
    iterations.push(entry);
    if (typeof options.onIteration === 'function') {
      try {
        options.onIteration(entry, { log: [...log] });
      } catch {
        // обработчик прогресса не влияет на результат
      }
    }
  };

  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const payload = buildModelPayload({
      iteration,
      baseline,
      current: currentMetrics,
      measurements,
      stems,
      plan: currentPlan,
      ctx,
    });
    const messages = [
      { role: 'system', content: REFINE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ];

    let raw;
    try {
      raw = await respond({ messages, payload, iteration, temperature: options.temperature });
    } catch (err) {
      const reason = `ошибка запроса к модели: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    let operations;
    try {
      operations = parseModelOperations(raw);
    } catch (err) {
      const reason = `невалидный ответ модели: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }
    if (operations.length > options.maxOperations) {
      const dropped = operations.length - options.maxOperations;
      operations = operations.slice(0, options.maxOperations);
      log.push(`итерация ${iteration}: лишних операций отброшено — ${dropped} (максимум ${options.maxOperations})`);
    }

    const { plan: nextPlan, applied, rejected } = applyOperations(currentPlan, operations, ctx);
    for (const item of rejected) {
      log.push(`итерация ${iteration}: отклонено ${JSON.stringify(item.op)} — ${item.reason}`);
    }
    if (!applied.length) {
      const reason = rejected.length
        ? 'ни одна операция не подтверждена измерениями'
        : 'модель не предложила операций';
      notify(failedEntry(iteration, reason, rejected));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    let nextCode;
    try {
      nextCode = compileTrackSpec(nextPlan);
    } catch (err) {
      const reason = `план не принят компилятором: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason, rejected));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    let candidate;
    try {
      candidate = await render({ code: nextCode, spec: nextPlan, iteration });
    } catch (err) {
      const reason = `рендер не удался: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason, rejected));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    let nextMetrics;
    try {
      const rawMetrics = await compare(candidate, {
        iteration,
        label: `iteration-${iteration}`,
        plan: nextPlan,
      });
      nextMetrics = normalizeMetrics(rawMetrics);
    } catch (err) {
      const reason = `сравнение не удалось: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason, rejected));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    const improvement = nextMetrics.overall - baseline.overall;
    const delta = { overall: round4(improvement) };
    const layerDelta = {};
    for (const [name, field] of Object.entries(LAYER_SCORE_FIELD)) {
      const before = Number(baseline.layers?.[name]?.[field]);
      const after = Number(nextMetrics.layers?.[name]?.[field]);
      if (Number.isFinite(before) && Number.isFinite(after)) {
        layerDelta[name] = round4(after - before);
      }
    }
    if (Object.keys(layerDelta).length) delta.layers = layerDelta;

    const caveats = [...BASE_CAVEATS];
    if (rejected.length) {
      caveats.push(`отклонено операций: ${rejected.length} — значения не подтверждены измерениями`);
    }
    notify({
      iteration,
      label: `iteration-${iteration}`,
      status: 'ok',
      changes: applied.map((item) => item.description),
      metrics: nextMetrics,
      delta,
      plan: clone(nextPlan),
      rejected: rejected.map((item) => ({ op: item.op, reason: item.reason })),
      honesty: {
        claims: applied.map((item) => item.description),
        caveats,
      },
    });
    for (const item of applied) log.push(`итерация ${iteration}: ${item.description}`);
    log.push(
      `итерация ${iteration}: общая оценка ${baseline.overall} → ${nextMetrics.overall} (дельта ${delta.overall})`,
    );

    const previousBest = best;
    // «Лучший» — последняя версия, которая не хуже лучшей: при равной оценке
    // предпочитаем более поздний план (он может отличаться деталями).
    if (nextMetrics.overall >= best.overall) {
      best = {
        iteration,
        label: `iteration-${iteration}`,
        overall: nextMetrics.overall,
        plan: clone(nextPlan),
        code: nextCode,
        metrics: nextMetrics,
      };
    }
    if (nextMetrics.overall < previousBest.overall) {
      // Ухудшение: возвращаемся к лучшему плану, чтобы цикл не деградировал.
      currentPlan = clone(previousBest.plan);
      currentCode = previousBest.code;
      currentMetrics = previousBest.metrics;
      log.push(`итерация ${iteration}: оценка хуже лучшей — план возвращён к итерации ${previousBest.iteration}`);
    } else {
      currentPlan = nextPlan;
      currentCode = nextCode;
      currentMetrics = nextMetrics;
    }

    if (improvement < options.plateauThreshold) {
      stopReason = 'плато';
      stopReasonCode = 'plateau';
      stopReasonDetail = improvement < 0
        ? `общая оценка упала на ${round4(Math.abs(improvement))} относительно baseline (порог улучшения ${options.plateauThreshold})`
        : `улучшение ${round4(improvement)} меньше порога ${options.plateauThreshold}`;
      log.push(`стоп: плато (plateau) — ${stopReasonDetail}`);
      break;
    }
  }

  if (!stopReason) {
    stopReason = 'бюджет итераций';
    stopReasonCode = 'budget';
    stopReasonDetail = `итераций: ${options.iterations}`;
    log.push(`стоп: бюджет итераций исчерпан (${options.iterations})`);
  }

  return {
    iterations,
    best,
    log,
    stopReason,
    stopReasonCode,
    stopReasonDetail,
    baseline: iterations[0],
  };
}
