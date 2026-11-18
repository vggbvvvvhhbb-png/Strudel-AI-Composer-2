// Нативный агентный цикл: модель → инструмент → наблюдение → модель.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Старый контур (server/agent/loop.js) работает через
// текстовый JSON-план: модель описывает шаги словами, и разбор этого JSON
// — хрупкое место (модель путает типы аргументов, обрезает длинные значения,
// присылает объект строкой). Нативный вызов отдаёт аргументы структурой,
// которые провайдер проверяет сам, а модель видит результат инструмента и
// решает дальше сама.
//
// КОНТУР.  model → tool_calls → выполняем → кладём результат обратно в
// переписку → model.  Пока модель просит инструменты — крутимся; когда она
// ответила текстом без вызовов — это и есть финальный ответ.
//
// ЗАПАСНОЙ ПУТЬ. Если провайдер не поддерживает вызовы инструментов, цикл
// бросает ошибку с кодом TOOLS_UNSUPPORTED, и вызывающий код переходит на
// текстовый план. Агент работает в обоих режимах.
//
// ЛИМИТЫ. Те же, что и у старого контура: SessionGuard считает шаги, вызовы
// инструментов и время. Инструмент вне режима не выполняется: режим — это
// и есть лимит.

import { runTool, toolApiSchemas } from './tools.js';
import { nativeMessages } from './prompts.js';

/**
 * Результат инструмента в виде строки для переписки с моделью.
 *
 * Код трека в наблюдение не кладём: он большой, а модели он не нужен —
 * компоновку она получила из спеки. Но сам факт и длина важны.
 *
 * @param {object} result
 * @returns {string}
 */
function toolResultText(result) {
  if (!result) return '{"ok":false,"reason":"инструмент не ответил"}';
  const payload = {
    ok: Boolean(result.ok),
    degraded: Boolean(result.degraded),
    reason: result.reason ?? null,
  };
  if (result.style) payload.style = result.style;
  if (result.parts) payload.parts = result.parts;
  if (result.sections) payload.sections = result.sections;
  if (result.usedFallback !== undefined) payload.usedFallback = result.usedFallback;
  // Код трека кладём в наблюдение: без него модель писала в ответе свой
  // собственный код вместо скомпилированного. Это и разные вещи.
  if (result.code) payload.code = String(result.code).slice(0, 12_000);
  if (result.voices !== undefined) payload.voices = result.voices;
  if (result.budgetOk !== undefined) payload.budgetOk = result.budgetOk;
  if (result.transform) payload.transform = result.transform;
  if (Array.isArray(result.errors) && result.errors.length) payload.errors = result.errors.slice(0, 5);
  if (result.delta) payload.delta = result.delta;
  if (result.available !== undefined) payload.available = result.available;
  if (Array.isArray(result.results)) {
    payload.results = result.results.slice(0, 5).map((item) => ({
      title: item.title ?? null,
      url: item.url ?? null,
    }));
  }
  if (result.text) payload.text = String(result.text).slice(0, 2000);
  if (result.hits) payload.hits = result.hits.slice(0, 5);
  if (result.reference) payload.reference = result.reference;
  return JSON.stringify(payload);
}

/**
 * Основной нативный цикл.
 *
 * @param {{
 *   prompt: string,
 *   mode: object,
 *   currentCode?: string|null,
 *   currentIr?: object|null,
 *   history?: Array<{role:string, content:string}>,
 *   signal?: AbortSignal,
 *   env?: object,
 *   fetchImpl?: Function,
 *   guard: object,
 *   completeChatTools: Function,
 *   completeChat?: Function|null,
 *   onUsage?: Function|null,
 * }} options
 * @returns {AsyncGenerator<object>} события агента
 */
