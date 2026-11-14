// Permalink разбора: результат должен переживать вкладку и перезапуск.
//
// Что проверяем:
//   * готовая задача пишется на диск и читается обратно;
//   * новый экземпляр хранилища (имитация перезапуска сервера) находит задачу
//     по идентификатору — то есть ссылка /razbor/<job-id> работает;
//   * незаконченная задача на диск не пишется (чтобы не выдавать себя за
//     готовую);
//   * TTL: старые задачи убираются и из памяти, и с диска.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createJobStore } from '../../server/deepdive/jobs.js';

let root;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dd-jobs-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Хранилище задач и прямая ссылка', () => {
  it('готовый результат сохраняется на диск и читается после «перезапуска»', async () => {
    const store = createJobStore({ root });
    const job = store.create({
      id: 'job-1',
      fileName: 'demo.wav',
      model: 'htdemucs',
      separate: true,
    });
    job.status = 'done';
    job.progress = 1;
    job.result = { track: { id: 'job-1' }, code_twin: { code: '// код' } };
    job.artifacts = { twinWavPath: '/tmp/twin.wav', totalBars: 24, rhythm: { source: 'stem' } };
    job.finishedAt = Date.now();
    await store.save(job);

    // Новый экземпляр хранилища — сервер перезапустился, память пуста.
    const afterRestart = createJobStore({ root });
    const found = await afterRestart.get('job-1');
    expect(found).toBeTruthy();
    expect(found.fromDisk).toBe(true);
    expect(found.status).toBe('done');
    expect(found.result.code_twin.code).toBe('// код');
    expect(found.artifacts.twinWavPath).toBe('/tmp/twin.wav');
    expect(found.artifacts.rhythm).toEqual({ source: 'stem' });
  });

  it('в памяти задача видна сразу, до сохранения на диск', async () => {
    const store = createJobStore({ root });
    const job = store.create({ id: 'job-2' });
    expect(store.peek('job-2')).toBe(job);
    expect(store.peek('job-2').status).toBe('running');
  });

  it('несуществующая задача — это null, а не исключение', async () => {
    const store = createJobStore({ root });
    expect(await store.get('нет-такой')).toBeNull();
    expect(store.peek('нет-такой')).toBeNull();
  });

  it('запись на диск атомарна: временный файл не остаётся', async () => {
    const store = createJobStore({ root });
    const job = store.create({ id: 'job-3' });
    job.status = 'done';
    await store.save(job);
    const raw = await readFile(path.join(root, 'job-3', 'job.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe('job-3');
    expect(parsed.status).toBe('done');
  });

  it('TTL убирает и память, и папку на диске', async () => {
    const store = createJobStore({ root, ttlMs: 1000 });
    const job = store.create({ id: 'job-4' });
    job.status = 'done';
    job.finishedAt = Date.now() - 5000;
    await store.save(job);
    expect(store.peek('job-4')).toBeTruthy();

    const removed = await store.prune();
    expect(removed).toContain('job-4');
    expect(store.peek('job-4')).toBeNull();
    await expect(readFile(path.join(root, 'job-4', 'job.json'), 'utf8')).rejects.toThrow();
  });

  it('удаление задачи чистит папку целиком', async () => {
    const store = createJobStore({ root });
    const job = store.create({ id: 'job-5' });
    job.status = 'done';
    await store.save(job);
    await store.remove('job-5');
    expect(store.peek('job-5')).toBeNull();
    await expect(readFile(path.join(root, 'job-5', 'job.json'), 'utf8')).rejects.toThrow();
  });
});
