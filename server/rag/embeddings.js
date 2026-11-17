// Клиент эмбеддингов (D-134): локальная Ollama, nomic-embed-text, 768.
// Префиксы search_document:/search_query: обязательны по карточке модели.
// Честная деградация: нет Ollama → {ok:false, reason}, не падение и не
// подмена семантики детерминированным хешем (инвариант 10).

// OLLAMA_BASE_URL в проекте может быть OpenAI-совместимым (/v1) — для
// нативного /api/embed срезаем суффикс; отдельный OLLAMA_EMBED_URL приоритетнее.
const DEFAULT_BASE = process.env.OLLAMA_EMBED_URL
  || (process.env.OLLAMA_BASE_URL || '').replace(/\/v1\/?$/, '')
  || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
export const EMBED_DIM = 768;

async function embed(texts, prefix, { baseUrl = DEFAULT_BASE, model = DEFAULT_MODEL, timeoutMs = 30000 } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return { ok: true, embeddings: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts.map((t) => `${prefix}: ${t}`) }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `Ollama ответила ${res.status}` };
    const json = await res.json();
    const embeddings = json.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      return { ok: false, reason: 'Ollama вернула неожиданное число эмбеддингов' };
    }
    for (const e of embeddings) {
      if (!Array.isArray(e) || e.length !== EMBED_DIM) {
        return { ok: false, reason: `размерность ${e?.length} ≠ ${EMBED_DIM} (смена модели требует миграции)` };
      }
    }
    return { ok: true, embeddings };
  } catch (err) {
    return { ok: false, reason: `эмбеддинги недоступны: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Эмбеддинги документов базы знаний (префикс search_document). */
export function embedDocuments(texts, opts) {
  return embed(texts, 'search_document', opts);
}

/** Эмбеддинг поискового запроса (префикс search_query). */
export async function embedQuery(text, opts) {
  const r = await embed([text], 'search_query', opts);
  if (!r.ok) return r;
  return { ok: true, embedding: r.embeddings[0] };
}

/** Доступность сервиса без вызова модели. */
export async function embeddingsAvailable({ baseUrl = DEFAULT_BASE, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}