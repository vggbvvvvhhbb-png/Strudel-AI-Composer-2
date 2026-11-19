// Маршруты «музыкального интеллекта» (D-140): контракт assist/explain/status.
// MOCK_LLM=1, Supabase принудительно отключён — тест не ходит в базу владельца.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { loadDataset } from '../../server/rag/dataset.js';

let server;
let base;
let router;

beforeAll(async () => {
  process.env.MOCK_LLM = '1';
  // Пустые строки, не delete: dotenv при импорте config не перезаписывает
  // уже заданные переменные, и маршрут гарантированно идёт в локальную базу.
  process.env.SUPABASE_DB_HOST = '';
  process.env.SUPABASE_DB_USER = '';
  process.env.SUPABASE_DB_PASSWORD = '';
  router = (await import('../../server/routes/rag.js')).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const post = (url, body) => fetch(base + url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('маршруты RAG', () => {
  it('GET /api/rag/status — локальная база, число записей совпадает с датасетом, версия промпта', async () => {
    const res = await fetch(`${base}/api/rag/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.store).toBe('local');
    // Источник истины — сам датасет: жёстко зашитое число ломало тест на
    // каждой новой записи знаний (P1 добавил 4 записи: 148 → 152).
    // Нижняя граница остаётся: случайная усадка корпуса — это дефект.
    const { entries, errors } = loadDataset();
    expect(errors).toEqual([]);
    expect(body.entries).toBe(entries.length);
    expect(body.entries).toBeGreaterThanOrEqual(148);
    expect(body.promptVersion).toMatch(/^mi-/);
  });

  it('POST /api/rag/assist — mock-LLM проходит петлю, код валиден', async () => {
    const res = await post('/api/rag/assist', { request: 'тёплые джазовые аккорды для lofi' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.code).toContain('setCpm');
    expect(body.rationale.length).toBeGreaterThan(10);
    expect(body.attempts).toBeGreaterThanOrEqual(1);
    expect(body.search.results.length).toBeGreaterThan(0);
    expect(body.store).toBe('local');
  });

  it('POST /api/rag/assist без request — 400', async () => {
    expect((await post('/api/rag/assist', {})).status).toBe(400);
    expect((await post('/api/rag/assist', { request: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('POST /api/rag/explain — ii–V–I распознаётся', async () => {
    const res = await post('/api/rag/explain', {
      code: 'const key = "c:major"\n$CHORDS: chord("<Dm7 G7 CM7>").voicing().s("piano")',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.progression.name).toBe('ii–V–I');
    expect(body.cadence).toBe('authentic');
  });

  it('POST /api/rag/explain без кода — 400, без chord() — честная причина', async () => {
    expect((await post('/api/rag/explain', {})).status).toBe(400);
    const res = await post('/api/rag/explain', { code: '$X: s("bd*4")' });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toContain('нет chord()');
  });

  it('assist не трогает человеческие счётчики вкуса (feature отдельный)', async () => {
    // Маршрут не пишет preference-метки: проверяем, что ответ не содержит
    // полей суждения, а usage идёт через feature rag-assist (recordCall).
    const res = await post('/api/rag/assist', { request: 'минорный бас' });
    const body = await res.json();
    expect(body.judged).toBeUndefined();
    expect(body.pairType).toBeUndefined();
  });
});