// Аудио готового рендера из демона: GET /tasks/:id/audio.
//
// Рендер здесь подменный (renderFactory): проверяется маршрут и защита
// путей, а не Chromium. Настоящий рендер тем же движком покрыт гейтом B.
//
// ГЛАВНЫЕ ПРОВЕРКИ: WAV отдаётся только из каталога рендеров демона и
// только завершённой задачи; путь из результата не читает произвольные
// файлы машины; без токена — 401.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createDaemon } from '../../local/daemon.mjs';

const TOKEN = 'audio-test-token';

// Минимальный WAV-заголовок + 4 отсчёта тишины: маршрут отдаёт байты как есть.
const WAV_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

let stateDir;
let daemon;
let base;
let releaseHold;
const holdGate = new Promise((resolve) => { releaseHold = resolve; });

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'strudel-daemon-audio-'));
  daemon = await createDaemon({
    token: TOKEN,
    stateDir,
    log: () => {},
    renderFactory: async () => ({
      render: async ({ code }) => {
        // Код 'hold' держит задачу в работе: так проверяется аудио
        // незавершённой задачи без гонки с реальным рендером.
        if (code === 'hold') await holdGate;
        return {
          wav: WAV_BYTES,
          renderMs: 5,
          durationS: 0.0001,
          sampleRate: 8000,
          report: {},
          events: null,
          fingerprint: 'test-fingerprint',
        };
      },
      close: async () => {},
    }),
  });
  daemon.server.listen(0, '127.0.0.1');
  await once(daemon.server, 'listening');
  base = `http://127.0.0.1:${daemon.server.address().port}`;
});

afterAll(async () => {
  releaseHold();
  await daemon.registry.close();
  if (daemon?.server) {
    await new Promise((resolve, reject) => daemon.server.close((err) => (err ? reject(err) : resolve())));
  }
  await rm(stateDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

async function submitRender(payload = { code: 'setCpm(1)' }) {
  const res = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'render', payload }),
  });
  expect(res.status).toBe(202);
  return res.json();
}

async function waitDone(id) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/tasks/${id}`, { headers: auth });
    const { task } = await res.json();
    if (task.state === 'done' || task.state === 'error') return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('задача не завершилась за 10 с');
}

describe('аудио рендера из демона', () => {
  it('без токена — 401', async () => {
    const res = await fetch(`${base}/tasks/00000000-0000-0000-0000-000000000000/audio`);
    expect(res.status).toBe(401);
  });

  it('готовый рендер отдаётся побайтово из каталога рендеров', async () => {
    const { id } = await submitRender();
    const task = await waitDone(id);
    expect(task.state).toBe('done');
    expect(task.result.wavPath).toContain(`${path.sep}renders${path.sep}`);

    const res = await fetch(`${base}/tasks/${id}/audio`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(WAV_BYTES)).toBe(true);
  });

  it('аудио незавершённой задачи — 404, а не пустой успех', async () => {
    const { id } = await submitRender({ code: 'hold' });
    // Ждём, пока задача точно в работе (очередь последовательная).
    const deadline = Date.now() + 5000;
    let state = 'queued';
    while (Date.now() < deadline && state !== 'running') {
      const res = await fetch(`${base}/tasks/${id}`, { headers: auth });
      state = (await res.json()).task.state;
      if (state !== 'running') await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state).toBe('running');
    const res = await fetch(`${base}/tasks/${id}/audio`, { headers: auth });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/не завершён/);
    releaseHold();
    await waitDone(id);
  });

  it('несуществующая задача — 404', async () => {
    const res = await fetch(`${base}/tasks/00000000-0000-0000-0000-000000000000/audio`, { headers: auth });
    expect(res.status).toBe(404);
  });

  it('путь вне каталога рендеров не читается, даже если он в результате', async () => {
    const secret = path.join(stateDir, 'secret.wav');
    await writeFile(secret, WAV_BYTES);
    const { id } = await submitRender();
    const task = await waitDone(id);
    expect(task.state).toBe('done');
    // Подменяем путь в результате: маршрут обязан отказать.
    daemon.queue.tasks.get(id).result.wavPath = secret;
    const res = await fetch(`${base}/tasks/${id}/audio`, { headers: auth });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/вне каталога рендеров/);
  });

  it('свой outPath клиента пишется, но наружу через HTTP не отдаётся', async () => {
    const outside = path.join(stateDir, 'outside', 'custom.wav');
    const { id } = await submitRender({ code: 'setCpm(1)', outPath: outside });
    const task = await waitDone(id);
    expect(task.state).toBe('done');
    expect(task.result.wavPath).toBe(path.resolve(outside));
    const res = await fetch(`${base}/tasks/${id}/audio`, { headers: auth });
    expect(res.status).toBe(404);
  });

  it('пропавший с диска файл — честные 404', async () => {
    const { id } = await submitRender();
    const task = await waitDone(id);
    await rm(task.result.wavPath);
    const res = await fetch(`${base}/tasks/${id}/audio`, { headers: auth });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/не найден на диске/);
  });
});