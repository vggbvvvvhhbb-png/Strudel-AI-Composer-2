// Миграции базы знаний: применяет server/rag/migrations/*.sql по порядку,
// идемпотентно (журнал _rag_migrations). Запуск: node scripts/rag-migrate.mjs
// Креды — из env (SUPABASE_DB_*), в репо не пишутся.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withClient } from '../server/rag/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../server/rag/migrations');

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

await withClient(async (client) => {
  await client.query(`create table if not exists public._rag_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await client.query('select name from public._rag_migrations')).rows.map((r) => r.name));
  for (const file of files) {
    if (done.has(file)) {
      console.log(`= ${file} (уже применена)`);
      continue;
    }
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public._rag_migrations (name) values ($1)', [file]);
      await client.query('commit');
      console.log(`+ ${file} применена`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`миграция ${file} упала: ${err.message}`);
    }
  }
  const ext = await client.query("select extversion from pg_extension where extname='vector'");
  console.log(`pgvector: ${ext.rows[0]?.extversion ?? 'НЕ УСТАНОВЛЕН'}`);
});