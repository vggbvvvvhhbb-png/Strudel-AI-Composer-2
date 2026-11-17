// Фаза D: клиент эмбеддингов — префиксы модели, размерность, честная
// деградация. fetch подменяется, сети нет.

import { describe, it, expect, afterEach } from 'vitest';
import { embedDocuments, embedQuery, EMBED_DIM } from '../../server/rag/embeddings.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => handler(url, opts);
}

const vec = () => Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM);

describe('клиент эмбеддингов', () => {
  it('документы получают префикс search_document, запрос — search_query', async () => {
    const bodies = [];
    mockFetch(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ embeddings: [vec(), vec()] }) };
    });
    await embedDocuments(['первый', 'второй'], { baseUrl: 'http://x' });
    expect(bodies[0].input).toEqual(['search_document: первый', 'search_document: второй']);
    expect(bodies[0].model).toBe('nomic-embed-text');

    mockFetch(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ embeddings: [vec()] }) };
    });
    const q = await embedQuery('джазовый бас', { baseUrl: 'http://x' });
    expect(bodies[1].input).toEqual(['search_query: джазовый бас']);
    expect(q.ok).toBe(true);
    expect(q.embedding).toHaveLength(EMBED_DIM);
  });

  it('неверная размерность — ошибка, а не молчаливый вектор', async () => {
    mockFetch(async () => ({ ok: true, json: async () => ({ embeddings: [Array(1536).fill(0)] }) }));
    const r = await embedDocuments(['текст'], { baseUrl: 'http://x' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('1536');
    expect(r.reason).toContain('768');
  });

  it('недоступная Ollama — ok:false с причиной, не исключение', async () => {
    mockFetch(async () => { throw new Error('ECONNREFUSED'); });
    const r = await embedQuery('текст', { baseUrl: 'http://x' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('недоступны');
  });

  it('HTTP 500 — ok:false с кодом', async () => {
    mockFetch(async () => ({ ok: false, status: 500 }));
    const r = await embedDocuments(['текст'], { baseUrl: 'http://x' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('500');
  });

  it('пустой список — успешный пустой результат без вызова сети', async () => {
    let calls = 0;
    mockFetch(async () => { calls += 1; return { ok: true, json: async () => ({ embeddings: [] }) }; });
    const r = await embedDocuments([], { baseUrl: 'http://x' });
    expect(r.ok).toBe(true);
    expect(r.embeddings).toEqual([]);
    expect(calls).toBe(0);
  });
});