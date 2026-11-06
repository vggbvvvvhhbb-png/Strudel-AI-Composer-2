import { config } from '../config.js';

const TIMEOUT_MS = 60_000;

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

// Генератор SSE-дельт OpenAI-совместимого API.
// Бросает исключение с сообщением апстрима (текст ошибки обрезан, ключи в нём не публикуем).
export async function* streamChat({ messages, temperature = 0.8, signal } = {}) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify(payload(null, messages, temperature, true)),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`LLM ${res.status}: ${detail || res.statusText}`);
  }

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
        // частичный JSON-фрагмент — ждём продолжение строки
      }
    }
  }
}

// Нестримовый вызов — для автофикса.
export async function completeChat({ messages, temperature = 0.2, signal } = {}) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify(payload(null, messages, temperature, false)),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`LLM ${res.status}: ${detail || res.statusText}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM вернул пустой ответ');
  }
  return content;
}
