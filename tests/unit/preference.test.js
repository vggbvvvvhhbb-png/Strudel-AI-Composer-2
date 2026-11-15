// Дорожка H: очередь пар, запись меток, надёжность рецензента, приватность.
//
// Метки пишутся в server/data/preferences.jsonl — файл вне git. Тест
// работает в своём временном каталоге (STRUDEL_DATA_DIR), чтобы не трогать
// настоящие метки владельца и не мешать параллельным тестовым файлам.
//
// КОНТРАКТ ЗАПИСИ МЕТКИ (A0.1). Метка «человек выбрал лучше» принимается
// только так:
//   • `source: 'explicit'` — поле обязательное, без значения по умолчанию;
//   • `channel: 'tinder'` — канал страницы суждения;
//   • `sessionId` — сессия, выданная сервером вместе с очередью;
//   • пара была показана в этой сессии;
//   • есть измерения звука обеих сторон (или честный флаг `degraded`).
// Раньше `source` имел значение по умолчанию 'explicit', и 60 автопостов
// разблокировали выученную цель.

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

/**
 * Открыть очередь. Сервер выдаёт сессию рецензента и запоминает,
 * какие пары в ней показаны.
 */
async function openQueue(limit = 20) {
  const response = await get(`/queue?limit=${limit}`);
  return response.json();
}

/**
 * Метка настоящего рецензента: канал, сессия, измерения звука.
 * @param {object} pair пара из очереди
 * @param {object} queue ответ очереди (ради sessionId)
 * @param {object} [extra] дополнительные поля метки
 */
async function postHuman(pair, queue, extra = {}) {
  return post('/', {
    pairId: pair.pairId,
    winner: 'A',
    prompt: pair.prompt,
    hashA: pair.a.hash,
    hashB: pair.b.hash,
    source: 'explicit',
    channel: 'tinder',
    sessionId: queue.sessionId,
    audio: {
      a: { lufsI: -20.4, truePeakDbtp: -3.2, crestDb: 8.1, clipCount: 0 },
      b: { lufsI: -20.1, truePeakDbtp: -3.4, crestDb: 7.8, clipCount: 0 },
    },
    ...extra,
  });
}

describe('очередь пар', () => {
  it('продолжается после закрытых пар, а не начинается заново', async () => {
    const first = await openQueue(3);
    const pair = first.pairs[0];
    await postHuman(pair, first);
    const second = await openQueue(3);
    // Смещение сдвинулось, и первая пара теперь другая: без этого каждый
    // сеанс предлагал бы одни и те же промты, а приёмка §7.2 (≥50 разных)
    // была бы недостижима.
    expect(second.offset).toBe(1);
    expect(second.pairs[0].pairId).not.toBe(pair.pairId);
  });

  it('выдаёт сессию рецензента', async () => {
    const queue = await openQueue(3);
    expect(typeof queue.sessionId).toBe('string');
    expect(queue.sessionId.length).toBeGreaterThan(8);
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
    const queue = await openQueue(3);
    const response = await postHuman(queue.pairs[0], queue, { listenMs: 8200 });
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
      pairId: 'p', winner: 'A', source: 'explicit', email: 'a@b.c',
    });
    // Zod по умолчанию отбрасывает неизвестные поля, а не падает:
    // в запись попадёт только разрешённое.
    expect(parsed.success).toBe(true);
    expect(parsed.data.email).toBeUndefined();
  });
});

