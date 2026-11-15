// Нормализация usage провайдеров.
//
// Формат usage разный:
//   • OpenAI-совместимые (OpenAI, Groq, APInex): {prompt_tokens, completion_tokens}
//   • Anthropic Messages: {input_tokens, output_tokens}
//
// Счётчик Anthropic приходит двумя событиями (message_start и message_delta),
// поэтому при слиянии берётся МАКСИМУМ, а не сумма: иначе одно и то же
// значение посчитается дважды. (Правило из донорского контура, см. §8.1
// промта-гайда.)

/**
 * Привести usage провайдера к общему виду.
 * @param {object} raw usage как прислал провайдер
 * @returns {{promptTokens:number, completionTokens:number}}
 */
export function parseProviderUsage(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    promptTokens: toInt(source.prompt_tokens ?? source.promptTokens ?? source.input_tokens ?? source.inputTokens),
    completionTokens: toInt(
      source.completion_tokens ?? source.completionTokens ?? source.output_tokens ?? source.outputTokens,
    ),
  };
}

/**
 * Слить два usage. Берётся максимум по каждому полю: счётчик одного и того
 * же ответа может прийти двумя событиями.
 * @param {object} a
 * @param {object} b
 * @returns {{promptTokens:number, completionTokens:number}}
 */
export function mergeUsage(a, b) {
  const left = parseProviderUsage(a);
  const right = parseProviderUsage(b);
  return {
    promptTokens: Math.max(left.promptTokens, right.promptTokens),
    completionTokens: Math.max(left.completionTokens, right.completionTokens),
  };
}

/**
 * Оценка по длине текста, когда провайдер usage не прислал.
 *
 * Грубая: примерно 4 символа на токен для русского/английского текста.
 * Помечается как оценка, чтобы её нельзя было спутать с измеренной.
 * @param {string} text ответ модели
 * @param {string} [promptText] запрос (в JSON-виде)
 * @returns {{promptTokens:number, completionTokens:number}}
 */
export function estimateUsage(text, promptText = '') {
  return {
    promptTokens: Math.ceil(String(promptText || '').length / 4),
    completionTokens: Math.ceil(String(text || '').length / 4),
  };
}

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}
