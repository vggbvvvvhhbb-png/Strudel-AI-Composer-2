// Навигатор: план действий агента.
//
// ПОРТИРОВАНО из донора (.scratch/shveyka-igolka/packages/core/src/ai/navigator.ts):
// схема плана на zod, разбор ответа модели и эвристический запасной план, когда
// модель вернула не JSON. Ключевое решение донора сохранено: ошибка модели —
// НЕ ошибка режима. Планировщик отвечает «вот план», а не «извините».
//
// Отличие от донора: там план описывал ПОИСКОВЫЕ ЗАПРОСЫ, здесь — ВЫЗОВЫ
// ИНСТРУМЕНТОВ. У донора настоящего tool-calling нет (проверено поиском по
// tool_calls/tool_choice/function_call: ноль совпадений), поэтому контур
// инструментов мы строим сами, и план — это наш вход в него.
//
// Схема плана (её же видит модель в промте):
//   { mode, goal, steps: [{ tool, args, why }] }

import { z } from 'zod';

export const AGENT_MODES = ['chat', 'research', 'composer', 'director', 'hunter'];

export const PlanStepSchema = z.object({
  tool: z.string().min(1).max(64),
  args: z.record(z.any()).default({}),
  why: z.string().max(400).optional(),
});

export const PlanSchema = z.object({
  mode: z.enum(AGENT_MODES).default('chat'),
  goal: z.string().min(1).max(600),
  steps: z.array(PlanStepSchema).max(8).default([]),
});

/**
 * Чистый текст запроса: убирает служебный префикс «Запрос: …».
 * @param {string} text
 * @returns {string}
 */
export function extractRequest(text) {
  const raw = String(text || '').trim();
  const match = /^Запрос:\s*([\s\S]+)$/.exec(raw);
  return (match ? match[1] : raw).trim();
}

/**
 * Эвристический план: когда модель недоступна или ответила мусором.
 *
 * Правила простые и проверяемые: по словам в запросе видно, чего хотят
 * («найди» → поиск, «сделай бит» → сборка, «поменяй тембр» → правка).
 * План всегда безопасный: ни одного шага, который что-то разрушает.
 *
 * @param {string} prompt
 * @returns {{mode:string, goal:string, steps:Array<{tool:string, args:object, why:string}>}}
 */
export function heuristicPlan(prompt) {
  const request = extractRequest(prompt);
  const text = request.toLowerCase();
  const steps = [];

  const wantsResearch = /(найди|поищи|загугли|что такое|кто такой|в интернете|поиск|статья|доклад|источник)/.test(text);
  const wantsCompose = /(сделай|собери|создай|напиши|придумай|сгенерируй).{0,40}(бит|трек|компози|beat|loop|сэмпл)/.test(text)
    || /(бит|трек|композиция)/.test(text) && /(сделай|собери|создай|напиши)/.test(text);
  const wantsDirector = /(поменяй|замени|сделай (ещ|тише|громче|мрачн|светлее)|правк|измени|отредактируй|тембр)/.test(text);
  const wantsHunter = /(редк|необычн|странн|экзотич|стеклян|кристалл|причудлив).{0,40}(звук|сэмпл|удар|тон|шум)|(найди|найди-нибудь).{0,40}(редкий|необычный|странный).{0,20}(звук|сэмпл)/.test(text);

  if (wantsHunter) {
    steps.push({
      tool: 'freesound_search',
      args: { query: request.slice(0, 200), license: 'cc0', durationMax: 30, numResults: 8 },
      why: 'найти редкий звук со свободной лицензией',
    });
    steps.push({
      tool: 'compose_spec',
      args: { prompt: request.slice(0, 400) },
      why: 'собрать бит вокруг найденного звука',
    });
    steps.push({
      tool: 'compile',
      args: {},
      why: 'скомпилировать спеку в играющий код',
    });
    return {
      mode: 'hunter',
      goal: request.slice(0, 600) || 'Найти редкий звук и собрать бит',
      steps,
    };
  }

  if (wantsResearch) {
    steps.push({
      tool: 'web_search',
      args: { query: request.slice(0, 200) },
      why: 'нужен внешний источник: что это за стиль и как его описывают',
    });
    steps.push({
      tool: 'library_search',
      args: { query: request.slice(0, 80), kind: 'samples', limit: 8 },
      why: 'подобрать звуки из нашей библиотеки под найденное описание',
    });
  }

  if (wantsCompose) {
    steps.push({
      tool: 'compose_spec',
      args: { prompt: request.slice(0, 400) },
      why: 'собрать спеку трека по описанию',
    });
    steps.push({
      tool: 'compile',
      args: {},
      why: 'скомпилировать спеку в играющий код',
    });
  }

  if (wantsDirector && !wantsCompose) {
    steps.push({
      tool: 'library_search',
      args: { query: request.slice(0, 80), kind: 'knowledge', limit: 5 },
      why: 'взять знания о роли и тембре из библиотеки',
    });
    steps.push({
      tool: 'edit_ir',
      args: { transform: 'darker', amount: 0.4 },
      why: 'применить типографированную правку к текущему треку',
    });
  }

  if (!steps.length) {
    steps.push({
      tool: 'library_search',
      args: { query: request.slice(0, 80), kind: 'knowledge', limit: 5 },
      why: 'ответить по нашей библиотеке знаний: что мы знаем по теме запроса',
    });
  }

  const mode = wantsDirector && !wantsCompose ? 'director' : wantsResearch && wantsCompose ? 'composer' : wantsCompose ? 'composer' : wantsResearch ? 'research' : 'chat';

  return {
    mode,
    goal: request.slice(0, 600) || 'Ответить по библиотеке знаний',
    steps,
  };
}

/**
 * Разбор ответа модели в план. Мусор → null (вызывающий берёт эвристику).
 * @param {string} text
 * @returns {{mode:string, goal:string, steps:Array}|null}
 */
export function parsePlan(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  // Модели любят оборачивать JSON в ```json ... ``` — снимаем ограждение.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const check = PlanSchema.safeParse(parsed);
  return check.success ? check.data : null;
}
