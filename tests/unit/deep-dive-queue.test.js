// Мьютекс тяжёлых операций и очередь разделения.
//
// Это механизм защиты от OOM, поэтому проверяем именно поведение:
//   * две тяжёлые задачи не идут одновременно (вторая ЖДЁТ);
//   * ожидание видно — колбэк приходит до старта задачи;
//   * мьютекс берётся по файлу и освобождается;
//   * «зависший» лок (владелец исчез) не блокирует систему навсегда.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHeavyQueue } from '../../server/deepdive/queue.js';
import { acquireLock, tryAcquireLock, lockPath, readLockOwner } from '../../server/deepdive/lock.js';

let dir;

/**
 * Ждём условие, а не фиксированную паузу.
 *
 * ЗАЧЕМ. Тесты мьютекса стоят на таймерах: пока первый претендент держит лок,
 * второй должен ждать. Фиксированная пауза («40 мс и проверим») — источник
 * флака: на загруженной машине таймер отстаёт, и условие ещё не наступило.
 * Ожидание условия с дедлайном проверяет то же самое, но без гонки.
 */
async function waitFor(condition, { timeoutMs = 5000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('условие не наступило за ' + timeoutMs + ' мс');
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dd-lock-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Очередь тяжёлых операций', () => {
  it('вторая задача ждёт первую и получает статус «в очереди»', async () => {
    const queue = createHeavyQueue({ concurrency: 1 });
    const order = [];
    const queued = [];

    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

    const first = queue.run(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
      return 'first';
    }, { onQueued: (info) => queued.push({ phase: 'first', ...info }) });

    const second = queue.run(async () => {
      order.push('second:start');
      return 'second';
    }, { onQueued: (info) => queued.push({ phase: 'second', ...info }) });

    // Пока первая задача идёт, вторая не стартовала.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first:start']);

    const waiting = queued.find((entry) => entry.phase === 'second');
    expect(waiting).toBeTruthy();
    expect(waiting.started).toBe(false);
    expect(waiting.position).toBe(1);

    releaseFirst();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('очередь с concurrency=1 никогда не запускает две задачи разом', async () => {
    const queue = createHeavyQueue({ concurrency: 1 });
    let active = 0;
    let maxActive = 0;

    const task = () => queue.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return true;
    });

    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
    expect(queue.stats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('ошибка в задаче не оставляет очередь заблокированной', async () => {
    const queue = createHeavyQueue({ concurrency: 1 });
    const failing = queue.run(async () => { throw new Error('demucs упал'); });
    await expect(failing).rejects.toThrow('demucs упал');
    expect(await queue.run(async () => 'ok')).toBe('ok');
  });
});

describe('Мьютекс (файловый лок)', () => {
  it('второй захват ждёт освобождения', async () => {
    const first = await acquireLock(dir, { name: 'job', pollMs: 10 });
    let secondTaken = false;
    const secondPromise = acquireLock(dir, { name: 'job', pollMs: 10 }).then((handle) => {
      secondTaken = true;
      return handle;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondTaken).toBe(false);

    await first.release();
    const second = await secondPromise;
    expect(secondTaken).toBe(true);
    await second.release();
  });

  it('лок — это каталог с heartbeat, и его видно со стороны', async () => {
    const handle = await acquireLock(dir, { name: 'job' });
    const target = lockPath(dir, 'job');
    const info = await stat(target);
    expect(info.isDirectory()).toBe(true);
    await expect(readLockOwner(dir, 'job')).resolves.toBeTruthy();
    await handle.release();
    await expect(stat(target)).rejects.toThrow();
  });

  it('протухший лок снимается: владелец исчез — система не встаёт', async () => {
    const target = lockPath(dir, 'job');
    await mkdir(target, { recursive: true });
    // Heartbeat в прошлом: владелец не обновляет его дольше порога.
    await writeFile(path.join(target, 'heartbeat'), String(Math.floor(Date.now() / 1000) - 3600), 'utf8');
    await writeFile(path.join(target, 'owner'), JSON.stringify({ name: 'разбор' }), 'utf8');

    const handle = await acquireLock(dir, { name: 'job', pollMs: 10, staleMs: 1000 });
    expect(handle).toBeTruthy();
    await handle.release();
  });

  it('tryAcquireLock не ждёт и честно говорит «занято»', async () => {
    const first = await tryAcquireLock(dir, { name: 'job' });
    expect(first).toBeTruthy();
    const second = await tryAcquireLock(dir, { name: 'job' });
    expect(second).toBeNull();
    await first.release();
    const third = await tryAcquireLock(dir, { name: 'job' });
    expect(third).toBeTruthy();
    await third.release();
  });

  it('ожидание сообщает, кто держит лок', async () => {
    const first = await acquireLock(dir, { name: 'job', label: 'разбор 1234' });
    const waits = [];
    const second = acquireLock(dir, {
      name: 'job',
      pollMs: 10,
      onWait: (info) => waits.push(info),
    });
    // Ждём условие, а не фиксированную паузу: на загруженной машине таймер может
    // отстать, и 40 мс иногда не хватает на первый опрос лока (тест был флаком).
    await waitFor(() => waits.length > 0);
    expect(waits[0].owner).toContain('разбор 1234');
    await first.release();
    await (await second).release();
  });
});
