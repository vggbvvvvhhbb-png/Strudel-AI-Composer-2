// Маршрут агента: настоящий HTTP + настоящий SSE.
//
// Модель подменена мок-LLM (MOCK_LLM=1): цикл, инструменты, схемы, SSE-формат
// и лимиты — настоящие. Так же, как в CI.
//
// Проверяем контракт, на который будет опираться панель студии:
//   GET  /api/agent/tools  → режимы, инструменты, статус сервисов
//   POST /api/agent        → поток событий: plan → tool_start → tool_end → text → done

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';

process.env.MOCK_LLM = '1';

const { default: router } = await import('../../server/routes/agent.js');

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/** Разбирает SSE-поток в массив событий. */
async function stream(body, headers = {}) {
  const response = await fetch(`${base}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const raw = await response.text();
  const events = [];
  for (const chunk of raw.split('\n\n')) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (line) events.push(JSON.parse(line.slice('data: '.length)));
  }
  return events;
}

describe('GET /api/agent/tools', () => {
  it('отдаёт режимы, инструменты и статус внешних сервисов', async () => {
    const response = await fetch(`${base}/api/agent/tools`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.modes.length).toBeGreaterThanOrEqual(4);
    expect(data.tools.length).toBeGreaterThanOrEqual(8);
    // Интернет без ключа — честно «недоступен», и ключа в ответе нет.
    expect(data.services.internet).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

describe('POST /api/agent', () => {
  it('без промпта — 400', async () => {
    const response = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    });
    expect(response.status).toBe(400);
  });

  it('поток содержит план, вызовы инструментов, текст и итог', async () => {
    const events = await stream({ prompt: 'сделай бит в стиле техно', mode: 'composer' });
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('plan');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
    expect(types).toContain('text');
    expect(types[types.length - 1]).toBe('done');
    expect(types).not.toContain('error');
  });

  it('в итогах есть ответ, использованные инструменты и честный статус деградации', async () => {
    const events = await stream({ prompt: 'найди в интернете, что такое phonk drift', mode: 'research' });
    const done = events.find((event) => event.type === 'done');
    expect(done).toBeTruthy();
    expect(typeof done.answer).toBe('string');
    expect(Array.isArray(done.toolsUsed)).toBe(true);
    expect(Array.isArray(done.degraded)).toBe(true);
    // Без ключа поиска деградация обязана быть зафиксирована, а не замолчана.
    expect(done.degraded.some((item) => item.tool === 'web_search')).toBe(true);
  });

  it('шаги и текст — разные события: панель может показывать их раздельно', async () => {
    const events = await stream({ prompt: 'сделай бит', mode: 'composer' });
    const stepEvents = events.filter((event) => event.type === 'tool_start' || event.type === 'tool_end');
    const textEvents = events.filter((event) => event.type === 'text');
    expect(stepEvents.length).toBeGreaterThan(0);
    expect(textEvents.length).toBeGreaterThan(0);
    expect(stepEvents.every((event) => typeof event.id === 'string')).toBe(true);
  });
});
