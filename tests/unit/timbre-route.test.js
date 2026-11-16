// Маршруты каталога Timbre Palette (D-126): ленивый каталог и атрибуция.
//
// Проверяем контракт: каталог отдаёт публичные метаданные и статус прав;
// атрибуция считается тем же серверным модулем, что и гейт; некорректный
// запрос — 400. Пустой каталог — честный пустой ответ, не ошибка.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';

import router from '../../server/routes/samples.js';

let server;
let base;

beforeAll(async () => {
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

describe('маршруты каталога Timbre', () => {
  it('GET /api/timbre/catalog — статус прав и метаданные пресетов', async () => {
    const res = await fetch(`${base}/api/timbre/catalog`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.totals.sources).toBeGreaterThanOrEqual(2);
    expect(typeof body.releaseBlocked).toBe('boolean');
  });

  it('POST /api/timbre/attribution — код без пресетов даёт пустую атрибуцию', async () => {
    const res = await fetch(`${base}/api/timbre/attribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codes: ['s("bd")', 'note("c3").s("piano")'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attributions).toEqual([[], []]);
  });

  it('POST без массива codes — 400', async () => {
    const res = await fetch(`${base}/api/timbre/attribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 's("bd")' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST больше 64 кодов — 400', async () => {
    const res = await fetch(`${base}/api/timbre/attribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codes: Array.from({ length: 65 }, () => 's("bd")') }),
    });
    expect(res.status).toBe(400);
  });
});