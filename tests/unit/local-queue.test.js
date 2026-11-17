// Локальный демон: очередь переживает обрыв связи и перезапуск.
//
// ГЛАВНОЕ СВОЙСТВО. Демон живёт на машине владельца, и связь с сервером
// рвётся. Если принятая задача пропадает — пропадают минуты рендера, ради
// которых всё затевалось. Поэтому очередь хранится на диске, и после
// перезапуска демона незавершённые задачи возвращаются в работу.
//
// МОК ТЯЖЁЛОЙ РАБОТЫ. Рендер подменён: настоящий требует браузера и
// минуты времени. Проверяется механика очереди, а не рендер.

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DurableQueue } from '../../local/queue.mjs';

/** Временный каталог под состояние очереди. */
async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'local-queue-'));
}

/**
 * Ждёт, пока задача дойдёт до терминального состояния.
 * @param {DurableQueue} queue
 * @param {string} id
 * @param {number} timeoutMs
 */
async function waitTerminal(queue, id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = queue.get(id);
    if (task && (task.state === 'done' || task.state === 'error')) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('задача не дошла до финального состояния');
}

/**
 * Ждёт события, удовлетворяющего предикату. Возвращает true/false.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ОЖИДАЛКА. Состояние задачи становится 'done' ДО того,
 * как очередь допишет журнал и отправит событие 'task_done'
 * (local/queue.mjs:230 против :236). Поэтому «дождался финального
 * состояния» ≠ «событие уже дошло»: между этими двумя моментами стоит
 * await журнала. Под нагрузкой полного прогона дописывание задерживалось
 * на миллисекунды — и проверка падала. Ждём именно событие; сила
 * проверки не меняется (событие обязано прийти за отведённое время).
 *
 * @param {object[]} events
 * @param {(event:object)=>boolean} predicate
 * @param {number} timeoutMs
 */
async function waitForEvent(events, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('очередь демона', () => {
  it('задача выполняется и её результат виден', async () => {
    const dir = await tempDir();
    const queue = new DurableQueue({
      dir,
      handler: async (task) => ({ echo: task.payload.value ?? null }),
    });
    await queue.init();
    const task = await queue.enqueue('test', { value: 42 });
    const finished = await waitTerminal(queue, task.id);
    expect(finished.state).toBe('done');
    expect(finished.result).toEqual({ echo: 42 });
    await rm(dir, { recursive: true, force: true });
  });

  it('задача переживает перезапуск демона: незавершённая возвращается в работу', async () => {
    const dir = await tempDir();

    // Первый «демон»: задача принята, но рабочая функция никогда не
    // завершается — как если бы демон выключили посреди рендера.
    const first = new DurableQueue({
      dir,
      handler: () => new Promise(() => {}),
    });
    await first.init();
    const task = await first.enqueue('render', { code: 'setCpm(120/4)' });
    expect(first.get(task.id).state).toBe('running');

    // Второй «демон» — тот же каталог состояния.
    let ran = false;
    const second = new DurableQueue({
      dir,
      handler: async (restored) => {
        ran = true;
        return { restored: restored.id === task.id };
      },
    });
    const { restored } = await second.init();
    expect(restored).toBe(1);
    const finished = await waitTerminal(second, task.id);
    expect(ran).toBe(true);
    expect(finished.state).toBe('done');
    expect(finished.result.restored).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('выполненная задача не выполняется заново после перезапуска', async () => {
    const dir = await tempDir();
    const first = new DurableQueue({
      dir,
      handler: async () => ({ ok: true }),
    });
    await first.init();
    const task = await first.enqueue('render', {});
    await waitTerminal(first, task.id);

    let ranAgain = false;
    const second = new DurableQueue({
      dir,
      handler: async () => {
        ranAgain = true;
        return { ok: true };
      },
    });
    const { restored } = await second.init();
    expect(restored).toBe(0);
    expect(ranAgain).toBe(false);
    expect(second.get(task.id).state).toBe('done');
    await rm(dir, { recursive: true, force: true });
  });

  it('ошибка задачи не теряется: состояние error и причина', async () => {
    const dir = await tempDir();
    const queue = new DurableQueue({
      dir,
      handler: async () => {
        throw new Error('рендер упал');
      },
    });
    await queue.init();
    const task = await queue.enqueue('render', {});
    const finished = await waitTerminal(queue, task.id);
    expect(finished.state).toBe('error');
    expect(finished.error).toMatch(/рендер упал/);
    await rm(dir, { recursive: true, force: true });
  });

  it('очередь на диске: журнал читаем и содержит задачу и её финал', async () => {
    const dir = await tempDir();
    const queue = new DurableQueue({ dir, handler: async () => ({ ok: 1 }) });
    await queue.init();
    const task = await queue.enqueue('render', { a: 1 });
    await waitTerminal(queue, task.id);
    const journal = await readFile(path.join(dir, 'queue.jsonl'), 'utf8');
    const lines = journal.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.some((line) => line.k === 't' && line.id === task.id)).toBe(true);
    expect(lines.some((line) => line.k === 'r' && line.id === task.id && line.status === 'done')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('события прогресса доходят до слушателя', async () => {
    const dir = await tempDir();
    // Подписка идёт через общую шину событий очереди: она срабатывает и на
    // прогрессе, и на старте, и на финале — поэтому гонки «подписка после
    // старта задачи» не возникает.
    const events = [];
    const queue = new DurableQueue({
      dir,
      onEvent: (event) => events.push(event),
      handler: async (_task, helpers) => {
        helpers.progress({ stage: 'render', message: 'рендерим' });
        return { ok: true };
      },
    });
    await queue.init();
    const task = await queue.enqueue('render', {});
    await waitTerminal(queue, task.id);
    expect(
      await waitForEvent(events, (event) => event.type === 'progress' && event.stage === 'render'),
    ).toBe(true);
    expect(await waitForEvent(events, (event) => event.type === 'task_done')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});
