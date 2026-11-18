import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { separateStems, runDeepDive, acquireLock, order } = vi.hoisted(() => ({ separateStems: vi.fn(), runDeepDive: vi.fn(), acquireLock: vi.fn(), order: [] }));
vi.mock('../../server/deepdive/analysis/client.js', () => ({ separateStems, workerHealth: vi.fn() }));
vi.mock('../../server/deepdive/pipeline.js', () => ({ runDeepDive, buildReference: vi.fn(), bassNotesFromPlan: vi.fn() }));
vi.mock('../../server/deepdive/lock.js', () => ({ acquireLock }));
vi.mock('../../server/deepdive/queue.js', () => ({ separationQueue: {
  run: async (handler, { onQueued }) => { order.push('queue'); onQueued({ started: false, position: 1 }); return handler(); },
  stats: () => ({}),
} }));

let server;
let root;
let url;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepdive-progress-test-'));
  vi.stubEnv('DD_WORKSPACE_DIR', root);
  vi.stubEnv('DD_LOCK_DIR', join(root, 'locks'));
  const router = (await import('../../server/routes/deepdive.js')).default;
  const app = express();
  app.use(router);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  acquireLock.mockImplementation(async () => { order.push('lock-acquired'); return { release: async () => order.push('released') }; });
  separateStems.mockImplementation(async () => { order.push('demucs'); return { stems: {} }; });
  runDeepDive.mockImplementation(async ({ deps, onStage, onPassport }) => {
    onPassport({ durationS: 240, measurements: {}, sections: [], track: { duration_s: 240 } });
    onStage({ stage: 'separate', label: 'Подготовка', progress: 0.2 });
    await deps.separate('registered.wav', 'stems', {});
    return { result: { code_twin: { render: {} } }, artifacts: {} };
  });
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('SSE сепарации после очереди и мьютекса', () => {
  it('начинает ETA непосредственно перед Demucs, не при постановке в очередь', async () => {
    const form = new FormData();
    form.append('file', new Blob(['mock audio'], { type: 'audio/wav' }), 'registered.wav');
    form.append('separate', '1');
    const response = await fetch(`${url}/api/deepdive/analyze`, { method: 'POST', body: form });
    expect(response.ok).toBe(true);
    const text = await response.text();
    const events = text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
    const etaStages = events.filter(e => e.type === 'stage' && e.eta);
    expect(etaStages).toHaveLength(1);
    expect(etaStages[0]).toMatchObject({ stage: 'separate', eta: { seconds: 1584 } });
    expect(events.findIndex(e => e.stage === 'queue')).toBeLessThan(events.indexOf(etaStages[0]));
    expect(events.filter(e => e.stage === 'queue').every(e => !e.eta)).toBe(true);
    expect(order.indexOf('lock-acquired')).toBeLessThan(order.indexOf('demucs'));
    expect(events.at(-1).type).toBe('result');
  });
});
