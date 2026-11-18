// Зонд гибридного поиска базы знаний: 5 фиксированных запросов,
// локальное хранилище и Supabase/pgvector, с эмбеддингами и без.
// Запуск: node scripts/rag-search-probe.mjs [--local-only]
// Evidence: docs/evidence/rag/search-probe.json

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../server/rag/dataset.js';
import { embedQuery, embedDocuments, embeddingsAvailable } from '../server/rag/embeddings.js';
import { LocalKnowledgeStore } from '../server/rag/store-local.js';
import { SupabaseKnowledgeStore } from '../server/rag/store-supabase.js';
import { withClient } from '../server/rag/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const education = process.argv.includes('--education');
const EVIDENCE = resolve(here, `../docs/evidence/rag/${education ? 'education-search-probe' : 'search-probe'}.json`);
const localOnly = process.argv.includes('--local-only');

const QUERIES = education ? [
  { query: 'lofi hip-hop жанровый гайд тёплого грува', filters: { genre: ['lofi'] }, expectedId: 'edu-guide-lofi-hiphop' },
  { query: 'techno жанровый гайд пульса и развития', filters: { genre: ['techno'] }, expectedId: 'edu-guide-techno' },
  { query: 'drum and bass жанровый гайд two-step', filters: { genre: ['dnb'] }, expectedId: 'edu-guide-dnb' },
  { query: 'ambient жанровый гайд пространства', filters: { genre: ['ambient'] }, expectedId: 'edu-guide-ambient' },
  { query: 'neo-soul жанровый гайд мягкого comping', filters: { genre: ['neo-soul'] }, expectedId: 'edu-guide-neo-soul' },
] : [
  { query: 'тёплые джазовые аккорды пианино для lofi', filters: { genre: ['lofi'], roles: ['chords'] } },
  { query: 'кислотный бас для техно', filters: { genre: ['techno'], roles: ['bass'] } },
  { query: 'эпические струны для кино', filters: { genre: ['cinematic'] } },
  { query: 'трэповые хэты с роллами', filters: { genre: ['trap'], roles: ['hats'] } },
  { query: 'светлый эмбиент пэд', filters: { roles: ['pad'] } },
];

const { entries, errors } = loadDataset();
if (errors.length) throw new Error(`Невалидный датасет: ${JSON.stringify(errors)}`);
const local = new LocalKnowledgeStore(entries);
const available = await embeddingsAvailable();
console.log(`Ollama: ${available ? 'доступна' : 'НЕДОСТУПНА (лексический режим)'}`);
let documentEmbeddings = false;
if (available) {
  const embedded = await embedDocuments(entries.map(e => `${e.title}. ${e.description}. ${(e.education?.rules || []).join(' ')}`));
  if (embedded.ok) {
    documentEmbeddings = true;
    for (let i = 0; i < entries.length; i += 1) await local.upsert(entries[i], embedded.embeddings[i]);
  } else {
    console.log(`Документы без эмбеддингов: ${embedded.reason}`);
  }
}

const report = { date: new Date().toISOString(), set: education ? 'education' : 'baseline', datasetCount: entries.length,
  ollamaAvailable: available, documentEmbeddings, queries: [] };

for (const { query, filters, expectedId } of QUERIES) {
  const emb = available ? await embedQuery(query) : { ok: false };
  const queryEmbedding = emb.ok ? emb.embedding : null;
  const item = { query, filters, semantic: Boolean(queryEmbedding), local: null, supabase: null };

  const lr = await local.search({ query, queryEmbedding: documentEmbeddings ? queryEmbedding : null, filters, topK: 3 });
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
  if (expectedId) {
    item.expectedId = expectedId;
    item.local.relevantFirst = item.local.top[0]?.id === expectedId;
    if (item.supabase) item.supabase.relevantFirst = item.supabase.top[0]?.id === expectedId;
  }
  report.queries.push(item);
  console.log(`\n«${query}»`);
  console.log(`  local:    ${item.local.top.map((t) => `${t.id} (${t.score})`).join(', ')} [${item.local.stage}]`);
  if (item.supabase) {
    console.log(`  supabase: ${item.supabase.top.map((t) => `${t.id} (${t.score})`).join(', ')} [${item.supabase.stage}]`);
  }
}

if (education) {
  report.relevantFirst = {
    local: report.queries.filter(q => q.local.relevantFirst).length,
    supabase: localOnly ? null : report.queries.filter(q => q.supabase?.relevantFirst).length,
    total: QUERIES.length,
  };
}
mkdirSync(dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, JSON.stringify(report, null, 2));
console.log(`\nEvidence: ${EVIDENCE}`);
if (education && (report.relevantFirst.local !== QUERIES.length || (!localOnly && report.relevantFirst.supabase !== QUERIES.length))) {
  process.exitCode = 1;
}