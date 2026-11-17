// Фаза D: локальное и Supabase-хранилище знаний. Supabase тестируется
// с mock-клиентом (без сети): проверяем SQL-контракт и стадии fallback.

import { describe, it, expect } from 'vitest';
import { LocalKnowledgeStore } from '../../server/rag/store-local.js';
import { SupabaseKnowledgeStore, stageRpcFilter } from '../../server/rag/store-supabase.js';
import { loadDataset } from '../../server/rag/dataset.js';

const { entries } = loadDataset();

describe('локальное хранилище', () => {
  it('upsert идемпотентен по id, all детерминированно отсортирован', async () => {
    const store = new LocalKnowledgeStore();
    await store.upsert(entries[0]);
    await store.upsert({ ...entries[0], title: 'обновлено' });
    expect(await store.count()).toBe(1);
    const all = await store.all();
    expect(all[0].title).toBe('обновлено');
  });

  it('поиск по датасету без эмбеддингов: лексика, честная деградация', async () => {
    const store = new LocalKnowledgeStore(entries);
    const r = await store.search({ query: 'джазовый ii V I пианино', filters: { genre: ['jazz'] }, topK: 3 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.semantic).toBe(false);
    expect(r.reason).toContain('лексическое');
    expect(r.results[0].entry.music_tags.genre).toContain('jazz');
  });

  it('поиск с эмбеддингом запроса ранжирует по косинусу', async () => {
    const store = new LocalKnowledgeStore();
    await store.upsert({ ...entries[0], id: 'x-near' }, [1, 0]);
    await store.upsert({ ...entries[1], id: 'x-far' }, [0, 1]);
    const r = await store.search({ query: 'что угодно', queryEmbedding: [0.9, 0.1], topK: 2 });
    expect(r.semantic).toBe(true);
    expect(r.results[0].entry.id).toBe('x-near');
  });
});

describe('Supabase-хранилище (mock-клиент)', () => {
  function mockClient(handler) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        return handler(sql, params, calls.length);
      },
    };
  }

  it('upsert шлёт 10 параметров и ON CONFLICT по id', async () => {
    const client = mockClient(() => ({ rows: [] }));
    const store = new SupabaseKnowledgeStore(client);
    await store.upsert(entries[0], [0.1, 0.2]);
    const { sql, params } = client.calls[0];
    expect(sql).toContain('on conflict (id) do update');
    expect(sql).toContain('$10::vector');
    expect(params).toHaveLength(10);
    expect(params[0]).toBe(entries[0].id);
    expect(params[9]).toBe('[0.1,0.2]');
  });

  it('embedding=null не затирает существующий (coalesce)', async () => {
    const client = mockClient(() => ({ rows: [] }));
    await new SupabaseKnowledgeStore(client).upsert(entries[0], null);
    expect(client.calls[0].sql).toContain('coalesce(excluded.embedding');
    expect(client.calls[0].params[9]).toBeNull();
  });

  it('stageRpcFilter зеркалит стадии search-core', () => {
    const f = { tonic: 'f#', mode: 'minor', genre: ['jazz'], roles: ['chords'], complexity: 'basic' };
    expect(stageRpcFilter(f, 'exact')).toEqual({ tonic: 'gb', mode: 'minor', complexity: 'basic', genre: ['jazz'], roles: ['chords'] });
    expect(stageRpcFilter(f, 'tonic')).toEqual({ tonic: 'gb', roles: ['chords'] });
    expect(stageRpcFilter(f, 'genre-roles')).toEqual({ genre: ['jazz'], roles: ['chords'], matchAny: 'true' });
    expect(stageRpcFilter(f, 'all')).toEqual({});
  });

  it('search с эмбеддингом: стадии идут по порядку, остановка на достаточной выдаче', async () => {
    const row = (id, sim) => ({
      id, version: 1, title: id, description: id, strudel_code: '$X: s("bd")',
      music_tags: { genre: ['lofi'], tonic: 'a', mode: 'minor', roles: ['chords'], complexity: 'basic', bpm: 80 },
      cc0_preset_ids: [], rationale: id, source: { origin: 'own', license: 'CC0-1.0' },
      embedding: '[0.1,0.2]', similarity: sim,
    });
    const client = mockClient((sql, params, n) => {
      if (n === 1) return { rows: [row('only-one', 0.9)] };        // exact: мало
      return { rows: [row('r1', 0.8), row('r2', 0.7), row('r3', 0.6)] }; // tonic: хватает
    });
    const store = new SupabaseKnowledgeStore(client);
    const r = await store.search({ query: 'аккорды', queryEmbedding: [0.1, 0.2], filters: { tonic: 'a', mode: 'minor' }, topK: 3 });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].sql).toContain('match_knowledge');
    expect(JSON.parse(client.calls[0].params[1])).toEqual({ tonic: 'a', mode: 'minor' });
    expect(JSON.parse(client.calls[1].params[1])).toEqual({ tonic: 'a' });
    expect(r.stage).toBe('tonic');
    expect(r.degraded).toBe(true);
    expect(r.results[0].score).toBe(0.8);
    expect(r.results[0].entry.embedding).toEqual([0.1, 0.2]);
  });

  it('search без эмбеддинга: лексика по всем записям, без RPC', async () => {
    const client = mockClient(() => ({
      rows: entries.slice(0, 5).map((e) => ({ ...e, embedding: null })),
    }));
    const store = new SupabaseKnowledgeStore(client);
    const r = await store.search({ query: 'джаз', filters: {}, topK: 3 });
    expect(client.calls[0].sql).toContain('select * from public.knowledge_entries');
    expect(r.semantic).toBe(false);
  });
});