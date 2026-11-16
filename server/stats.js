// Учёт использования LLM без тел запросов.
//
// Правило безопасности из вводных: «ключей нет в телах статистики», «тела
// запросов не пишем». Поэтому здесь только счётчики и агрегаты: модель,
// токены, стоимость, длительность. Никаких промптов и ответов.
//
// ЗАЧЕМ ПЕРЕПИСЫВАТЬ (A0.2). До этой правки `recordUsage` была определена,
// но не вызывалась нигде: токены складывались в локальный массив маршрута и
// умирали. При этом таблица цен не содержала ни одной модели, которая
// реально работает (у владельца — gpt-6-luna через шлюз), так что даже
// включённый учёт показал бы ноль. Теперь цена считается по каждому
// вызову LLM, а неизвестные модели попадают в отдельный список — молча
// считать их бесплатными нельзя.
//
// D-120: шлюз владельца сменился с APInex на relay.fast. Цены APInex
// (плоские 0.075/0.075) к relay.fast НЕ применяются: там другая тарифная
// сетка, и перенос старой цены завышал бы расход примерно в 9 раз.

import { currentUsageContext } from './llm/context.js';

const MAX_EVENTS = 500;

const state = {
  startedAt: Date.now(),
  requests: 0,
  failures: 0,
  estimatedRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  byModel: new Map(),
  byTool: new Map(),
  byFeature: new Map(),
  bySession: new Map(),
  byDay: new Map(),
  byGroup: new Map(),
  byOperation: new Map(),
  unpricedModels: new Map(),
  recent: [],
};

/**
 * Цена за 1 млн токенов: prompt / completion, в долларах.
 *
 * Источники (проверены 16.11.2026):
 *   • relay.fast — шлюз владельца (OPENAI_BASE_URL=https://relay.fast/v1).
 *     Цены ИЗМЕРЕНЫ: дельта /v1/dashboard/billing/usage до/после вызова
 *     совпала с расчётом по токенам (D-120). Тариф зависит от источника
 *     маршрутизации; здесь ставки источника ключа владельца (GPT Team/Plus).
 *     Другие модели шлюза добавляются только после замера — иначе они
 *     попадают в unpricedModels («нет данных»), а не считаются бесплатно.
 *   • OpenAI — platform.openai.com/docs/pricing
 *   • Anthropic — assets.claude.com (List Prices, 22.09.2026)
 *   • Groq — console.groq.com/docs/models
 */
export const PRICING = {
  // --- relay.fast (шлюз владельца, D-120; измерено 16.11.2026) ---
  'gpt-6-luna': { prompt: 0.008, completion: 0.04 },
  'gpt-5.6-luna': { prompt: 0.016, completion: 0.096 },

  // --- OpenAI ---
  'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'gpt-4o': { prompt: 2.5, completion: 10 },

  // --- Anthropic ---
  'claude-sonnet-4-5': { prompt: 3, completion: 15 },
  'claude-sonnet-4': { prompt: 3, completion: 15 },

  // --- Groq ---
  // С 20.10.2026 Groq отдаёт llama-3.3-70b-versatile как Enterprise
  // («Contact Sales»); здесь последняя опубликованная цена.
  'llama-3.3-70b-versatile': { prompt: 0.59, completion: 0.79 },
  'llama-3.1-8b-instant': { prompt: 0.05, completion: 0.08 },
  'openai/gpt-oss-120b': { prompt: 0.15, completion: 0.6 },
  'openai/gpt-oss-20b': { prompt: 0.075, completion: 0.3 },

  // --- MiniMax (прямые API) ---
  'minimax-m2.1': { prompt: 0.6, completion: 2.4 },
  'minimax-text-01': { prompt: 0.4, completion: 1.6 },
};

/**
 * Транскрипция: Groq считает по секундам аудио, а не по токенам.
 * $ за час аудио (console.groq.com/docs/models, проверено 15.11.2026).
 */
export const TRANSCRIPTION_PRICES_PER_HOUR = {
  'whisper-large-v3-turbo': 0.04,
  'whisper-large-v3': 0.111,
};

/** Цена транскрипции по умолчанию (долларов за час). */
export const TRANSCRIPTION_PRICE_PER_HOUR_USD = TRANSCRIPTION_PRICES_PER_HOUR['whisper-large-v3-turbo'];

