import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createDaemonClient } from '../../local/client.mjs';

let server;
let client;
let states;
let calls;
beforeEach(async () => {
  states = ['queued', 'running', 'done'];
  calls = 0;
  server = http.createServer((_req, res) => {
    const state = states[Math.min(calls++, states.length - 1)];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ task: { state, result: { passport: { durationS: 1 } }, error: 'task failed' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  client = createDaemonClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-only' });
});
afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

describe('ожидание задачи локального демона', () => {
  it('возвращает измерения только после done', async () => {
    const task = await client.wait('registered', { pollMs: 1 });
    expect(calls).toBe(3);
    expect(task.result.passport.durationS).toBe(1);
  });

  it('ошибка задачи не превращается в пустой успех', async () => {
    states = ['error'];
    await expect(client.wait('registered', { pollMs: 1 })).rejects.toThrow('task failed');
    expect(calls).toBe(1);
  });

  it('отмена до старта не отправляет запрос', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(client.wait('registered', { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(calls).toBe(0);
  });

  it('общий таймаут прерывает незавершённую очередь', async () => {
    states = ['running'];
    await expect(client.wait('registered', { timeoutMs: 50, pollMs: 100 })).rejects.toThrow();
  });

  it('отмена в ожидании не ждёт следующий интервал', async () => {
    states = ['running'];
    const controller = new AbortController();
    const waiting = client.wait('registered', { signal: controller.signal, pollMs: 10_000 });
    const timer = setTimeout(() => controller.abort(), 50);
    try { await expect(waiting).rejects.toThrow(); } finally { clearTimeout(timer); }
  });
});
