// Маршруты локального пула сэмплов «Охотника» (D-115).
//
// Проверяем входной контроль: некорректный запрос — 400, неразрешённая
// лицензия — 422 и запись НЕ появляется в пуле. Успешное скачивание здесь
// не проверяется (нужен живой Freesound) — измерение и реестр покрыты
// tests/unit/sample-passport.test.js.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import router from '../../server/routes/samples.js';
import { readPool, writePool, addToPool, POOL_AUDIO_DIR } from '../../server/samples/pool.js';

let server;
let base;
let tmpDir;
const testIds = [];
const testFiles = [];

const WAV_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  tmpDir = await mkdtemp(path.join(tmpdir(), 'strudel-pool-route-'));
});

afterAll(async () => {
  // Тестовые записи не должны остаться в настоящем пуле.
  const pool = readPool();
  for (const id of testIds) delete pool.samples[id];
  writePool(pool);
  for (const file of testFiles) await rm(file, { force: true });
  await rm(tmpDir, { recursive: true, force: true });
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

describe('аудио сэмпла из пула', () => {
  it('зарегистрированный файл из каталога пула отдаётся побайтово', async () => {
    const id = `route-test-audio-${Date.now()}`;
    const file = path.join(POOL_AUDIO_DIR, `${id}.wav`);
    await writeFile(file, WAV_BYTES);
    testIds.push(id);
    testFiles.push(file);
    const added = addToPool({ id, name: 'тестовый звук', licenseId: 'cc0', file });
    expect(added.ok).toBe(true);

    const res = await fetch(`${base}/api/samples/pool/${id}/audio`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(WAV_BYTES)).toBe(true);
  });

  it('файл вне каталога пула не читается, даже если он в записи', async () => {
    const id = `route-test-traversal-${Date.now()}`;
    const outside = path.join(tmpDir, 'outside.wav');
    await writeFile(outside, WAV_BYTES);
    testIds.push(id);
    testFiles.push(outside);
    addToPool({ id, name: 'чужой путь', licenseId: 'cc0', file: outside });

    const res = await fetch(`${base}/api/samples/pool/${id}/audio`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/не в каталоге пула/);
  });

  it('запись без файла и несуществующий сэмпл — 404', async () => {
    const id = `route-test-nofile-${Date.now()}`;
    testIds.push(id);
    addToPool({ id, name: 'без файла', licenseId: 'cc0' });
    const noFile = await fetch(`${base}/api/samples/pool/${id}/audio`);
    expect(noFile.status).toBe(404);
    const unknown = await fetch(`${base}/api/samples/pool/нет-такого-сэмпла/audio`);
    expect(unknown.status).toBe(404);
  });
});