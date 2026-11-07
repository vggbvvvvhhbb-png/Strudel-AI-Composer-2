import { config } from '../config.js';

const TIMEOUT_MS = 120_000;

function endpoint() {
  return `${config.openaiBaseUrl}/chat/completions`;
}

function payload(model, messages, temperature, stream) {
  return {
    model: model || config.openaiModel,
    messages,
    temperature,
    ...(stream ? { stream: true } : {}),
  };
}

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.openaiApiKey}`,
  };
}

// Модели для перебора: основная, затем резервная (если задана и отличается).
function modelChain() {
  const list = [config.openaiModel];
  if (config.openaiFallbackModel && !list.includes(config.openaiFallbackModel)) {
    list.push(config.openaiFallbackModel);
  }
  return list;
}

// Текст ошибки апстрима: обрезан и без ключей — наружу уходит только диагностика.
async function upstreamError(res) {
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  return `LLM ${res.status}: ${detail || res.statusText}`;
}

// Один запрос к апстриму. Бросает исключение с текстом ошибки.
// stream = true — отдаёт SSE-дельты, иначе полный текст ответа.
async function request({ messages, temperature, stream, model, signal }) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload(model, messages, temperature, stream)),
    signal: combined,
  });
  if (!res.ok) throw new Error(await upstreamError(res));
  return res;
}

// Разбор SSE-потока OpenAI-совместимого API: отдаёт дельты по мере прихода.
// Один прогон по всем моделям: если основная недоступна, берём резервную.
export async function* streamChat({ messages, temperature = 0.8, signal } = {}) {
  let lastError = null;
  for (const model of modelChain()) {
    if (signal?.aborted) return;
    try {
      const res = await request({ messages, temperature, stream: true, model, signal });
      if (!res.body) throw new Error('LLM вернул пустой поток');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let produced = false;

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
            if (delta) {
              produced = true;
              yield delta;
            }
          } catch {
            // частичный JSON-фрагмент — ждём продолжения строки
          }
        }
      }
      if (produced) return;
      lastError = new Error('LLM вернул пустой ответ');
    } catch (err) {
      if (signal?.aborted) return;
      lastError = err;
      console.error(`[llm] модель ${model} недоступна: ${err.message}`);
    }
  }
  throw lastError || new Error('LLM недоступен');
}

// Нестримовый вызов — для автофикса и улучшения.
export async function completeChat({ messages, temperature = 0.2, signal } = {}) {
  let lastError = null;
  for (const model of modelChain()) {
    if (signal?.aborted) throw new Error('Запрос отменён');
    try {
      const res = await request({ messages, temperature, stream: false, model, signal });
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('LLM вернул пустой ответ');
      return content;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      console.error(`[llm] модель ${model} недоступна: ${err.message}`);
    }
  }
  throw lastError || new Error('LLM недоступен');
}
