// Мок-LLM для CI и smoke-тестов.
//
// Нужен, чтобы Playwright-smoke и тесты ассистента работали без сети и без
// ключей: маршруты получают детерминированный валидный ответ вместо ответа
// провайдера. Включается переменной окружения MOCK_LLM=1.
//
// Мок НЕ подменяет проверку кода: ответ проходит те же схемы и валидаторы,
// что и настоящий ответ модели.

import { fallbackSpec } from '../music/compose/pipeline.js';

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
  const style = detectStyle(text);

  // Структурированный запрос — отдаём валидную спеку (её же умеет собирать
  // конвейер композиции: fallbackSpec проходит те же проверки, что и ответ модели).
  if (responseFormat?.type === 'json_object' || /json/i.test(text.slice(0, 2000))) {
    return JSON.stringify(fallbackSpec(style, 1));
  }

  // Свободный режим — простейший валидный Strudel-код.
  return [
    `setCpm(${style === 'techno' ? 128 : 100}/4)`,
    'const key = "c:minor"',
    '$KICK: s("bd*4")._scope()',
    '$BASS: n("0 ~ 2 4").scale(key).s("sawtooth")._pianoroll()',
  ].join('\n');
}

/** Стриминговый мок: отдаём ответ кусками по словам. */
export async function* mockStream(options) {
  const content = mockCompletion(options);
  for (const piece of content.match(/.{1,24}/gs) || []) {
    yield piece;
  }
}
