// Идемпотентная загрузка золотого датасета в Supabase с эмбеддингами.
// Запуск: node scripts/rag-upload.mjs [--dry-run] [--no-embed]
//   --dry-run  без БД: локальное хранилище, отчёт о готовности
//   --no-embed загрузка без эмбеддингов (поиск деградирует до лексики)
// Если Ollama недоступна — загрузка НЕ падает: записи едут с embedding=null,
// отчёт честно говорит, сколько без семантики (D-134).

import { loadDataset } from '../server/rag/dataset.js';
import { embedDocuments } from '../server/rag/embeddings.js';
import { LocalKnowledgeStore } from '../server/rag/store-local.js';
import { SupabaseKnowledgeStore } from '../server/rag/store-supabase.js';
import { withClient } from '../server/rag/db.js';

const dryRun = process.argv.includes('--dry-run');
const noEmbed = process.argv.includes('--no-embed');

const { entries, errors } = loadDataset();
if (errors.length) {
  console.error('датасет невалиден, загрузка остановлена:');
  for (const e of errors) console.error(`  ${e.id}: ${JSON.stringify(e.errors)}`);
  process.exit(1);
}
console.log(`датасет: ${entries.length} записей, все валидны`);

let embeddings = entries.map(() => null);
if (!noEmbed) {
  const r = await embedDocuments(entries.map((e) => `${e.title}. ${e.description}`));
  if (r.ok) {
    embeddings = r.embeddings;
    console.log(`эмбеддинги: ${embeddings.length} × ${embeddings[0].length} (nomic-embed-text)`);
  } else {
    console.log(`ВНИМАНИЕ: ${r.reason} — записи пойдут без эмбеддингов, поиск будет лексическим`);
  }
}

if (dryRun) {
  const store = new LocalKnowledgeStore();
  for (let i = 0; i < entries.length; i += 1) await store.upsert(entries[i], embeddings[i]);
  console.log(`dry-run: локальное хранилище, ${await store.count()} записей, с эмбеддингом: ${embeddings.filter(Boolean).length}`);
} else {
  await withClient(async (client) => {
    const store = new SupabaseKnowledgeStore(client);
    for (let i = 0; i < entries.length; i += 1) await store.upsert(entries[i], embeddings[i]);
    console.log(`загружено (upsert по id): ${await store.count()} записей в Supabase`);
  });
}
console.log(`без эмбеддинга: ${embeddings.filter((e) => !e).length} из ${entries.length}`);