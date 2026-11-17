// Зонд гибридного поиска базы знаний: 5 фиксированных запросов,
// локальное хранилище и Supabase/pgvector, с эмбеддингами и без.
// Запуск: node scripts/rag-search-probe.mjs [--local-only]
// Evidence: docs/evidence/rag/search-probe.json

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../server/rag/dataset.js';
import { embedQuery, embeddingsAvailable } from '../server/rag/embeddings.js';
import { LocalKnowledgeStore } from '../server/rag/store-local.js';
import { SupabaseKnowledgeStore } from '../server/rag/store-supabase.js';
import { withClient } from '../server/rag/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(here, '../docs/evidence/rag/search-probe.json');
const localOnly = process.argv.includes('--local-only');

const QUERIES = [
  { query: 'тёплые джазовые аккорды пианино для lofi', filters: { genre: ['lofi'], roles: ['chords'] } },
  { query: 'кислотный бас для техно', filters: { genre: ['techno'], roles: ['bass'] } },
  { query: 'эпические струны для кино', filters: { genre: ['cinematic'] } },
  { query: 'трэповые хэты с роллами', filters: { genre: ['trap'], roles: ['hats'] } },
  { query: 'светлый эмбиент пэд', filters: { roles: ['pad'] } },
];

const { entries } = loadDataset();
const local = new LocalKnowledgeStore(entries);
const available = await embeddingsAvailable();
console.log(`Ollama: ${available ? 'доступна' : 'НЕДОСТУПНА (лексический режим)'}`);

const report = { date: new Date().toISOString(), ollamaAvailable: available, queries: [] };

for (const { query, filters } of QUERIES) {
  const emb = available ? await embedQuery(query) : { ok: false };
  const queryEmbedding = emb.ok ? emb.embedding : null;
  const item = { query, filters, semantic: Boolean(queryEmbedding), local: null, supabase: null };

  const lr = await local.search({ query, queryEmbedding, filters, topK: 3 });
  item.local = {
    stage: lr.stage, degraded: lr.degraded, reason: lr.reason,
    top: lr.results.map((r) => ({ id: r.entry.id, score: Number(r.score.toFixed(4)) })),
  };

  if (!localOnly) {
    await withClient(async (client) => {
      const store = new SupabaseKnowledgeStore(client);
      const sr = await store.search({ query, queryEmbedding, filters, topK: 3 });
      item.supabase = {
        stage: sr.stage, degraded: sr.degraded, reason: sr.reason,
        top: sr.results.map((r) => ({ id: r.entry.id, score: Number(r.score.toFixed(4)) })),
      };
    });
  }
  report.queries.push(item);
  console.log(`\n«${query}»`);
  console.log(`  local:    ${item.local.top.map((t) => `${t.id} (${t.score})`).join(', ')} [${item.local.stage}]`);
  if (item.supabase) {
    console.log(`  supabase: ${item.supabase.top.map((t) => `${t.id} (${t.score})`).join(', ')} [${item.supabase.stage}]`);
  }
}

mkdirSync(dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, JSON.stringify(report, null, 2));
console.log(`\nEvidence: ${EVIDENCE}`);