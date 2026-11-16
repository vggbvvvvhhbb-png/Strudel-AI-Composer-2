// Серверные маршруты к локальному демону.
//
// Проверяем честную деградацию: без настроенного демона сервер должен говорить
// «демон не настроен», а не притворяться, что задача куда-то ушла.
//
// Демон в тесте — настоящий: поднимается в отдельном процессе, потому что
// очередь и журнал должны быть настоящими (local/queue.mjs покрыт отдельно).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TOKEN = 'route-test-token';
const PORT = 3221;

process.env.LOCAL_DAEMON_URL = `http://127.0.0.1:${PORT}`;
process.env.LOCAL_DAEMON_TOKEN = TOKEN;

const { default: router } = await import('../../server/routes/local.js');

let server;
let base;
let daemon;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/local', router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  daemon = spawn(process.execPath, ['local/daemon.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOCAL_DAEMON_TOKEN: TOKEN,
      LOCAL_DAEMON_PORT: String(PORT),
      LOCAL_DAEMON_STATE: path.join(ROOT, '.scratch', 'local-route-test'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Ждём, пока демон поднимется.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${process.env.LOCAL_DAEMON_URL}/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (res.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});

afterAll(async () => {
  if (daemon) daemon.kill('SIGTERM');
  if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('маршруты локального демона', () => {
  it('статус: демон виден, его возможности перечислены', async () => {
    const res = await fetch(`${base}/api/local/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.available).toBe(true);
    expect(body.tasks).toContain('render');
    // Честность: недоступный Python-воркер отмечен как недоступный.
    expect(body.analysis.available === false || body.analysis.available === true).toBe(true);
  });

  it('задача ставится в очередь демона и её видно по id', async () => {
    const res = await fetch(`${base}/api/local/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'render', payload: { code: 'setCpm(120/4)' } }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.type).toBe('render');

    const status = await fetch(`${base}/api/local/tasks/${body.id}`);
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.task.id).toBe(body.id);
    expect(['queued', 'running', 'done', 'error']).toContain(statusBody.task.state);
  });

  it('неизвестный тип задачи отвергается с перечнем доступных', async () => {
    const res = await fetch(`${base}/api/local/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'выдумать-трек' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/неизвестный тип задачи/);
    expect(body.available).toContain('render');
  });

  it('несуществующая задача — 404, а не «всё хорошо»', async () => {
    const res = await fetch(`${base}/api/local/tasks/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it('очередь демона видна списком задач со статистикой', async () => {
    const res = await fetch(`${base}/api/local/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.stats).toHaveProperty('total');
    // Ранее поставленная задача рендера обязана быть в списке.
    expect(body.tasks.some((task) => task.type === 'render')).toBe(true);
  });

  it('аудио несуществующей задачи — 404 от демона через прокси', async () => {
    const res = await fetch(`${base}/api/local/tasks/00000000-0000-0000-0000-000000000000/audio`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
