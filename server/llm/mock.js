// Мок-LLM для CI и smoke-тестов.
//
// Нужен, чтобы Playwright-smoke и тесты ассистента работали без сети и без
// ключей: маршруты получают детерминированный валидный ответ вместо ответа
// провайдера. Включается переменной окружения MOCK_LLM=1.
//
// Мок НЕ подменяет проверку кода: ответ проходит те же схемы и валидаторы,
// что и настоящий ответ модели.

import { fallbackSpec } from '../music/compose/pipeline.js';
import { planIR } from '../../src/ir/intent.js';
import { heuristicPlan } from '../agent/navigator.js';

const STYLES = ['lo-fi', 'techno', 'house', 'ambient', 'dubstep', 'synthwave', 'trap', 'jazz', 'rock', 'cinematic'];

/** Стиль из текста запроса — иначе дефолтный. */
function detectStyle(text) {
  const lower = String(text || '').toLowerCase();
  for (const style of STYLES) {
    if (lower.includes(style)) return style;
  }
  return 'techno';
}

/**
 * Ответ мока.
 * @param {{messages:Array, responseFormat?:object}} options
 * @returns {string}
 */
export function mockCompletion({ messages = [], responseFormat } = {}) {
  const text = messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n');
  const style = /Стиль запроса:\s*([a-z-]+)\./.exec(text)?.[1]
    || detectStyle(extractUserText(messages));

  // Запрос плана агента (маркер из server/agent/prompts.js): отдаём настоящий
  // валидный план, собранный теми же правилами, что и запасной план. Иначе CI
  // проверял бы только ветку «модель не ответила» — то есть не проверял бы
  // разбор плана вовсе.
  if (text.includes('AGENT_PLAN_JSON')) {
    return JSON.stringify(heuristicPlan(extractUserText(messages)));
  }

  // Ответ агента: перечисляем инструменты и их статусы из блока наблюдений.
  if (text.includes('AGENT_ANSWER')) {
    return mockAgentAnswer(text);
  }

  // Запрос Composition IR (маркер ставит server/ir/planner.js): мок отдаёт
  // настоящий валидный IR, собранный правилами, — иначе CI проверял бы
  // только ветку отказа. Маркер не импортируется отсюда, чтобы мок не тянул
  // зависимость на планировщик.
  if (text.includes('COMPOSITION_IR_JSON')) {
    const prompt = extractIrPrompt(messages);
    return JSON.stringify(planIR(prompt, { seed: 1 }));
  }

  // Структурированный запрос — отдаём валидную спеку (её же умеет собирать
  // конвейер композиции: fallbackSpec проходит те же проверки, что и ответ модели).
  if (responseFormat?.type === 'json_object' || /json/i.test(text.slice(0, 2000))) {
    return JSON.stringify(fallbackSpec(style, 1));
  }

  // Образованный ассистент базы знаний (server/rag/prompt.js): отдаём
  // обоснование + fenced-блок, чтобы мок проходил полный путь парсера
  // и валидатора, а не только ветку голого кода.
  if (text.includes('музыкально образованный ассистент')) {
    return [
      'Тоника c:minor с минорной терцией и квинтой: устойчивое трезвучие, бас двигается ступенями 0–2–4 внутри лада.',
      '```strudel',
      `setCpm(${style === 'techno' ? 128 : 100}/4)`,
      'const key = "c:minor"',
      '$KICK: s("bd*4")._scope()',
      '$BASS: n("0 ~ 2 4").scale(key).s("sawtooth")._pianoroll()',
      '```',
    ].join('\n');
  }

  // Свободный режим — простейший валидный Strudel-код.
  return [
    `setCpm(${style === 'techno' ? 128 : 100}/4)`,
    'const key = "c:minor"',
    '$KICK: s("bd*4")._scope()',
    '$BASS: n("0 ~ 2 4").scale(key).s("sawtooth")._pianoroll()',
  ].join('\n');
}

/**
 * Достаёт текст запроса из сообщений планировщика: строка «Запрос: …».
 * @param {Array<{role:string, content:string}>} messages
 * @returns {string}
 */
function extractIrPrompt(messages) {
  const user = messages.filter((message) => message.role === 'user').pop();
  const content = typeof user?.content === 'string' ? user.content : '';
  const match = /Запрос:\s*(.+)/.exec(content);
  return match ? match[1].trim() : content.trim();
}

/**
 * Текст последнего сообщения пользователя — для агента.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {string}
 */
function extractUserText(messages) {
  const user = messages.filter((message) => message.role === 'user').pop();
  return typeof user?.content === 'string' ? user.content : '';
}

/**
 * Мок-ответ агента: перечисляет инструменты и их статусы из наблюдений.
 * Содержание выдуманным не назовёшь — оно собрано из того, что агент реально
 * вызвал, поэтому в тестах и в CI видно, какие инструменты сработали.
 * @param {string} text весь текст запроса
 * @returns {string}
 */
function mockAgentAnswer(text) {
  const block = /Наблюдения:\n([\s\S]*?)\n\n/.exec(text);
  if (!block) return 'Мок-ответ: наблюдений не было.';
  const lines = block[1]
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const parts = lines.map((chunk) => {
    const tool = /Инструмент:\s*(\S+)/.exec(chunk)?.[1] ?? 'инструмент';
    const status = /Статус:\s*([^\n]+)/.exec(chunk)?.[1] ?? 'неизвестно';
    const reason = /Причина:\s*([^\n]+)/.exec(chunk)?.[1] ?? null;
    return `- ${tool}: ${status}${reason ? ` (${reason})` : ''}`;
  });
  return ['Мок-ответ агента (ключи и сеть не использовались):', ...parts].join('\n');
}

/** Стриминговый мок: отдаём ответ кусками по словам. */
export async function* mockStream(options) {
  const content = mockCompletion(options);
  for (const piece of content.match(/.{1,24}/gs) || []) {
    yield piece;
  }
}
