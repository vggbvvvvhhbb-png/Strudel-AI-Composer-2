// Петля self-correction (D-139, фаза F): генерация → валидатор →
// структурный фидбек модели → исправление → финал. До maxAttempts попыток;
// если не удалось — честный отказ с ошибками, а не выдача мусора.
// Паттерн повторяет существующий рефайн спеки (compose/pipeline.js),
// но работает на уровне КОДА и с музыкальными проверками.

import { buildMessages } from './prompt.js';
import { parseAssistantResponse } from './parse-response.js';
import { validateGeneratedCode, feedbackFromErrors } from './code-validator.js';

/**
 * Транзиентная ошибка LLM (таймаут, перегрузка, сеть) — её стоит повторить
 * в рамках бюджета попыток, а не валить всю петлю. Замер E-023: 2/18
 * стресс-запросов умерли на таймаутах провайдера (роутер уже пробует две
 * модели по 120 с; дополнительный retry снаружи удвоил бы латентность —
 * поэтому повтор идёт ВНУТРИ существующего maxAttempts).
 */
export function isTransientLlmError(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  return /timeout|aborted|429|50[234]|52[0-4]|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network|перегруз/i.test(String(err?.message || err));
}

/**
 * @param {{
 *   request: string,
 *   currentCode?: string,
 *   store: object,                  // KnowledgeStore (search)
 *   callModel: (messages: Array) => Promise<string>,
 *   catalog: object,
 *   voice?: object,
 *   filters?: object,
 *   queryEmbedding?: number[]|null,
 *   maxAttempts?: number,
 *   onStep?: (step: object) => void,
 * }} opts
 * @returns {Promise<{ok: boolean, code?: string, rationale?: string, attempts: number, history: object[], errors?: object[], reason?: string, search: object}>}
 */
export async function runCorrectionLoop({
  request,
  currentCode = '',
  store,
  callModel,
  catalog,
  voice,
  filters = {},
  queryEmbedding = null,
  maxAttempts = 3,
  onStep = () => {},
}) {
  const search = await store.search({ query: request, queryEmbedding, filters, topK: 3 });
  onStep({ type: 'search', stage: search.stage, degraded: search.degraded, ids: search.results.map((r) => r.entry.id) });

  const messages = buildMessages({ userRequest: request, currentCode, searchResults: search.results, catalog, voice });
  const history = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    onStep({ type: 'generate', attempt });
    let text;
    try {
      text = await callModel(messages);
    } catch (err) {
      const message = String(err?.message || err);
      const transient = isTransientLlmError(err);
      history.push({ attempt, ok: false, errors: [{ class: 'llm', message }] });
      onStep({ type: 'llm-error', attempt, transient, message });
      // Транзиентный сбой при живом бюджете — повтор той же попытки;
      // нетранзиентный (ключ, 400) или бюджет исчерпан — честный отказ.
      if (transient && attempt < maxAttempts) continue;
      return { ok: false, attempts: attempt, history, search, reason: `LLM недоступна: ${message}`, errors: history.at(-1).errors };
    }

    const parsed = parseAssistantResponse(text);
    if (!parsed.ok) {
      const errors = [{ class: 'no-code', message: parsed.error }];
      history.push({ attempt, ok: false, errors });
      onStep({ type: 'validate', attempt, ok: false, errors });
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: feedbackFromErrors(errors) });
      continue;
    }

    const validation = await validateGeneratedCode(parsed.code, { catalog, voice });
    history.push({ attempt, ok: validation.ok, errors: validation.errors, stats: validation.stats });
    onStep({ type: 'validate', attempt, ok: validation.ok, errors: validation.errors });

    if (validation.ok) {
      return { ok: true, code: parsed.code, rationale: parsed.rationale, attempts: attempt, history, search };
    }
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: feedbackFromErrors(validation.errors) });
  }

  return {
    ok: false,
    attempts: maxAttempts,
    history,
    search,
    errors: history.at(-1)?.errors || [],
    reason: `не удалось получить валидный код за ${maxAttempts} попыток — честно сообщаем об отказе`,
  };
}