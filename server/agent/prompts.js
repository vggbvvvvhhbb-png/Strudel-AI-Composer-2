// Промты агента: планировщик и ответчик.
//
// Тон — тот же, что у студии: «каждое число — измерение, а не догадка».
// Модели запрещено выдумывать источники, инструменты и факты: если тулз
// сказал «интернет недоступен», ответ обязан это повторить.

import { plannerInstruction } from './modes.js';
import { toolManifest } from './tools.js';

/**
 * Промт планировщика: модель получает инструменты и возвращает план.
 * @param {{mode:string, prompt:string, tools?:string[], context?:object}} options
 * @returns {Array<{role:string, content:string}>}
 */
export function plannerMessages({ mode, prompt, tools = null, context = {} }) {
  const manifest = toolManifest(tools);
  const toolText = manifest
    .map((tool) => {
      const args = tool.args ? `\n${tool.args}` : '';
      return `### ${tool.id} — ${tool.title}\n${tool.description}${args}`;
    })
    .join('\n\n');

  const contextText = context?.code
    ? `\nТекущий трек в студии (код):\n${String(context.code).slice(0, 1200)}\n`
    : '';

  return [
    {
      role: 'system',
      content: [
        'Ты — планировщик музыкального помощника. Твоя задача — составить ПЛАН действий,',
        'а не отвечать на запрос. Ответ — только JSON, без пояснений.',
        '',
        'AGENT_PLAN_JSON — обязательный маркер формата.',
        '',
        'Формат ответа:',
        '{',
        '  "mode": "chat|research|composer|director",',
        '  "goal": "одно предложение: что нужно получить",',
        '  "steps": [ { "tool": "id_инструмента", "args": { ... }, "why": "зачем этот шаг" } ]',
        '}',
        '',
        'Правила:',
        '- Шаги идут в порядке выполнения; каждый шаг — ровно один инструмент из списка.',
        '- Не вызывай инструмент, который тебе не нужен. Пустой список шагов допустим.',
        '- Аргументы бери из запроса пользователя; выдумывать сэмплы, URL и числа нельзя.',
        '- Если задача решается локальной библиотекой — не нужен интернет.',
        '',
        plannerInstruction(mode),
        '',
        'Доступные инструменты:',
        toolText,
        contextText,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Запрос: ${prompt}`,
    },
  ];
}

/**
 * Промт ответчика: наблюдения → честный ответ.
 * @param {{mode:string, prompt:string, plan:object, observations:Array}} options
 * @returns {Array<{role:string, content:string}>}
 */
export function answerMessages({ mode, prompt, plan, observations }) {
  const observationText = observations.length
    ? observations
      .map((obs) => {
        const lines = [`Инструмент: ${obs.tool}`, `Статус: ${obs.ok ? (obs.degraded ? 'деградация' : 'ок') : 'не сработал'}`];
        if (obs.reason) lines.push(`Причина: ${obs.reason}`);
        if (obs.summary) lines.push(`Данные: ${obs.summary}`);
        return lines.join('\n');
      })
      .join('\n\n')
    : 'Инструменты не вызывались.';

  return [
    {
      role: 'system',
      content: [
        'Ты — помощник-композитор Strudel AI Composer. Отвечай по-русски, коротко и по делу.',
        'AGENT_ANSWER — обязательный маркер формата.',
        '',
        'ЖЁСТКИЕ ПРАВИЛА:',
        '1. Не выдумывай факты, источники, сэмплы и числа — только то, что пришло в наблюдениях.',
        '2. Если инструмент ответил «деградация» или «не сработал» — скажи это прямо в ответе,',
        '   вместе с причиной. Никогда не делай вид, что всё прошло.',
        '3. Если в наблюдениях есть код трека — покажи его целиком в блоке кода.',
        '4. Не предлагай сэмплы, чья лицензия не подтверждена.',
        '5. Без инструментов отвечай кратко и по существу.',
        '',
        `Режим: ${mode}.`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Запрос: ${prompt}`,
        '',
        `План: ${plan.goal}`,
        '',
        'Наблюдения:',
        observationText,
        '',
        'Ответь по этим данным.',
      ].join('\n'),
    },
  ];
}
