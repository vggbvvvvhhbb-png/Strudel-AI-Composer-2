// Учёт использования LLM без тел запросов.
//
// Правило безопасности из вводных: «ключей нет в телах статистики», «тела
// запросов не пишем». Поэтому здесь только счётчики и агрегаты: модель,
// токены, стоимость, длительность. Никаких промптов и ответов.

const MAX_EVENTS = 500;

const state = {
  startedAt: Date.now(),
  requests: 0,
  failures: 0,
  promptTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  byModel: new Map(),
  byTool: new Map(),
  recent: [],
};

/** Цена за 1M токенов: prompt / completion, в долларах. */
export const PRICING = {
  'minimax-m2.1': { prompt: 0.6, completion: 2.4 },
  'minimax-text-01': { prompt: 0.4, completion: 1.6 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'gpt-4o': { prompt: 2.5, completion: 10 },
  'claude-sonnet-4': { prompt: 3, completion: 15 },
};

function priceOf(model) {
  return PRICING[model] || { prompt: 0, completion: 0 };
}

/**
 * @param {object} event
 * @param {string} event.model
 * @param {number} [event.promptTokens]
 * @param {number} [event.completionTokens]
 * @param {number} [event.durationMs]
 * @param {string} [event.tool] имя инструмента ассистента
 * @param {boolean} [event.failed]
 */
export function recordUsage(event) {
  const model = String(event.model || 'unknown');
  const promptTokens = Number(event.promptTokens || 0);
  const completionTokens = Number(event.completionTokens || 0);
  const price = priceOf(model);

  state.requests += 1;
  state.promptTokens += promptTokens;
  state.completionTokens += completionTokens;
  state.costUsd += (promptTokens * price.prompt + completionTokens * price.completion) / 1_000_000;
  if (event.failed) state.failures += 1;

  const modelStats = state.byModel.get(model) || { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  modelStats.requests += 1;
  modelStats.promptTokens += promptTokens;
  modelStats.completionTokens += completionTokens;
  modelStats.costUsd += (promptTokens * price.prompt + completionTokens * price.completion) / 1_000_000;
  state.byModel.set(model, modelStats);

  if (event.tool) {
    const toolStats = state.byTool.get(event.tool) || { calls: 0, failed: 0 };
    toolStats.calls += 1;
    if (event.failed) toolStats.failed += 1;
    state.byTool.set(event.tool, toolStats);
  }

  state.recent.push({
    ts: Date.now(),
    model,
    tool: event.tool || null,
    promptTokens,
    completionTokens,
    durationMs: Number(event.durationMs || 0),
    failed: Boolean(event.failed),
  });
  if (state.recent.length > MAX_EVENTS) state.recent = state.recent.slice(-MAX_EVENTS);

  return state.recent[state.recent.length - 1];
}

/** Сводка для /api/stats. Никаких тел запросов и ключей. */
export function usageSummary() {
  return {
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    requests: state.requests,
    failures: state.failures,
    promptTokens: state.promptTokens,
    completionTokens: state.completionTokens,
    totalTokens: state.promptTokens + state.completionTokens,
    costUsd: Number(state.costUsd.toFixed(6)),
    byModel: Object.fromEntries(state.byModel),
    byTool: Object.fromEntries(state.byTool),
    recent: state.recent.slice(-20),
  };
}

export function resetUsage() {
  state.requests = 0;
  state.failures = 0;
  state.promptTokens = 0;
  state.completionTokens = 0;
  state.costUsd = 0;
  state.byModel.clear();
  state.byTool.clear();
  state.recent = [];
}
