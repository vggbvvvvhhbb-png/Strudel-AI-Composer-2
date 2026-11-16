// Промты агента: планировщик и ответчик.
//
// Тон — тот же, что у студии: «каждое число — измерение, а не догадка».
// Модели запрещено выдумывать источники, инструменты и факты: если тулз
// сказал «интернет недоступен», ответ обязан это повторить.

import { plannerInstruction } from './modes.js';
import { toolManifest } from './tools.js';

/**
 * Текст предыдущих реплик — компактным блоком, а не отдельными сообщениями:
 * планировщику нужен контекст, а не право переписывать прошлые реплики.
 * @param {Array<{role:string, content:string}>} history
 * @returns {string}
 */
function historyText(history = []) {
  const turns = history.slice(-6).map((turn) => {
    const who = turn.role === 'assistant' ? 'помощник' : 'пользователь';
    const text = String(turn.content ?? '').trim().replace(/\s+/g, ' ');
    return text ? `- ${who}: ${text.slice(0, 400)}` : null;
  }).filter(Boolean);
  if (!turns.length) return '';
  return `\nПредыдущие реплики (контекст, не новый запрос):\n${turns.join('\n')}\n`;
}

/**
 * Промт нативного режима: модель сама вызывает инструменты.
 *
 * Здесь НЕТ списка инструментов и НЕТ требования вернуть JSON: инструменты
 * передаются провайдеру отдельным полем `tools`, и модель получает их как
 * настоящие вызовы. Поэтому промт короткий: что можно и чего нельзя.
 *
 * @param {{mode:string, prompt:string, history?:Array, context?:object}} options
 * @returns {Array<{role:string, content:string}>}
 */
export function nativeMessages({ mode, prompt, history = [], context = {} }) {
  const instruction = plannerInstruction(mode);
  const contextText = context?.code
    ? `\nТекущий трек в студии (код):\n${String(context.code).slice(0, 1200)}\n`
    : '';

  const system = [
    'Ты — помощник-композитор Strudel AI Composer. У тебя есть инструменты:',
    'вызывай их, когда нужен факт из библиотеки, интернета или действие над треком.',
    'Не вызывай инструмент, если ответ можно дать без него.',
    '',
    'ПРАВИЛА:',
    '1. Аргументы бери из запроса пользователя. Не выдумывай сэмплы, URL и числа.',
    '2. Инструмент вернул ошибку — скажи это прямо в ответе, вместе с причиной.',
    '3. Результат инструмента — это факты, а не текст для пересказа: опирайся на них.',
    '4. Код трека, если он появился, покажи целиком в блоке кода.',
    '5. Собери трек, когда его просят: сначала спека (compose_spec), потом код (compile).',
    '   Спеку компиляции передавать не нужно — сервер подставит её сам.',
    '6. Слушай прошлые реплики: запрос может продолжать прошлый разговор.',
    '7. Использовал web_search или web_fetch — приведи в ответе ссылки (URL) на источники,',
    '   на которые опираешься. Только те, что реально вернули инструменты.',
    '',
    instruction,
    contextText,
  ].join('\n');

  return [
    { role: 'system', content: system },
    ...history.slice(-8).map((turn) => ({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: String(turn.content ?? '').slice(0, 1200),
    })),
    { role: 'user', content: `Запрос: ${prompt}` },
  ];
}

/**
 * Промт планировщика: модель получает инструменты и возвращает план.
 * @param {{mode:string, prompt:string, tools?:string[], context?:object, history?:Array}} options
 * @returns {Array<{role:string, content:string}>}
 */
export function plannerMessages({ mode, prompt, tools = null, context = {}, history = [] }) {
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
        '  "mode": "chat|research|composer|director|hunter",',
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
        historyText(history),
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
 * @param {{mode:string, prompt:string, plan:object, observations:Array, history?:Array}} options
 * @returns {Array<{role:string, content:string}>}
 */
export function answerMessages({ mode, prompt, plan, observations, history = [] }) {
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
        '6. Учитывай предыдущие реплики: запрос может продолжить прошлый разговор.',
        '7. Если в наблюдениях есть URL источников (web_search/web_fetch) — приведи их в ответе.',
        '',
        `Режим: ${mode}.`,
      ].join('\n'),
    },
    // Прошлые реплики идут отдельными сообщениями: так ответчик видит их
    // именно как разговор, а не как текст внутри текущего запроса.
    ...history.slice(-8).map((turn) => ({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: String(turn.content ?? '').slice(0, 1200),
    })),
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
