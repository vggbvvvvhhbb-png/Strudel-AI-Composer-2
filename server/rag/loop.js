// Петля self-correction (D-139, фаза F): генерация → валидатор →
// структурный фидбек модели → исправление → финал. До maxAttempts попыток;
// если не удалось — честный отказ с ошибками, а не выдача мусора.
// Паттерн повторяет существующий рефайн спеки (compose/pipeline.js),
// но работает на уровне КОДА и с музыкальными проверками.

import { buildMessages } from './prompt.js';
import { parseAssistantResponse } from './parse-response.js';
import { validateGeneratedCode, feedbackFromErrors } from './code-validator.js';

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
      history.push({ attempt, ok: false, errors: [{ class: 'llm', message: String(err?.message || err) }] });
      return { ok: false, attempts: attempt, history, search, reason: `LLM недоступна: ${err?.message || err}`, errors: history.at(-1).errors };
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