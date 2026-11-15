// Агентный цикл: план → вызов инструмента → наблюдение → ответ.
//
// НАСТОЯЩИЙ ЦИКЛ, А НЕ ДЕКОРАЦИЯ. Модель выбирает инструменты, мы их
// выполняем, результат возвращаем модели, и она решает дальше. У донора
// (.scratch/shveyka-igolka) настоящего tool-calling нет: там поиск по
// tool_calls/tool_choice/function_call даёт ноль совпадений, «инструменты»
// зашиты в конвейер. Здесь цикл наш.
//
// ЧТО ОТДАЁТСЯ НАРУЖУ. Генератор событий: панель студии показывает шаги
// отдельно от текста ответа, поэтому события раздельные:
//   plan        — план и его источник (модель или эвристика)
//   tool_start  — начало вызова инструмента
//   tool_end    — результат вызова (ок / деградация / ошибка)
//   text        — кусок текста ответа
//   usage       — потраченные токены и деньги
//   done        — итог: ответ, что сработало, что задеградировало
//   error       — непоправимая ошибка
//
// ЧЕСТНОСТЬ. Если инструмент не сработал — это попадает и в наблюдение, и в
// ответ. Если LLM недоступен, агент не падает: план строится эвристикой,
// ответ собирается из наблюдений.

import { completeChat, streamChat } from '../llm/router.js';
import { estimateUsage } from '../llm/usage.js';
import { recordUsage, usageSummary } from '../stats.js';

import { SessionGuard } from './guard.js';
import { heuristicPlan, parsePlan } from './navigator.js';
import { modeById } from './modes.js';
import { answerMessages, plannerMessages } from './prompts.js';
import { runTool } from './tools.js';
import { catalogVersion } from './library.js';
import { TtlLruCache, cacheKey, isCacheable } from './cache.js';

const answerCache = new TtlLruCache({ max: 100, ttlMs: 6 * 60 * 60 * 1000 });

/**
 * Определяет режим по словам в запросе, если клиент его не задал.
 *
 * ПОРЯДОК ПРОВЕРКИ — ПО ЦЕЛИ, А НЕ ПО ПЕРВОМУ СОВПАДЕНИЮ. Запрос гайда
 * «найди в интернете, что такое phonk drift, и сделай бит в этом стиле» содержит
 * и поиск, и композицию. Раньше побеждал поиск, и агент оставался в ресёрче без
 * инструментов компиляции — то есть половину запроса выполнить не мог. Цель
 * такого запроса — бит, а поиск лишь подготовительный шаг, поэтому побеждает
 * композитор.
 *
 * @param {string} prompt
 * @returns {string}
 */
export function detectMode(prompt) {
  const text = String(prompt || '').toLowerCase();
  const wantsResearch = /(найди|поищи|загугли|что такое|в интернете|источник|статья)/.test(text);
  const wantsDirector = /(поменяй|замени|сделай (тише|громче|мрачн|светлее)|правк|тембр|микс)/.test(text);
  const wantsComposition = /(сделай|собери|создай|напиши|бит|трек|компози)/.test(text);
  if (wantsComposition && !wantsDirector) return 'composer';
  if (wantsResearch) return 'research';
  if (wantsDirector) return 'director';
  return 'chat';
}

/**
 * Короткое резюме результата инструмента — то, что уходит в наблюдение.
 * @param {string} tool
 * @param {object} result
 * @returns {string}
 */
