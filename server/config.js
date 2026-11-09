import 'dotenv/config';

// Чтение и проверка окружения. Значения никогда не логируются — только имена переменных.
function optional(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function list(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3001),
  // Слушаем только localhost: наружу сервер отдаёт nginx.
  host: '127.0.0.1',

  // Порядок перебора провайдеров LLM. Каждый следующий — резервный:
  // если предыдущий недоступен или вернул пустой ответ, берём следующего.
  llmProviders: list('LLM_PROVIDERS').length ? list('LLM_PROVIDERS') : ['openai'],

  // OpenAI и любой OpenAI-совместимый прокси.
  openaiApiKey: optional('OPENAI_API_KEY'),
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  openaiModel: (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
  openaiFallbackModel: optional('OPENAI_FALLBACK_MODEL'),

  // Groq: быстрые инференсы, часто используется как дешёвый критик.
  groqApiKey: optional('GROQ_API_KEY'),
  groqBaseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
  groqModel: (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim(),

  // Ollama: локальный инференс без интернета и без оплаты.
  ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
  ollamaModel: optional('OLLAMA_MODEL'),

  // Anthropic: Messages API, другой формат — роутер умеет и его.
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  anthropicModel: (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5').trim(),

  // Голосовой ввод — необязательный модуль: без ключа сервер работает,
  // а /api/transcribe отвечает 503 с понятным сообщением.
  groqTranscribeModel: (process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo').trim(),
};

/**
 * Есть ли хоть один пригодный провайдер. Без этого сервер бессмысленно
 * принимает запросы и падает на каждом из них — лучше не стартовать.
 */
export function hasAnyProvider() {
  return providerIds().length > 0;
}

// Список id провайдеров, у которых есть всё необходимое для запроса.
export function providerIds() {
  const ids = [];
  for (const id of config.llmProviders) {
    if (id === 'openai' && config.openaiApiKey) ids.push(id);
    if (id === 'groq' && config.groqApiKey) ids.push(id);
    if (id === 'ollama' && config.ollamaModel) ids.push(id);
    if (id === 'anthropic' && config.anthropicApiKey) ids.push(id);
  }
  return ids;
}
