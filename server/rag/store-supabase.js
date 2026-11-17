// Supabase/pgvector-хранилище знаний (D-134/D-137). Тот же интерфейс,
// что у LocalKnowledgeStore; ранжирование — косинус в SQL (<=>),
// стадии fallback — те же, что в search-core. Только серверный модуль:
// креды из env, в клиентский бандл не попадает.

import { hybridSearch, FILTER_STAGES } from './search-core.js';
import { normalizeTonic } from './music-check.js';

/** pg отдаёт vector как строку '[0.1,...]' — разбираем в массив. */
function parseVector(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  return JSON.parse(value);
}

function rowToEntry(row) {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    description: row.description,
    strudel_code: row.strudel_code,
    music_tags: row.music_tags,
    cc0_preset_ids: row.cc0_preset_ids,
    rationale: row.rationale,
    source: row.source,
    embedding: parseVector(row.embedding),
  };
}

/** Фильтр стадии для RPC match_knowledge (зеркалит stageFilter). */
export function stageRpcFilter(filters, stage) {
  const f = filters || {};
  const out = {};
  const tonic = f.tonic ? normalizeTonic(f.tonic) : null;
  if (tonic && (stage === 'exact' || stage === 'tonic')) out.tonic = tonic;
  if (stage === 'exact') {
    if (f.mode) out.mode = f.mode;
    if (f.complexity) out.complexity = f.complexity;
    if (f.genre?.length) out.genre = f.genre;
  }
  if (f.roles?.length && stage !== 'all') out.roles = f.roles;
  if (stage === 'genre-roles') {
    if (f.genre?.length) out.genre = f.genre;
    out.matchAny = 'true';
  }
  return out;
}

export class SupabaseKnowledgeStore {
  /** @param {{query: Function}} client pg-клиент (Pool или Client); инъекция для тестов. */
  constructor(client) {
    this.client = client;
  }

  async upsert(entry, embedding = null) {
    await this.client.query(
      `insert into public.knowledge_entries
         (id, version, title, description, strudel_code, music_tags, cc0_preset_ids, rationale, source, embedding, updated_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::vector, now())
       on conflict (id) do update set
         version = excluded.version, title = excluded.title, description = excluded.description,
         strudel_code = excluded.strudel_code, music_tags = excluded.music_tags,
         cc0_preset_ids = excluded.cc0_preset_ids, rationale = excluded.rationale,
         source = excluded.source,
         embedding = coalesce(excluded.embedding, public.knowledge_entries.embedding),
         updated_at = now()`,
      [
        entry.id, entry.version, entry.title, entry.description, entry.strudel_code,
        JSON.stringify(entry.music_tags), JSON.stringify(entry.cc0_preset_ids || []),
        entry.rationale, JSON.stringify(entry.source),
        embedding ? JSON.stringify(embedding) : null,
      ],
    );
  }

  async all() {
    const r = await this.client.query('select * from public.knowledge_entries order by id');
    return r.rows.map(rowToEntry);
  }

  async count() {
    const r = await this.client.query('select count(*)::int as n from public.knowledge_entries');
    return r.rows[0].n;
  }

  async search({ query, queryEmbedding = null, filters = {}, topK = 3, minResults = 3 }) {
    if (!queryEmbedding) {
      // Без эмбеддинга запроса — честная лексика по всем записям.
      return hybridSearch(await this.all(), { query, queryEmbedding: null, filters, topK, minResults });
    }
    const vec = JSON.stringify(queryEmbedding);
    let results = [];
    let stage = 'exact';
    for (const s of FILTER_STAGES) {
      stage = s;
      const r = await this.client.query('select * from public.match_knowledge($1::vector, $2::jsonb, $3)', [
        vec, JSON.stringify(stageRpcFilter(filters, s)), topK,
      ]);
      results = r.rows.map((row) => ({ entry: rowToEntry(row), score: row.similarity }));
      if (results.length >= Math.min(minResults, topK)) break;
    }
    const degraded = stage !== 'exact';
    return {
      results,
      stage,
      semantic: true,
      degraded,
      reason: degraded ? `фильтры ослаблены до стадии «${stage}» (мало точных совпадений)` : null,
    };
  }
}