export async function* runNativeAgent({
  prompt,
  mode,
  currentCode = null,
  currentIr = null,
  history = [],
  signal,
  env = process.env,
  fetchImpl,
  guard,
  completeChatTools,
  completeChat = null,
  onUsage = null,
} = {}) {
  const tools = toolApiSchemas(mode.tools);
  const bag = { spec: null, code: currentCode, ir: currentIr };
  const observations = [];
  const degradedTools = [];
  const messages = nativeMessages({ mode: mode.id, prompt, history, context: { code: currentCode } });

  let index = 0;
  let planSent = false;
  let answer = '';

  // Раундов не больше, чем шагов: каждый раунд — это работа модели плюс
  // выполнение её вызовов. Гард всё равно считает точнее, но верхняя граница
  // нужна, чтобы цикл не крутился вечно при поломке провайдера.
  const maxRounds = Math.max(2, mode.maxSteps);

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal?.aborted) {
      yield { type: 'error', message: 'Запрос отменён' };
      return;
    }
    if (guard.isOutOfTime()) {
      yield { type: 'error', message: `Лимит времени (${Math.round(guard.limits.maxWallMs / 1000)} с) исчерпан.` };
      break;
    }

    let response;
    try {
      response = await completeChatTools({
        messages,
        tools,
        temperature: round === 0 ? 0.3 : 0.2,
        signal,
        feature: 'agent-plan',
      });
    } catch (err) {
      if (signal?.aborted) {
        yield { type: 'error', message: 'Запрос отменён' };
        return;
      }
      // Провайдер не умеет вызовы — сигнал вызывающему: пора на запасной путь.
      if (err?.code === 'TOOLS_UNSUPPORTED') throw err;
      if (round === 0 && !planSent) {
        // Модель упала на ПЕРВОМ обращении: нативный путь ещё ничего не
        // показал. Отдаём вызывающему: он перейдёт на текстовый план, который
        // умеет работать и без модели (эвристика + локальные инструменты).
        err.fallbackToPlan = true;
        throw err;
      }
      yield { type: 'error', message: `Модель не ответила: ${err?.message || err}` };
      break;
    }

    const calls = response.toolCalls ?? [];

    if (!calls.length) {
      // Модель ответила текстом: это финальный ответ.
      answer = response.content ?? '';
      if (answer) yield { type: 'text', text: answer };
      break;
    }

    if (!planSent) {
      planSent = true;
      yield {
        type: 'plan',
        mode: mode.id,
        modeLabel: mode.label,
        goal: String(prompt).slice(0, 200),
        steps: calls.map((call) => ({ tool: call.name, args: call.arguments ?? {}, why: null })),
        planSource: 'model',
        degraded: false,
        reason: null,
      };
    }

    // Сообщение модели с её вызовами — обязательная часть переписки.
    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    });

    for (const call of calls) {
      if (signal?.aborted) {
        yield { type: 'error', message: 'Запрос отменён' };
        return;
      }
      if (!guard.canStep()) {
        yield { type: 'error', message: `Лимит шагов (${guard.limits.maxSteps}) исчерпан.` };
        break;
      }
      const allowedCall = guard.canCallTool(call.name);
      if (!allowedCall.allowed) {
        yield { type: 'tool_end', id: call.name, ok: false, degraded: false, reason: allowedCall.reason, ms: 0 };
        observations.push({ tool: call.name, ok: false, degraded: false, reason: allowedCall.reason });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, reason: allowedCall.reason }) });
        continue;
      }

      guard.countStep();
      guard.countToolCall(call.name);
      index += 1;

      // Аргументы из сессии важнее того, что прислала модель: план трека
      // (IR) живёт у нас, модель его не видит целиком. Спека же вообще не
      // аргумент: её берут инструменты из состояния сессии.
      const args = { ...(call.arguments ?? {}) };
      if (call.name === 'edit_ir' && !isObject(args.ir) && isObject(bag.ir)) args.ir = bag.ir;

      yield { type: 'tool_start', id: call.name, index, args, why: null };

      const startedAt = performance.now();
      const result = await runTool(call.name, args, {
        env,
        fetchImpl,
        signal,
        currentCode,
        currentIr,
        // Спека сессии: компиляция и правка дорожки берут её отсюда, а не из
        // выдумки модели — выдуманная спека ломала бы компиляцию.
        currentSpec: bag.spec,
        reference: bag.reference ?? null,
        // Без completeChat инструмент compose_spec всегда уходил в запасной
        // путь: модель не вызывалась вовсе, и «спека модели» не рождалась.
        completeChat,
        onUsage,
      });
      const ms = Math.round((performance.now() - startedAt) * 10) / 10;

      const ok = Boolean(result?.ok);
      const degraded = Boolean(result?.degraded);
      if (ok && call.name === 'analyze_reference') bag.reference = result.reference;
      if (ok && call.name === 'compose_spec') {
        bag.spec = result.spec ?? null;
        bag.code = result.code ?? bag.code;
      }
      if (ok && call.name === 'compile') {
        bag.code = result.code ?? bag.code;
      }
      if (ok && call.name === 'edit_ir') {
        bag.ir = result.ir ?? bag.ir;
      }

      const observation = {
        tool: call.name,
        ok,
        degraded,
        reason: result?.reason ?? null,
        summary: summarizeNative(call.name, result ?? {}),
        chars: typeof result?.text === 'string' ? result.text.length : null,
        code: call.name === 'compose_spec' || call.name === 'compile' ? result?.code ?? null : null,
      };
      observations.push(observation);
      if (degraded || !ok) degradedTools.push({ tool: call.name, reason: result?.reason ?? 'без причины' });

      yield {
        type: 'tool_end',
        id: call.name,
        index,
        ok,
        degraded,
        reason: result?.reason ?? null,
        summary: observation.summary,
        chars: typeof result?.text === 'string' ? result.text.length : null,
        ms,
      };

      messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultText(result) });
    }
  }

  // Итог цикла отдаём отдельным событием: вызывающий код сам соберёт ответ,
  // посчитает расход и сформирует финальное «готово».
  yield {
    type: 'native_result',
    answer,
    answerSource: answer ? 'model' : 'observations',
    observations,
    degradedTools,
    bag,
    toolsUsed: observations.map((obs) => obs.tool),
  };
}