function summarize(tool, result) {
  if (!result) return '';
  if (tool === 'library_search') {
    const hits = result.hits ?? result.banks ?? [];
    if (!hits.length) return 'ничего не найдено';
    const first = hits[0];
    if (result.kind === 'samples') {
      return `${result.total ?? hits.length} совпадений; пример: ${hits.slice(0, 5).map((h) => `${h.name} (${h.bank}, лицензия: ${h.license})`).join('; ')}`;
    }
    if (result.kind === 'banks') {
      return hits.map((h) => `${h.bank} — ${h.names} имён, лицензия: ${h.license}`).join('; ');
    }
    return hits.slice(0, 6).map((h) => `${h.kind}:${h.id}`).join(', ');
  }
  if (tool === 'compose_spec') {
    return result.usedFallback
      ? `спека собрана из библиотеки (стиль ${result.style}), код ${String(result.code ?? '').length} символов`
      : `спека собрана моделью (стиль ${result.style}), код ${String(result.code ?? '').length} символов`;
  }
  if (tool === 'compile') {
    return `код ${String(result.code ?? '').length} символов, партий: ${(result.parts ?? []).join(', ') || '—'}`;
  }
  if (tool === 'edit_ir') {
    const delta = result.delta ?? {};
    return `трансформ ${result.transform}: оценка ${delta.scoreBefore} → ${delta.scoreAfter}, темп ${delta.bpmBefore} → ${delta.bpmAfter}`;
  }
  if (tool === 'web_search') {
    if (!result.available) return `интернет недоступен: ${result.reason}`;
    return (result.results ?? []).map((r) => `${r.title} — ${r.url}`).join('; ') || 'ничего не найдено';
  }
  if (tool === 'web_fetch') {
    return result.text ? String(result.text).slice(0, 400) : `не прочитано: ${result.reason ?? '—'}`;
  }
  if (tool === 'usage_report') {
    return `стоимость ${JSON.stringify(result.costUsd ?? result.night ?? null)}`;
  }
  return JSON.stringify(result).slice(0, 400);
}

/**
 * Ответ без LLM: собирается из наблюдений. Не выдумывает ничего — только
 * пересказывает то, что вернули инструменты.
 * @param {{plan:object, observations:Array, degraded:Array}} options
 * @returns {string}
 */
export function deterministicAnswer({ plan, observations, degraded }) {
  const lines = [`План: ${plan.goal}`, ''];
  if (!observations.length) {
    lines.push('Инструменты не вызывались: нечего показать по фактам.');
    return lines.join('\n');
  }
  for (const obs of observations) {
    lines.push(`• ${obs.tool}: ${obs.ok ? (obs.degraded ? 'деградация' : 'ок') : 'не сработал'}`);
    if (obs.reason) lines.push(`  причина: ${obs.reason}`);
    if (obs.summary) lines.push(`  ${obs.summary}`);
    if (obs.code) {
      lines.push('```');
      lines.push(obs.code);
      lines.push('```');
    }
  }
  if (degraded.length) {
    lines.push('', 'Честная оговорка: часть инструментов не дала данных — перечислено выше.');
  }
  lines.push('', '(Ответ собран без модели: LLM недоступен или не ответил.)');
  return lines.join('\n');
}

/**
 * Основной цикл агента.
 *
 * @param {{
 *   prompt: string,
 *   mode?: string,
 *   currentCode?: string|null,
 *   currentIr?: object|null,
 *   history?: Array<{role:string, content:string}>,
 *   signal?: AbortSignal,
 *   env?: object,
 *   fetchImpl?: Function,
 * }} options
 * @returns {AsyncGenerator<object>} события агента
 */
