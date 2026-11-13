// Роутер LLM: несколько провайдеров, один интерфейс.
//
// Поддерживаются OpenAI-совместимые endpoints (OpenAI, Groq, Ollama, LM Studio,
// любой прокси с /v1/chat/completions) и Anthropic Messages API. Провайдеры
// перебираются по порядку из LLM_PROVIDERS: недоступный провайдер не роняет
// запрос, а просто передаёт его следующему.

import { config } from '../config.js';
import { mockCompletion, mockStream } from './mock.js';

const TIMEOUT_MS = 120_000;

// Мок-режим: ни сети, ни ключей. Ответ детерминированный, но проходит те же
// схемы, что и настоящий ответ модели. Включается MOCK_LLM=1 (CI, smoke).
const MOCK_LLM = process.env.MOCK_LLM === '1';

/**
 * Кандидаты для запроса: провайдер + конкретная модель.
 * У OpenAI дополнительно идёт резервная модель — она дешевле и стабильнее.
 */
export function providerChain() {
  const chain = [];
  for (const id of config.llmProviders) {
    if (id === 'openai' && config.openaiApiKey) {
      chain.push({
        id: 'openai',
        type: 'openai',
        baseUrl: config.openaiBaseUrl,
        model: config.openaiModel,
        apiKey: config.openaiApiKey,
      });
      if (config.openaiFallbackModel && config.openaiFallbackModel !== config.openaiModel) {
        chain.push({
          id: 'openai-fallback',
          type: 'openai',
          baseUrl: config.openaiBaseUrl,
          model: config.openaiFallbackModel,
          apiKey: config.openaiApiKey,
        });
      }
    }
    if (id === 'groq' && config.groqApiKey) {
      chain.push({
        id: 'groq',
        type: 'openai',
        baseUrl: config.groqBaseUrl,
        model: config.groqModel,
        apiKey: config.groqApiKey,
      });
    }
    if (id === 'ollama' && config.ollamaModel) {
      chain.push({
        id: 'ollama',
        type: 'openai',
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        apiKey: null,
      });
    }
    if (id === 'anthropic' && config.anthropicApiKey) {
      chain.push({
        id: 'anthropic',
        type: 'anthropic',
        baseUrl: config.anthropicBaseUrl,
        model: config.anthropicModel,
        apiKey: config.anthropicApiKey,
      });
    }
  }
  return chain;
}

// Текст ошибки апстрима: обрезан и без ключей — наружу уходит только диагностика.
async function upstreamError(res) {
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  return `HTTP ${res.status}: ${detail || res.statusText}`;
}

function timeoutSignal(signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// У Anthropia системный промпт — отдельным полем, а не сообщением.
function splitSystem(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  return { system, rest };
}

async function openaiRequest({ provider, messages, temperature, stream, signal, maxTokens, responseFormat }) {
  const body = {
    model: provider.model,
    messages,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    // Структурированный вывод: провайдер сам гарантирует, что ответ — JSON
    // по схеме. Поддерживают не все: если провайдер ответит ошибкой,
    // запрос повторяется без response_format (см. completeChat).
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: timeoutSignal(signal),
  });
  if (!res.ok) throw new Error(`провайдер ${provider.id}: ${await upstreamError(res)}`);
  return res;
}

async function anthropicRequest({ provider, messages, temperature, stream, signal, maxTokens }) {
  const { system, rest } = splitSystem(messages);
  const body = {
    model: provider.model,
    max_tokens: maxTokens || 4096,
    temperature,
    messages: rest,
    ...(system ? { system } : {}),
    ...(stream ? { stream: true } : {}),
  };  const res = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: timeoutSignal(signal),
  });
  if (!res.ok) throw new Error(`провайдер ${provider.id}: ${await upstreamError(res)}`);
  return res;
}

async function request(args) {
  return args.provider.type === 'anthropic'
    ? anthropicRequest(args)
    : openaiRequest(args);
}

// Разбор SSE-потока OpenAI-совместимого API.
async function* readOpenAiStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // частичный JSON-фрагмент — ждём продолжения строки
      }
    }
  }
}

// Разбор SSE-потока Anthropic: события content_block_delta с delta.text.
async function* readAnthropicStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const text = json.delta?.text;
        if (text) yield text;
      } catch {
        // частичный JSON-фрагмент
      }
    }
  }
}

