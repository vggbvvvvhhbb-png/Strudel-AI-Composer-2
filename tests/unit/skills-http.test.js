// HTTP-контур скил-паков и LLM-планировщика.
//
// Платная модель подменяется, всё остальное настоящее: карты читаются с диска,
// учебник собирается по-настоящему, IR проверяется Zod, код собирается
// компилятором, разбор считает символьный оракул.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';

const { completeChat } = vi.hoisted(() => ({ completeChat: vi.fn() }));
vi.mock('../../server/llm/client.js', () => ({
  completeChat,
  streamChat: vi.fn(),
  providerChain: () => [],
}));

import router from '../../server/routes/skills.js';
import { planIR } from '../../src/ir/intent.js';
import { clearPlannerCache } from '../../server/ir/planner.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/skills', router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
beforeEach(() => {
  completeChat.mockReset();
  clearPlannerCache();
});

async function get(path) {
  return fetch(`${base}/api/skills${path}`);
}
async function post(path, body) {
  return fetch(`${base}/api/skills${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/skills', () => {
  it('отдаёт реестр карт и версию пака', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.count).toBeGreaterThanOrEqual(11);
    expect(data.skillsVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(data.cards.map((card) => card.id)).toContain('emotion-map');
    expect(data.cards[0].compactTokens).toBeGreaterThan(0);
    // Полное тело карт в реестр не попадает — только сводка.
    expect(data.cards[0].compact).toBeUndefined();
  });

  it('отдаёт карту целиком и 404 на неизвестную', async () => {
    const response = await get('/emotion-map');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('emotion-map');
    // compact — это содержимое секции COMPACT (без самого заголовка).
    expect(data.compact.length).toBeGreaterThan(50);
    expect(data.compact).toContain('V/A');
    expect(data.sections.EXAMPLES).toBeTruthy();

    const missing = await get('/no-such-card');
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/skills/compile', () => {
  it('собирает учебник под запрос и укладывается в бюджет', async () => {
    const response = await post('/compile', { prompt: 'мрачный трип-хоп про дождь' });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tokens).toBeLessThanOrEqual(3200);
    expect(data.used).toContain('genre-trip-hop');
    expect(data.text).toContain('groove-шаблон: drunken');
    expect(data.genre.genre).toBe('trip-hop');
    expect(data.skillsVersion).toMatch(/^[a-f0-9]{64}$/);
  });

  it('требует текст запроса', async () => {
    const response = await post('/compile', {});
    expect(response.status).toBe(400);
  });
});

describe('POST /api/skills/plan', () => {
  it('LLM отвечает IR, компилятор собирает код, оракул считает разбор', async () => {
    const ir = planIR('злой быстрый dnb', { seed: 4 });
    completeChat.mockResolvedValue(JSON.stringify(ir));

    const response = await post('/plan', { prompt: 'злой быстрый dnb', seed: 4 });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.source).toBe('llm');
    expect(data.calls).toBe(1);
    expect(data.code).toMatch(/\$/);
    expect(data.ir.v).toBe(1);
    expect(data.report.sections.length).toBeGreaterThan(0);
    expect(data.report.score.total).toBeGreaterThan(0);
    expect(data.skillsVersion).toMatch(/^[a-f0-9]{64}$/);
    // В промт ушёл учебник, а не пустая строка.
    const system = completeChat.mock.calls[0][0].messages.find((m) => m.role === 'system').content;
    expect(system).toContain('genre-dnb');
  });

  it('битый ответ модели не роняет запрос: план собирается правилами', async () => {
    completeChat.mockResolvedValue('не знаю');
    const response = await post('/plan', { prompt: 'уютный лоуфай для учёбы', seed: 1, maxCalls: 1 });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.source).toBe('rules');
    expect(data.code).toMatch(/\$/);
    expect(data.reason).toBeTruthy();
  });

  it('требует текст описания', async () => {
    const response = await post('/plan', {});
    expect(response.status).toBe(400);
  });
});
