// Маршруты локального пула сэмплов «Охотника» (D-115).
//
// Проверяем входной контроль: некорректный запрос — 400, неразрешённая
// лицензия — 422 и запись НЕ появляется в пуле. Успешное скачивание здесь
// не проверяется (нужен живой Freesound) — измерение и реестр покрыты
// tests/unit/sample-passport.test.js.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';

import router from '../../server/routes/samples.js';
import { readPool } from '../../server/samples/pool.js';

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

describe('маршруты пула сэмплов', () => {
  it('запрос без id и previewUrl — 400', async () => {
    const res = await fetch(`${base}/api/samples/passport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'без адреса' }),
    });
    expect(res.status).toBe(400);
  });

  it('неразрешённая лицензия — 422, и запись в пул не попадает', async () => {
    const id = `route-test-rejected-${Date.now()}`;
    const res = await fetch(`${base}/api/samples/passport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        previewUrl: 'https://freesound.org/data/previews/0/0-test.mp3',
        license: 'Attribution NonCommercial',
        measure: false,
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/не в списке разрешённых/);
    expect(readPool().samples[id]).toBeUndefined();
  });

  it('содержимое пула отдаётся записями с лицензией и атрибуцией', async () => {
    const res = await fetch(`${base}/api/samples/pool`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.samples)).toBe(true);
    for (const entry of body.samples) {
      expect(['cc0', 'cc-by']).toContain(entry.licenseId);
      expect(entry.attribution).toBeTruthy();
    }
  });

  it('поиск по описанию отвечает совпадениями, а не ошибкой', async () => {
    const res = await fetch(`${base}/api/samples/pool?q=${encodeURIComponent('стеклянный удар')}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.results)).toBe(true);
  });
});