describe('метка без источника не считается человеческой', () => {
  it('метка без source отвергается', async () => {
    const response = await post('/', { pairId: 'pair-001', winner: 'A' });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.issues.some((issue) => issue.path === 'source')).toBe(true);
  });

  it('человеческая метка без канала отвергается', async () => {
    const queue = await openQueue(3);
    const response = await post('/', {
      pairId: queue.pairs[0].pairId,
      winner: 'A',
      source: 'explicit',
      sessionId: queue.sessionId,
      audio: { a: { lufsI: -20 }, b: { lufsI: -20 } },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('страниц');
  });

  it('человеческая метка без сессии отвергается', async () => {
    const queue = await openQueue(3);
    const response = await post('/', {
      pairId: queue.pairs[0].pairId,
      winner: 'A',
      source: 'explicit',
      channel: 'tinder',
      audio: { a: { lufsI: -20 }, b: { lufsI: -20 } },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Сессия');
  });

  it('метка для пары, не показанной в сессии, отвергается', async () => {
    const queue = await openQueue(3);
    const other = buildQueue({ limit: 20 }).find((pair) => !queue.pairs.some((p) => p.pairId === pair.pairId));
    const response = await post('/', {
      pairId: other.pairId,
      winner: 'A',
      source: 'explicit',
      channel: 'tinder',
      sessionId: queue.sessionId,
      audio: { a: { lufsI: -20 }, b: { lufsI: -20 } },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('не была показана');
  });

  it('метка без измерений звука отвергается', async () => {
    const queue = await openQueue(3);
    const response = await postHuman(queue.pairs[0], queue, { audio: undefined });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('измерений звука');
  });

  it('метка с честным флагом degraded сохраняется', async () => {
    // Рендер не удался: труд рецензента не теряется, но в обучение такая
    // метка не идёт (см. server/taste/dataset.js).
    const queue = await openQueue(3);
    const response = await postHuman(queue.pairs[0], queue, { audio: undefined, degraded: true });
    expect(response.status).toBe(200);
    expect((await response.json()).total).toBe(1);
  });

  it('РЕГРЕСС: автопост 60 меток без source не двигает счётчик живых пар', async () => {
    // Сценарий, который раньше разблокировал выученную цель: скрипт
    // шлёт 60 меток без поля source, они сохраняются как «explicit»
    // (значение по умолчанию), и порог 60 живых пар закрыт.
    for (let i = 0; i < 60; i += 1) {
      const response = await post('/', {
        pairId: `pair-${String((i % 20) + 1).padStart(3, '0')}`,
        winner: i % 2 === 0 ? 'A' : 'B',
        hashA: `auto${i}`,
        hashB: `auto${i + 1}`,
        prompt: `автопромт ${i}`,
      });
      expect(response.status).toBe(400);
    }
    const stats = await (await get('/stats')).json();
    expect(stats.total).toBe(0);
    expect(stats.explicit).toBe(0);
    expect(stats.decided).toBe(0);
  });

  it('РЕГРЕСС: 60 меток с явным source, но без сессии, тоже не считаются', async () => {
    for (let i = 0; i < 60; i += 1) {
      const response = await post('/', {
        pairId: `pair-${String((i % 20) + 1).padStart(3, '0')}`,
        winner: 'A',
        source: 'explicit',
        audio: { a: { lufsI: -20 }, b: { lufsI: -20 } },
      });
      expect(response.status).toBe(400);
    }
    const stats = await (await get('/stats')).json();
    expect(stats.explicit).toBe(0);
  });
});

describe('статистика и надёжность', () => {
  it('покрытие считает разные промты, а не пары', async () => {
    const queue = await openQueue(3);
    await postHuman(queue.pairs[0], queue);
    await postHuman(queue.pairs[1], queue, { winner: 'B' });
    await postHuman(queue.pairs[2], queue, { winner: 'tie' });
    const data = await (await get('/stats')).json();
    expect(data.uniquePrompts).toBe(3);
    expect(data.promptsNeeded).toBe(50);
  });

  it('считает решения и ничьи', async () => {
    const queue = await openQueue(3);
    await postHuman(queue.pairs[0], queue, { winner: 'A' });
    await postHuman(queue.pairs[1], queue, { winner: 'B' });
    await postHuman(queue.pairs[2], queue, { winner: 'tie' });
    const data = await (await get('/stats')).json();
    expect(data.total).toBe(3);
    expect(data.decided).toBe(2);
    expect(data.ties).toBe(1);
  });

  it('надёжность рецензента: повтор с переставленными сторонами', async () => {
    // Одна и та же пара, оценённая дважды: второй раз стороны переставлены.
    const queue = await openQueue(10);
    const original = queue.pairs.find((pair) => !pair.repeat);
    const repeat = queue.pairs.find((pair) => pair.repeat);
    await postHuman(original, queue, { winner: 'A' });
    await postHuman(repeat, queue, { winner: 'B' });
    const data = await (await get('/stats')).json();
    expect(data.repeatedComparisons).toBe(1);
    expect(data.agreements).toBe(1);
    expect(data.reliability).toBe(1);
    expect(data.reliable).toBe(true);
  });

  it('надёжность падает, когда рецензент выбирает разные треки', async () => {
    const queue = await openQueue(10);
    const original = queue.pairs.find((pair) => !pair.repeat);
    const repeat = queue.pairs.find((pair) => pair.repeat);
    await postHuman(original, queue, { winner: 'A' });
    await postHuman(repeat, queue, { winner: 'A' });
    const data = await (await get('/stats')).json();
    expect(data.agreements).toBe(0);
    expect(data.reliability).toBe(0);
    expect(data.reliable).toBe(false);
  });
});

describe('экспорт и удаление', () => {
  it('экспорт отдаёт chosen/rejected в NDJSON', async () => {
    const queue = await openQueue(3);
    await postHuman(queue.pairs[0], queue);
    const response = await get('/export');
    expect(response.status).toBe(200);
    const text = await response.text();
    const line = JSON.parse(text.trim());
    expect(line.chosen).toBe(queue.pairs[0].a.hash);
    expect(line.rejected).toBe(queue.pairs[0].b.hash);
    expect(line.explicit).toBe(true);
  });

  it('удаление стирает метки (приватность)', async () => {
    const queue = await openQueue(3);
    await postHuman(queue.pairs[0], queue);
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
