// Цикл самоулучшения «код-двойника» (этап D режима «Разбор»).
//
// Оркестрация: готовит вход, собирает контекст проверки и запускает
// крутилку итераций из loop.js. Само тело цикла, операции, промпт и
// очистка измерений лежат в соседних модулях папки refine/.
//
// ГЛАВНОЕ ПРАВИЛО. Модель НЕ пишет ни кода, ни свободного текста, ни чисел
// «из воздуха». Она возвращает ТОЛЬКО типизированные операции над планом из
// белого списка, и каждая операция проверяется по измерениям.

import {
  clone,
  measuredBassNotes,
  measuredStepsByRole,
  pickStemDescriptors,
  pickTempo,
} from './helpers.js';
import { applyOperations, LAYERS } from './ops.js';
import { buildModelPayload, parseModelOperations, REFINE_SYSTEM_PROMPT } from './prompt.js';
import { sanitize } from './sanitize.js';
import {
  createWorkerRenderer,
  defaultCompare,
  defaultRespond,
  normalizeMetrics,
  normalizeOptions,
  runRefineIterations,
} from './loop.js';

export const REFINE_METHOD = 'deep-dive/refine@0.1.0';

// Публичные части пакета: они живут в соседних модулях, но экспортируются
// отсюда — фасад server/deepdive/refine.js переэкспортирует их одним
// движением.
export { DEFAULT_OPTIONS, createWorkerRenderer } from './loop.js';
export { applyOperations, LAYERS } from './ops.js';
export { buildModelPayload, parseModelOperations, REFINE_SYSTEM_PROMPT } from './prompt.js';
export { sanitize } from './sanitize.js';

/**
 * Цикл самоулучшения двойника.
 *
 * @param {object} input
 * @param {object} input.plan план (TrackSpec) двойника
 * @param {string} [input.code] код текущего плана (пересобирается, если нет)
 * @param {object} input.metrics метрики baseline (результат compareTwin, iteration 0)
 * @param {object} [input.measurements] измерения оригинала
 * @param {object} [input.stem_descriptors] дескрипторы стемов (для проверки правок)
 * @param {object} [input.options] опции цикла (см. normalizeOptions)
 * @param {Function} [input.options.respond] функция ответа модели ({messages, payload, iteration}) => string|object
 * @param {Function} [input.options.render] функция рендера ({code, spec, iteration}) => {drums,bass,other,mix}
 * @param {object} [input.options.reference] оригинал для сравнения
 * @returns {Promise<{iterations:Array, best:object, log:string[], stopReason:string}>}
 */
export async function refineTwin(input = {}) {
  const options = normalizeOptions(input);
  const basePlan = clone(input.plan);
  if (!basePlan) throw new Error('Нужен план двойника (input.plan)');
  const baseline = normalizeMetrics(input.metrics);
  const measurements = input.measurements ?? {};
  const stems = pickStemDescriptors(input);

  if (options.respond !== null && typeof options.respond !== 'function') {
    throw new Error('options.respond должен быть функцией');
  }
  if (options.compare !== null && typeof options.compare !== 'function') {
    throw new Error('options.compare должен быть функцией');
  }
  const respond = typeof options.respond === 'function' ? options.respond : defaultRespond;
  const render = typeof options.render === 'function'
    ? options.render
    : (options.worker ? createWorkerRenderer(options.worker) : null);
  if (!render) throw new Error('Нужен рендерер: options.render (или options.worker)');
  const reference = options.reference ?? input.reference ?? null;
  if (!reference) throw new Error('Нужен оригинал для сравнения: options.reference');
  const compare = typeof options.compare === 'function'
    ? options.compare
    : defaultCompare(reference, options);

  const ctx = {
    basePlan,
    measuredBpm: pickTempo(input),
    measuredStepsByRole: measuredStepsByRole(stems, basePlan),
    measuredBassNotes: measuredBassNotes(stems, basePlan),
    options,
  };

  const result = await runRefineIterations({
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
  });

  return { ...result, method: REFINE_METHOD };
}

export default refineTwin;

// Псевдонимы точки входа — чтобы цикл можно было вызвать из маршрута
// /api/deepdive/refine любым из привычных имён.
export const refineCodeTwin = refineTwin;
export const runRefineLoop = refineTwin;