/**
 * Стриминг ответа: перебирает провайдеров, пока кто-нибудь не ответит.
 * @param {{messages:Array, temperature?:number, signal?:AbortSignal, providerId?:string}} options
 */
export async function* streamChat({ messages, temperature = 0.8, signal, providerId, maxTokens } = {}) {
  if (MOCK_LLM) {
    yield* mockStream({ messages, responseFormat: null });
    return;
  }
  let lastError = null;
  const chain = providerChain().filter((p) => !providerId || p.id === providerId);
  if (!chain.length) throw new Error('Нет доступных провайдеров LLM');

  for (const provider of chain) {
    if (signal?.aborted) return;
    let produced = false;
    try {
      const res = await request({ provider, messages, temperature, stream: true, signal, maxTokens });
      if (!res.body) throw new Error('пустой поток');
      const source = provider.type === 'anthropic' ? readAnthropicStream(res) : readOpenAiStream(res);
      for await (const delta of source) {
        if (signal?.aborted) return;
        produced = true;
        yield delta;
      }
      if (produced) return;
      lastError = new Error('провайдер вернул пустой ответ');
    } catch (err) {
      if (signal?.aborted) return;
      lastError = err;
      console.error(`[llm] провайдер ${provider.id} недоступен: ${err.message}`);
    }
  }
  throw lastError || new Error('LLM недоступен');
}

/**
 * Нестримовый вызов: один ответ целиком. Используется для автофикса,
 * улучшения и генерации вариантов.
 *
 * `responseFormat` — структурированный вывод (`{type:'json_schema', ...}`).
 * Anthropic его не поддерживает, поэтому там формат задаётся промптом.
 * Если провайдер отвергает `response_format` (не все модели и не все
 * провайдеры его умеют), запрос повторяется без него — ответ придёт
 * обычным текстом, а разбор JSON сделает вызывающий код.
 *
 * @returns {Promise<string>}
 */
export async function completeChat({
  messages,
  temperature = 0.2,
  signal,
  providerId,
  maxTokens,
  onUsage,
  responseFormat,
} = {}) {
  if (MOCK_LLM) {
    return mockCompletion({ messages, responseFormat });
  }
  let lastError = null;
  const chain = providerChain().filter((p) => !providerId || p.id === providerId);
  if (!chain.length) throw new Error('Нет доступных провайдеров LLM');

  for (const provider of chain) {
    if (signal?.aborted) throw new Error('Запрос отменён');
    // Структурированный вывод есть только у OpenAI-совместимых провайдеров.
    const wantsFormat = Boolean(responseFormat) && provider.type !== 'anthropic';
    let attempts = wantsFormat ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const useFormat = wantsFormat && attempt === 0;
      try {
        const res = await request({
          provider,
          messages,
          temperature,
          stream: false,
          signal,
          maxTokens,
          ...(useFormat ? { responseFormat } : {}),
        });
        const json = await res.json();
        let content = null;
        if (provider.type === 'anthropic') {
          content = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        } else {
          content = json.choices?.[0]?.message?.content;
        }
        if (typeof content !== 'string' || !content.trim()) throw new Error('провайдер вернул пустой ответ');
        if (json.usage && typeof onUsage === 'function') {
          onUsage({ provider: provider.id, model: provider.model, ...json.usage });
        }
        return content;
      } catch (err) {
        if (signal?.aborted) throw err;
        // Провайдер не понял response_format — пробуем без него.
        if (useFormat && isFormatUnsupported(err)) {
          console.error(
            `[llm] провайдер ${provider.id} не поддерживает response_format — повтор без него`,
          );
          continue;
        }
        lastError = err;
        console.error(`[llm] провайдер ${provider.id} недоступен: ${err.message}`);
        break;
      }
    }
  }
  throw lastError || new Error('LLM недоступен');
}

// Провайдер отверг именно формат ответа (а не сам запрос) — тогда есть смысл
// повторить без него. Остальные ошибки (ключ, лимит, сеть) не лечатся повтором.
function isFormatUnsupported(err) {
  const text = String(err?.message || '');
  return /response_format|json_schema|schema/i.test(text);
}
