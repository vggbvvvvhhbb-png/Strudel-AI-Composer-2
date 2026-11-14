// Дорожка H: очередь пар, запись меток, надёжность рецензента, приватность.
//
// Метки пишутся в server/data/preferences.jsonl — файл вне git. Тест
// работает в своём временном каталоге (STRUDEL_DATA_DIR), чтобы не трогать
// настоящие метки владельца и не мешать параллельным тестовым файлам.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dataDir = mkdtempSync(join(tmpdir(), 'strudel-preference-'));
process.env.STRUDEL_DATA_DIR = dataDir;
const labelsFile = join(dataDir, 'preferences.jsonl');

import router, { buildQueue, hashCode, PreferenceSchema } from '../../server/routes/preference.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/preference', router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  rmSync(labelsFile, { force: true });
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function get(path) {
  return fetch(`${base}/api/preference${path}`);
}
async function post(path, body) {
  return fetch(`${base}/api/preference${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('очередь пар', () => {
  it('продолжается после закрытых пар, а не начинается заново', async () => {
    const first = await (await get('/queue?limit=3')).json();
    expect(first.offset).toBe(0);
    const pair = first.pairs[0];
    await post('/', {
      pairId: pair.pairId,
      winner: 'A',
      prompt: pair.prompt,
      hashA: pair.a.hash,
      hashB: pair.b.hash,
    });
    const second = await (await get('/queue?limit=3')).json();
    // Смещение сдвинулось, и первая пара теперь другая: без этого каждый
    // сеанс предлагал бы одни и те же промты, а приёмка §7.2 (≥50 разных)
    // была бы недостижима.
    expect(second.offset).toBe(1);
    expect(second.pairs[0].pairId).not.toBe(pair.pairId);
  });

  it('даёт пары с двумя разными кандидатами и хэшами', () => {
    const pairs = buildQueue({ limit: 10 });
    expect(pairs).toHaveLength(10);
    for (const pair of pairs) {
      expect(pair.a.code).toBeTruthy();
      expect(pair.b.code).toBeTruthy();
      expect(pair.a.hash).not.toBe(pair.b.hash);
      expect(pair.a.hash).toMatch(/^[a-f0-9]{16}$/);
      expect(pair.prompt).toBeTruthy();
    }
  });

  it('детерминирована: тот же срез — тот же результат', () => {
    expect(buildQueue({ limit: 5 })).toEqual(buildQueue({ limit: 5 }));
  });

  it('каждая десятая пара — повтор тех же треков с переставленными сторонами', () => {
    const pairs = buildQueue({ limit: 10 });
    const first = pairs[0];
    const repeat = pairs[9];
    expect(repeat.repeat).toBe(true);
    expect(first.repeat).toBe(false);
    // Те же треки — значит те же хэши, но стороны наоборот.
    expect(repeat.a.hash).toBe(first.b.hash);
    expect(repeat.b.hash).toBe(first.a.hash);
    expect(repeat.prompt).toBe(first.prompt);
  });

  it('стороны переставлены не по порядку, а детерминированно', () => {
    const pairs = buildQueue({ limit: 4 });
    expect(pairs.map((pair) => pair.swapped)).toEqual([false, true, false, true]);
  });
});

describe('запись меток', () => {
  it('принимает метку и пишет её в JSONL', async () => {
    const response = await post('/', {
      pairId: 'pair-001',
      winner: 'A',
      listenMs: 8200,
      prompt: 'мрачный трип-хоп про дождь',
      hashA: 'aaa',
      hashB: 'bbb',
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.total).toBe(1);
  });

  it('отвергает мусор с понятной причиной', async () => {
    const response = await post('/', { pairId: 'pair-001', winner: 'X' });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.issues[0].path).toBe('winner');
  });

  it('схема метки не принимает лишние поля с PII-именами', () => {
    const parsed = PreferenceSchema.safeParse({
      pairId: 'p', winner: 'A', email: 'a@b.c',
    });
    // Zod по умолнию отбрасывает неизвестные поля, а не падает:
    // в запись попадёт только разрешённое.
    expect(parsed.success).toBe(true);
    expect(parsed.data.email).toBeUndefined();
  });
});

describe('статистика и надёжность', () => {
  it('покрытие считает разные промты, а не пары', async () => {
    await post('/', { pairId: 'p1', winner: 'A', hashA: 'a', hashB: 'b', prompt: 'промт раз' });
    await post('/', { pairId: 'p2', winner: 'A', hashA: 'c', hashB: 'd', prompt: 'промт раз' });
    await post('/', { pairId: 'p3', winner: 'A', hashA: 'e', hashB: 'f', prompt: 'промт два' });
    const data = await (await get('/stats')).json();
    expect(data.uniquePrompts).toBe(2);
    expect(data.promptsNeeded).toBe(50);
  });

  it('считает решения и ничьи', async () => {
    await post('/', { pairId: 'p1', winner: 'A', hashA: 'a', hashB: 'b' });
    await post('/', { pairId: 'p2', winner: 'B', hashA: 'c', hashB: 'd' });
    await post('/', { pairId: 'p3', winner: 'tie', hashA: 'e', hashB: 'f' });
    const data = await (await get('/stats')).json();
    expect(data.total).toBe(3);
    expect(data.decided).toBe(2);
    expect(data.ties).toBe(1);
  });

  it('надёжность рецензента: повтор с переставленными сторонами', async () => {
    // Один и тот же набор треков, стороны переставлены, выбор тот же трек.
    await post('/', { pairId: 'p1', winner: 'A', hashA: 'aaa', hashB: 'bbb' });
    await post('/', { pairId: 'p2', winner: 'B', hashA: 'bbb', hashB: 'aaa' });
    const data = await (await get('/stats')).json();
    expect(data.repeatedComparisons).toBe(1);
    expect(data.agreements).toBe(1);
    expect(data.reliability).toBe(1);
    expect(data.reliable).toBe(true);
  });

  it('надёжность падает, когда рецензент выбирает разные треки', async () => {
    await post('/', { pairId: 'p1', winner: 'A', hashA: 'aaa', hashB: 'bbb' });
    await post('/', { pairId: 'p2', winner: 'A', hashA: 'bbb', hashB: 'aaa' });
    const data = await (await get('/stats')).json();
    expect(data.agreements).toBe(0);
    expect(data.reliability).toBe(0);
    expect(data.reliable).toBe(false);
  });
});

describe('экспорт и удаление', () => {
  it('экспорт отдаёт chosen/rejected в NDJSON', async () => {
    await post('/', { pairId: 'p1', winner: 'A', hashA: 'aaa', hashB: 'bbb', prompt: 'тест' });
    const response = await get('/export');
    expect(response.status).toBe(200);
    const text = await response.text();
    const line = JSON.parse(text.trim());
    expect(line.chosen).toBe('aaa');
    expect(line.rejected).toBe('bbb');
    expect(line.explicit).toBe(true);
  });

  it('удаление стирает метки (приватность)', async () => {
    await post('/', { pairId: 'p1', winner: 'A', hashA: 'a', hashB: 'b' });
    const response = await fetch(`${base}/api/preference`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    const data = await (await get('/stats')).json();
    expect(data.total).toBe(0);
  });
});

describe('вспомогательное', () => {
  it('хэш кода короткий и стабильный', () => {
    const hash = hashCode('abc');
    expect(hash).toBe(hashCode('abc'));
    expect(hash).not.toBe(hashCode('abd'));
    expect(hash).toHaveLength(16);
  });
});
