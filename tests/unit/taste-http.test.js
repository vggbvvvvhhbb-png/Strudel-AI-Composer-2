// Выученная цель по HTTP: реестр пар, метка с аудио-признаками, обучение.
//
// Главная проверка здесь — СКВОЗНОЙ ПУТЬ: очередь создаёт пару (вместе с
// IR), человек ставит метку с аудио-признаками, и из этого рождается
// обучающий пример. До этой сессии метка несла только хэши, и путь рвался
// на последнем шаге — обучать было нечем.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import preferenceRouter, { buildQueue } from '../../server/routes/preference.js';
import tasteRouter from '../../server/routes/taste.js';
import { readPairs, readLabels } from '../../server/preference/ledger.js';
import { buildRows } from '../../server/taste/dataset.js';
import { TASTE_FEATURE_IDS } from '../../src/taste/features.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

// Тесты работают в своём каталоге данных: не трогают настоящие метки
// владельца и не мешают другим тестовым файлам, которые идут параллельно.
const dataDir = mkdtempSync(join(tmpdir(), 'strudel-taste-http-'));
process.env.STRUDEL_DATA_DIR = dataDir;

let server;
let base;
const backups = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/preference', preferenceRouter);
  app.use('/api/taste', tasteRouter);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
  for (const { file, backup } of backups) {
    if (existsSync(backup)) {
      copyFileSync(backup, file);
      rmSync(backup, { force: true });
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function get(path) {
  return fetch(`${base}${path}`);
}

async function post(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('реестр пар', () => {
  it('очередь кладёт пары в реестр вместе с IR', () => {
    buildQueue({ limit: 3 });
    const pairs = readPairs();
    expect(pairs.length).toBeGreaterThanOrEqual(3);
    expect(pairs[0].a.ir).toBeTruthy();
    expect(pairs[0].b.ir).toBeTruthy();
    expect(pairs[0].a.hash).not.toBe(pairs[0].b.hash);
  });

  it('GET /api/preference/pairs отдаёт состав реестра без IR', async () => {
    const response = await get('/api/preference/pairs');
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.count).toBeGreaterThanOrEqual(3);
    expect(data.pairs[0].ir).toBeUndefined();
    expect(data.pairs[0].hashA).toBeTruthy();
  });
});

describe('метка с аудио-признаками', () => {
  it('принимает аудио-признаки обеих сторон', async () => {
    const pairs = buildQueue({ limit: 1 });
    const pair = pairs[0];
    const response = await post('/api/preference', {
      pairId: pair.id,
      winner: 'A',
      listenMs: 8000,
      prompt: pair.prompt,
      hashA: pair.a.hash,
      hashB: pair.b.hash,
      source: 'explicit',
      audio: {
        a: { lufsI: -14.1, truePeakDbtp: -1.2, crestDb: 9.4, clipCount: 0 },
        b: { lufsI: -16.8, truePeakDbtp: -2.1, crestDb: 7.1, clipCount: 0 },
      },
    });
    expect(response.status).toBe(200);
    const labels = readLabels();
    expect(labels.length).toBe(1);
    expect(labels[0].audio.a.lufsI).toBe(-14.1);
    expect(labels[0].audio.b.lufsI).toBe(-16.8);
  });

  it('отвергает мусор в аудио-признаках', async () => {
    const response = await post('/api/preference', {
      pairId: 'p-bad',
      winner: 'A',
      audio: { a: { lufsI: 'громко' } },
    });
    expect(response.status).toBe(400);
  });
});

describe('сквозной путь: пара → метка → обучающий пример', () => {
  it('метка соединяется с парой и даёт вектор признаков', () => {
    const pairs = buildQueue({ limit: 1 });
    const pair = pairs[0];
    const labels = readLabels();
    const label = labels.find((item) => item.pairId === pair.id);
    expect(label).toBeTruthy();

    const { rows, stats } = buildRows({ pairs: readPairs(), labels });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((item) => item.pairId === pair.id);
    expect(row).toBeTruthy();
    expect(row.y).toBe(1);
    expect(row.xA).toHaveLength(TASTE_FEATURE_IDS.length);
    expect(row.lufsA).toBe(-14.1);
    expect(row.lufsB).toBe(-16.8);
    expect(stats.rows).toBe(rows.length);
  });
});

describe('API выученной цели', () => {
  it('GET /api/taste отдаёт состояние и требуемое число пар', async () => {
    const response = await get('/api/taste');
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.data.needForAdmission).toBe(60);
    expect(data.featureIds.length).toBe(TASTE_FEATURE_IDS.length);
  });

  it('POST /api/taste/train обучает на накопленных парах', async () => {
    const response = await post('/api/taste/train', {});
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.trained).toBe(true);
    expect(data.stats.rows).toBeGreaterThanOrEqual(1);
    // Одна пара — это не допуск: модель остаётся «не проверена на людях».
    expect(data.admitted).toBe(false);
    expect(data.decision.reasons.length).toBeGreaterThan(0);
  });

  it('после обучения модель читается и активный отбор доступен', async () => {
    const state = await (await get('/api/taste')).json();
    expect(state.model.trained).toBe(true);
    expect(state.model.n).toBeGreaterThanOrEqual(1);

    const active = await (await get('/api/taste/active?count=2')).json();
    expect(active.ok).toBe(true);
    expect(active.available).toBe(true);
    expect(active.pairs.length).toBeGreaterThanOrEqual(1);
  });

  it('удаление меток стирает и реестр пар (приватность)', async () => {
    const response = await fetch(`${base}/api/preference`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(readLabels().length).toBe(0);
    expect(readPairs().length).toBe(0);
  });
});