export async function* runAgent({
  prompt,
  mode: requestedMode,
  currentCode = null,
  currentIr = null,
  history = [],
  signal,
  env = process.env,
  fetchImpl,
} = {}) {
  const mode = modeById(requestedMode || detectMode(prompt));
  const guard = new SessionGuard({
    maxSteps: mode.maxSteps,
    maxToolCalls: mode.maxToolCalls,
  });

  const ctx = {
    env,
    fetchImpl,
    signal,
    currentCode,
    currentIr,
    completeChat: (options) => completeChat({ ...options, feature: 'agent-plan' }),
    onUsage: null,
  };

  // --- План -------------------------------------------------------------
  let plan = null;
  let planSource = 'heuristic';
  try {
    const answer = await completeChat({
      messages: plannerMessages({
        mode: mode.id,
        prompt,
        tools: mode.tools,
        context: { code: currentCode },
        history,
      }),
      temperature: 0.1,
      signal,
      feature: 'agent-plan',
      responseFormat: { type: 'json_object' },
    });
    plan = parsePlan(answer);
    if (plan) planSource = 'model';
  } catch (err) {
    if (signal?.aborted) {
      yield { type: 'error', message: 'Запрос отменён' };
      return;
    }
    // Ошибка модели — не ошибка режима: план строим эвристикой.
    // Причину пишем в лог: молча проглоченная ошибка планирования выглядит
    // как «модель ответила ерундой», а это разные вещи.
    console.error('[agent] план от модели не получен:', err?.message || err);
    plan = null;
  }
  if (!plan) {
    plan = heuristicPlan(prompt);
    planSource = 'heuristic';
  }
  // Инструменты вне режима в план не пускаем: режим — это и есть лимит.
  const allowed = new Set(mode.tools);
  const steps = (plan.steps ?? []).filter((step) => allowed.has(step.tool));
  plan = { ...plan, steps };

  yield {
    type: 'plan',
    mode: mode.id,
    modeLabel: mode.label,
    goal: plan.goal,
    steps: steps.map((step) => ({ tool: step.tool, args: step.args, why: step.why ?? null })),
    planSource,
    degraded: planSource === 'heuristic',
    reason: planSource === 'heuristic' ? 'Модель не дала валидный план — шаги выбраны по правилам.' : null,
  };

  // --- Выполнение шагов -------------------------------------------------
  const observations = [];
  const degradedTools = [];
  const bag = { spec: null, code: currentCode, ir: currentIr };
  let index = 0;

  // Шаги выполняются из очереди: после успешного поиска цикл может добавить
  // шаг «прочитать найденную страницу». Модель не знает адрес заранее, а
  // гейт A требует путь «найди → прочитай → собери»: без чтения запрос
  // остаётся сбором заголовков.
  const queue = [...steps];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const step = queue[queueIndex];
    queueIndex += 1;
    if (signal?.aborted) {
      yield { type: 'error', message: 'Запрос отменён' };
      return;
    }
    if (!guard.canStep()) {
      yield { type: 'error', message: `Лимит шагов (${guard.limits.maxSteps}) исчерпан.` };
      break;
    }
    if (guard.isOutOfTime()) {
      yield { type: 'error', message: `Лимит времени (${Math.round(guard.limits.maxWallMs / 1000)} с) исчерпан.` };
      break;
    }
    const allowedCall = guard.canCallTool(step.tool);
    if (!allowedCall.allowed) {
      yield { type: 'tool_end', id: step.tool, ok: false, degraded: false, reason: allowedCall.reason, ms: 0 };
      observations.push({ tool: step.tool, ok: false, degraded: false, reason: allowedCall.reason });
      continue;
    }

    guard.countStep();
    guard.countToolCall(step.tool);
    index += 1;

    // Аргументы подставляются из контекста, если модель их не задала:
    // compile берёт спеку из предыдущего шага, edit_ir — текущий план трека.
    const args = { ...(step.args ?? {}) };
    if (step.tool === 'compile' && !args.spec && bag.spec) args.spec = bag.spec;
    if (step.tool === 'edit_ir' && !args.ir && bag.ir) args.ir = bag.ir;

    yield { type: 'tool_start', id: step.tool, index, args, why: step.why ?? null };

    // Время инструмента меряем высокоточным таймером: Date.now() имеет
    // миллисекундную сетку и для быстрых инструментов честно показывал «0 мс»,
    // хотя работа была. Округляем до 0.1 мс — дробная часть значима.
    const startedAt = performance.now();
    const result = await runTool(step.tool, args, ctx);
    const ms = Math.round((performance.now() - startedAt) * 10) / 10;

    const ok = Boolean(result?.ok);
    const degraded = Boolean(result?.degraded);
    if (ok && step.tool === 'compose_spec') {
      bag.spec = result.spec ?? null;
      bag.code = result.code ?? bag.code;
    }
    if (ok && step.tool === 'compile') {
      bag.code = result.code ?? bag.code;
    }
    if (ok && step.tool === 'edit_ir') {
      bag.ir = result.ir ?? bag.ir;
    }

    const observation = {
      tool: step.tool,
      ok,
      degraded,
      reason: result?.reason ?? null,
      summary: summarize(step.tool, result ?? {}),
      code: step.tool === 'compose_spec' ? result?.code ?? null : step.tool === 'compile' ? result?.code ?? null : null,
    };
    observations.push(observation);
    if (degraded || !ok) degradedTools.push({ tool: step.tool, reason: result?.reason ?? 'без причины' });

    // Поиск нашёл страницу — читаем её. Шаг добавляется в очередь на лету:
    // адрес известен только после поиска, а без текста страницы агент знает
    // лишь заголовок. Шаг видно в панели отдельной карточкой.
    if (ok && step.tool === 'web_search' && allowed.has('web_fetch')
      && !queue.some((item) => item.tool === 'web_fetch')) {
      const url = (result?.results ?? []).map((item) => item?.url).find(Boolean);
      if (url) {
        queue.push({
          tool: 'web_fetch',
          args: { url },
          why: 'прочитать найденную страницу (шаг добавлен после поиска)',
        });
      }
    }

    yield {
      type: 'tool_end',
      id: step.tool,
      index,
      ok,
      degraded,
      reason: result?.reason ?? null,
      summary: observation.summary,
      ms,
    };
  }

  // --- Ответ ------------------------------------------------------------
  const usesMeasurements = observations.some((obs) => obs.tool === 'compose_spec' || obs.tool === 'edit_ir');
  const cacheable = isCacheable({ hasHistory: history.length > 0, usesMeasurements });
  const key = cacheKey({ question: prompt, mode: mode.id, catalogVersion: catalogVersion() });

  let answer = '';
  let answerSource = 'model';
  let answerMessagesText = '';
  if (cacheable) {
    const cached = answerCache.get(key);
    if (cached) {
      answer = cached;
      answerSource = 'cache';
    }
  }

  if (!answer) {
    const before = usageSummary();
    try {
      // Сообщения сохраняем: по ним же считаем оценку токенов, когда
      // провайдер не отдал счётчики. Оценка по голому запросу занижала бы
      // расход в разы: в промпте есть план и все наблюдения.
      const messages = answerMessages({ mode: mode.id, prompt, plan, observations, history });
      answerMessagesText = JSON.stringify(messages);
      const stream = streamChat({
        messages,
        temperature: 0.4,
        signal,
        feature: 'agent-answer',
      });
      for await (const delta of stream) {
        if (signal?.aborted) {
          yield { type: 'error', message: 'Запрос отменён' };
          return;
        }
        answer += delta;
        yield { type: 'text', text: delta };
      }
    } catch (err) {
      if (signal?.aborted) {
        yield { type: 'error', message: 'Запрос отменён' };
        return;
      }
      // Модель недоступна — отвечаем по наблюдениям, а не падаем.
      answer = deterministicAnswer({ plan, observations, degraded: degradedTools });
      answerSource = 'observations';
    }
    if (answerSource === 'model' && cacheable && answer.trim()) {
      answerCache.set(key, answer);
    }
    const after = usageSummary();
    const measuredTokens = after.totalTokens - before.totalTokens;
    const measuredCost = Number((after.costUsd - before.costUsd).toFixed(6));
    // Счётчики провайдера могут не прийти (или это мок) — тогда токенов
    // «ноль», но это не «бесплатно», а «нет данных». Считаем оценку и
    // честно помечаем её, чтобы панель не показывала ноль как факт.
    const estimate = measuredTokens > 0 ? null : estimateUsage(answer, answerMessagesText || prompt);
    const tokens = measuredTokens > 0 ? measuredTokens : estimate.promptTokens + estimate.completionTokens;
    yield {
      type: 'usage',
      tokens,
      costUsd: measuredCost,
      requestCount: after.requests - before.requests,
      estimated: !measuredTokens,
      // Цена честно остаётся нулём, если модель неизвестна: выдумывать
      // стоимость нельзя, а «цена не измерена» — это честная формулировка.
      priceKnown: measuredCost > 0,
    };
  } else {
    yield { type: 'text', text: answer };
    yield { type: 'usage', tokens: 0, costUsd: 0, cached: true, estimated: false, priceKnown: false };
  }

  yield {
    type: 'done',
    mode: mode.id,
    answer,
    answerSource,
    planSource,
    toolsUsed: observations.map((obs) => obs.tool),
    degraded: degradedTools,
    observations,
    track: { code: bag.code ?? null, spec: bag.spec ?? null, ir: bag.ir ?? null },
    guard: guard.snapshot(),
  };
}

/**
 * Оценка usage для провайдеров, которые не отдают счётчики токенов.
 * Используется, чтобы «цена агента» не была нулевой из-за молчаливого шлюза.
 * @param {string} text
 * @param {string} promptText
 * @param {{model?:string, provider?:string, feature?:string}} options
 */
export function recordEstimatedUsage(text, promptText, { model = 'unknown', provider = 'unknown', feature = 'agent' } = {}) {
  const estimate = estimateUsage(text, promptText);
  recordUsage({
    model,
    provider,
    feature,
    promptTokens: estimate.promptTokens,
    completionTokens: estimate.completionTokens,
    estimated: true,
  });
  return estimate;
}