/**
 * Цена модели.
 *
 * Возвращает и признак `known`: если модели нет в таблице, цена 0 — но
 * это НЕ «бесплатно», это «нет данных». Такие модели попадают в
 * `unpricedModels`, чтобы владелец видел дыру, а не нули.
 *
 * @param {string} model
 * @returns {{prompt:number, completion:number, known:boolean, reason:string}}
 */
export function priceOf(model) {
  const name = String(model || 'unknown');
  const direct = PRICING[name];
  if (direct) return { ...direct, known: true, reason: 'table' };
  // Транскрипция тарифицируется по секундам звука — цену вызывает код
  // транскрипции, но модель считается известной, а не «без цены».
  if (name in TRANSCRIPTION_PRICES_PER_HOUR) {
    return { prompt: 0, completion: 0, known: true, reason: 'per-hour' };
  }
  return { prompt: 0, completion: 0, known: false, reason: 'unknown-model' };
}

/**
 * Записать один вызов LLM.
 *
 * @param {object} event
 * @param {string} event.model
 * @param {number} [event.promptTokens]
 * @param {number} [event.completionTokens]
 * @param {number} [event.durationMs]
 * @param {string} [event.tool] имя инструмента ассистента
 * @param {string} [event.feature] какая фича потратила токены
 * @param {string} [event.provider]
 * @param {string} [event.operationId] одна операция = одна HTTP-операция
 * @param {string} [event.sessionId] сессия браузера
 * @param {string} [event.group] группа (ночная партия, трек)
 * @param {boolean} [event.failed]
 * @param {number} [event.costUsd] готовая цена (для сервисов с другой единицей
 *   тарификации — например, транскрипции, где Groq считает по секундам аудио)
 * @param {boolean} [event.estimated] токены оценены, а не измерены провайдером
 */