/**
 * Обычный объект?
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Короткое резюме результата инструмента для панели.
 * @param {string} tool
 * @param {object} result
 * @returns {string}
 */
function summarizeNative(tool, result) {
  if (tool === 'library_search') {
    const hits = result.hits ?? result.banks ?? [];
    if (!hits.length) return 'ничего не найдено';
    return hits.slice(0, 6).map((hit) => (hit.name ? `${hit.name} (${hit.bank ?? ''})` : `${hit.kind}:${hit.id}`)).join('; ');
  }
  if (tool === 'analyze_reference') {
    if (!result.ok) return result.reason ?? 'данных референса нет';
    return `референс: ${result.reference?.passport?.durationS ?? 'нет данных'} с; Demucs-паспорт и кандидаты тембров готовы, ориентир не клон`;
  }
  if (tool === 'compose_spec') {
    const base = `${result.usedFallback ? 'спека собрана из библиотеки' : 'спека собрана моделью'} (стиль ${result.style}), код ${String(result.code ?? '').length} символов`;
    // Почему модельская спека не прошла: без этого в панели видно только
    // «запасной путь», а чинить — нечего.
    const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
    return errors.length ? `${base}; модельская спека не прошла: ${errors[0].slice(0, 300)}` : base;
  }
  if (tool === 'compile') {
    return `код ${String(result.code ?? '').length} символов, партий: ${(result.parts ?? []).join(', ') || '—'}`;
  }
  if (tool === 'edit_ir') {
    const delta = result.delta ?? {};
    return `трансформ ${result.transform}: оценка ${delta.scoreBefore} → ${delta.scoreAfter}`;
  }
  if (tool === 'web_search') {
    if (!result.available) return `интернет недоступен: ${result.reason}`;
    return (result.results ?? []).map((item) => `${item.title} — ${item.url}`).join('; ') || 'ничего не найдено';
  }
  if (tool === 'web_fetch') {
    return result.text ? String(result.text).slice(0, 300) : `не прочитано: ${result.reason ?? '—'}`;
  }
  return JSON.stringify(result).slice(0, 300);
}