export function recordUsage(event) {
  const model = String(event.model || 'unknown');
  const promptTokens = Number(event.promptTokens || 0);
  const completionTokens = Number(event.completionTokens || 0);
  const estimated = Boolean(event.estimated);
  const price = priceOf(model);
  // Явная цена важнее расчётной: у транскрипции единица — секунды звука.
  const costUsd = Number.isFinite(event.costUsd)
    ? event.costUsd
    : (promptTokens * price.prompt + completionTokens * price.completion) / 1_000_000;

  const feature = String(event.feature || 'unknown');
  // Идентификаторы операции, сессии и группы: из вызова, если переданы,
  // иначе — из контекста запроса (server/llm/context.js). Тогда любой
  // вызов recordUsage внутри запроса автоматически попадает в «цену трека».
  const context = currentUsageContext();
  const operationId = event.operationId || context.operationId || null;
  const sessionId = event.sessionId || context.sessionId || null;
  const group = event.group || context.group || null;

  state.requests += 1;
  state.promptTokens += promptTokens;
  state.completionTokens += completionTokens;
  state.costUsd += costUsd;
  if (event.failed) state.failures += 1;
  if (estimated) state.estimatedRequests += 1;

  const modelStats = state.byModel.get(model) || { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  modelStats.requests += 1;
  modelStats.promptTokens += promptTokens;
  modelStats.completionTokens += completionTokens;
  modelStats.costUsd += costUsd;
  state.byModel.set(model, modelStats);

  // В «модели без цены» попадают только LLM-модели с неизвестной ставкой за
  // токены. Счётчики сервисов с другой единицей тарификации (Exa — доллары
  // за запрос, Freesound — бесплатный API) передают явный costUsd и сюда
  // не относятся: «нет данных» о них нет.
  if (!price.known && !Number.isFinite(event.costUsd)) {
    const unknown = state.unpricedModels.get(model) || { model, requests: 0, promptTokens: 0, completionTokens: 0 };
    unknown.requests += 1;
    unknown.promptTokens += promptTokens;
    unknown.completionTokens += completionTokens;
    state.unpricedModels.set(model, unknown);
  }

  if (event.tool) {
    const toolStats = state.byTool.get(event.tool) || { calls: 0, failed: 0 };
    toolStats.calls += 1;
    if (event.failed) toolStats.failed += 1;
    state.byTool.set(event.tool, toolStats);
  }

  bump(state.byFeature, feature, promptTokens, completionTokens, costUsd);
  bump(state.byOperation, operationId || 'unknown', promptTokens, completionTokens, costUsd);
  if (sessionId) bump(state.bySession, sessionId, promptTokens, completionTokens, costUsd);
  if (group) bump(state.byGroup, group, promptTokens, completionTokens, costUsd);
  bump(state.byDay, dayKey(), promptTokens, completionTokens, costUsd);

  state.recent.push({
    ts: Date.now(),
    model,
    provider: event.provider || null,
    tool: event.tool || null,
    feature,
    operationId,
    sessionId,
    group,
    promptTokens,
    completionTokens,
    costUsd: Number(costUsd.toFixed(8)),
    durationMs: Number(event.durationMs || 0),
    estimated,
    failed: Boolean(event.failed),
  });
  if (state.recent.length > MAX_EVENTS) state.recent = state.recent.slice(-MAX_EVENTS);

  return state.recent[state.recent.length - 1];
}

/**
 * Сводка для /api/stats. Никаких тел запросов и ключей.
 */
export function usageSummary() {
  const today = dayKey();
  const byDay = roundCosts(Object.fromEntries(state.byDay));
  const bySession = roundCosts(Object.fromEntries(state.bySession));
  const byGroup = roundCosts(Object.fromEntries(state.byGroup));
  const byOperation = roundCosts(Object.fromEntries(state.byOperation));
  const byFeature = roundCosts(Object.fromEntries(state.byFeature));
  const byModel = roundCosts(Object.fromEntries(state.byModel));

  // Цена одной операции = цена одной «генерации» (трека). Операция — это
  // один HTTP-запрос к серверу; все LLM-вызовы внутри него попадают в неё.
  const operationCosts = Object.entries(byOperation)
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    requests: state.requests,
    failures: state.failures,
    // Сколько записей основано на оценке, а не на счётчике провайдера.
    estimatedRequests: state.estimatedRequests,
    promptTokens: state.promptTokens,
    completionTokens: state.completionTokens,
    totalTokens: state.promptTokens + state.completionTokens,
    costUsd: roundCost(state.costUsd),
    byModel,
    byTool: Object.fromEntries(state.byTool),
    byFeature,
    bySession,
    byDay,
    byGroup,
    byOperation,
    // Цена трека: операции по стоимости, новые сверху.
    tracks: operationCosts.slice(0, 20),
    trackCount: operationCosts.length,
    // Цена сессии — сумма по браузерным сессиям.
    sessions: Object.entries(bySession)
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => b.costUsd - a.costUsd),
    // Цена ночи — сумма за текущие сутки (по локальному времени сервера).
    night: byDay[today] || { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 },
    today,
    // Модели без известной цены: молча считать их бесплатными нельзя.
    unpricedModels: [...state.unpricedModels.values()],
    recent: state.recent.slice(-20),
  };
}

export function resetUsage() {
  state.requests = 0;
  state.failures = 0;
  state.estimatedRequests = 0;
  state.promptTokens = 0;
  state.completionTokens = 0;
  state.costUsd = 0;
  state.byModel.clear();
  state.byTool.clear();
  state.byFeature.clear();
  state.bySession.clear();
  state.byDay.clear();
  state.byGroup.clear();
  state.byOperation.clear();
  state.unpricedModels.clear();
  state.recent = [];
}

// --- внутреннее ---

/**
 * Ключ суток: YYYY-MM-DD по локальному времени сервера.
 * @returns {string}
 */
export function dayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Округление цены. Восемь знаков: цена одного вызова может быть порядка
 * 1e-4 доллара, и шести знаков не хватало — итог переставал сходиться с
 * суммой агрегатов.
 * @param {number} value
 * @returns {number}
 */
export function roundCost(value) {
  return Number(Number(value || 0).toFixed(8));
}

/**
 * Округлить цену во всех агрегатах разом — чтобы суммы сходились.
 * @param {object} aggregate
 * @returns {object}
 */
function roundCosts(aggregate) {
  const out = {};
  for (const [key, value] of Object.entries(aggregate)) {
    out[key] = { ...value, costUsd: roundCost(value.costUsd) };
  }
  return out;
}

/**
 * Добавить сумму в агрегат по ключу.
 */
function bump(map, key, promptTokens, completionTokens, costUsd) {
  const stats = map.get(key) || { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  stats.requests += 1;
  stats.promptTokens += promptTokens;
  stats.completionTokens += completionTokens;
  stats.costUsd += costUsd;
  map.set(key, stats);
}
