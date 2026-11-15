// Очередь задач локального демона.
//
// ЗАЧЕМ ОНА НЕ В ПАМЯТИ. Демон живёт на машине владельца, а связь с сервером
// может пропасть в любой момент: компьютер уснул, Wi-Fi переподключился,
// сервер перезапустился. Если очередь хранится в памяти процесса, задача,
// принятая перед обрывом, пропадает молча — а это ровно те минуты рендера,
// ради которых всё и затевалось.
//
// ПОЭТОМУ ОЧЕРЕДЬ — НА ДИСКЕ. Append-only журнал (JSONL): каждая задача и
// каждый её финал — строка. При старте демон перечитывает журнал и заново
// ставит в работу всё, у чего нет терминальной записи. Задача не теряется
// ни при обрыве связи, ни при перезапуске демона.
//
// ЧЕСТНОСТЬ СОСТОЯНИЙ. Задача в очереди, задача в работе и задача с
// результатом — разные состояния, и они видны клиенту. Молчание на экране
// («ничего не происходит») — худший вариант: пользователь не знает, ждать
// ещё минуту или десять.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Состояния задачи. Терминальные — done и error. */
export const TASK_STATES = ['queued', 'running', 'done', 'error'];

/**
 * @typedef {object} TaskRecord
 * @property {string} id
 * @property {string} type
 * @property {object} payload
 * @property {number} enqueuedAt
 * @property {string} state
 * @property {object|null} result
 * @property {string|null} error
 * @property {number|null} startedAt
 * @property {number|null} finishedAt
 */

export class DurableQueue {
  /**
   * @param {{dir:string, concurrency?:number, onEvent?:(event:object)=>void,
   *          handler?:(task:TaskRecord, helpers:{progress:(event:object)=>void})=>Promise<object>}} options
   */
  constructor({ dir, concurrency = 1, onEvent = () => {}, handler = null }) {
    this.dir = dir;
    this.concurrency = concurrency;
    this.onEvent = onEvent;
    this.handler = handler;
    /** @type {Map<string, TaskRecord>} */
    this.tasks = new Map();
    /** @type {Array<string>} */
    this.pending = [];
    this.active = 0;
    this.journalPath = path.join(dir, 'queue.jsonl');
    /** @type {Map<string, (event:object)=>void>} */
    this.listeners = new Map();
  }

  /**
   * Поднимает очередь: читает журнал и возвращает в работу незавершённое.
   * @returns {Promise<{restored:number}>}
   */
  async init() {
    await mkdir(this.dir, { recursive: true });
    let raw = '';
    try {
      raw = await readFile(this.journalPath, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    let restored = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // Битая строка журнала не должна ронять демон: пропускаем её.
        continue;
      }
      if (record.k === 't') {
        this.tasks.set(record.id, {
          id: record.id,
          type: record.type,
          payload: record.payload ?? {},
          enqueuedAt: record.enqueuedAt ?? Date.now(),
          state: 'queued',
          result: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        });
      } else if (record.k === 'r') {
        const task = this.tasks.get(record.id);
        if (!task) continue;
        task.state = record.status === 'done' ? 'done' : 'error';
        task.result = record.result ?? null;
        task.error = record.error ?? null;
        task.finishedAt = record.finishedAt ?? Date.now();
      }
    }
    // Незавершённые задачи возвращаются в очередь — обрыв связи их не убил.
    for (const task of this.tasks.values()) {
      if (task.state === 'queued' || task.state === 'running') {
        task.state = 'queued';
        this.pending.push(task.id);
        restored += 1;
      }
    }
    if (restored) {
      this.onEvent({ type: 'queue_restored', restored });
      this.drain();
    }
    return { restored };
  }

  /**
   * Кладёт задачу в очередь и пишет её в журнал.
   * @param {string} type
   * @param {object} payload
   * @returns {Promise<TaskRecord>}
   */
  async enqueue(type, payload = {}) {
    const id = randomUUID();
    const task = {
      id,
      type,
      payload,
      enqueuedAt: Date.now(),
      state: 'queued',
      result: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    };
    this.tasks.set(id, task);
    this.pending.push(id);
    await this.append({ k: 't', id, type, payload, enqueuedAt: task.enqueuedAt });
    this.onEvent({ type: 'task_added', task: this.publicTask(task) });
    this.drain();
    // Снимок на момент приёма: к моменту сериализации ответа задача уже может
    // быть в работе, а клиенту нужно знать, что её ПРИНЯЛИ.
    return { ...task };
  }

  /**
   * @param {TaskRecord} task
   * @returns {TaskRecord}
   */
  publicTask(task) {
    return {
      id: task.id,
      type: task.type,
      state: task.state,
      enqueuedAt: task.enqueuedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      error: task.error,
      result: task.result,
      position: task.state === 'queued' ? this.pending.indexOf(task.id) : null,
    };
  }

  /**
   * @param {string} id
   * @returns {TaskRecord|null}
   */
  get(id) {
    const task = this.tasks.get(id);
    return task ? this.publicTask(task) : null;
  }

  /** @returns {TaskRecord[]} */
  list() {
    return [...this.tasks.values()]
      .sort((a, b) => b.enqueuedAt - a.enqueuedAt)
      .map((task) => this.publicTask(task));
  }

  /** @returns {{total:number, queued:number, running:number, done:number, error:number}} */
  stats() {
    const stats = { total: this.tasks.size, queued: 0, running: 0, done: 0, error: 0 };
    for (const task of this.tasks.values()) stats[task.state] += 1;
    return stats;
  }

  /**
   * Подписка на события задачи. Возвращает функцию отписки.
   * @param {string} id
   * @param {(event:object)=>void} listener
   * @returns {() => void}
   */
  subscribe(id, listener) {
    this.listeners.set(id, listener);
    return () => this.listeners.delete(id);
  }

  /**
   * Публикует событие задачи (прогресс, стадия).
   * @param {string} id
   * @param {object} event
   */
  publish(id, event) {
    const listener = this.listeners.get(id);
    if (listener) listener({ id, ...event });
    this.onEvent({ id, ...event });
  }

  /**
   * Запускает задачи, пока есть свободные слоты.
   * @param {(task:TaskRecord, helpers:{progress:(event:object)=>void})=>Promise<object>} [handler]
   */
  drain(handler = this.handler) {
    if (!handler) return;
    while (this.active < this.concurrency && this.pending.length) {
      const id = this.pending.shift();
      const task = this.tasks.get(id);
      if (!task || task.state !== 'queued') continue;
      this.active += 1;
      task.state = 'running';
      task.startedAt = Date.now();
      this.onEvent({ type: 'task_started', task: this.publicTask(task) });
      Promise.resolve()
        .then(() => handler(task, {
          progress: (event) => this.publish(id, { type: 'progress', ...event }),
        }))
        .then(
          async (result) => {
            this.active -= 1;
            task.state = 'done';
            task.result = result ?? null;
            task.finishedAt = Date.now();
            await this.append({
              k: 'r', id: task.id, status: 'done', result: task.result, finishedAt: task.finishedAt,
            });
            this.onEvent({ type: 'task_done', task: this.publicTask(task) });
            this.drain(handler);
          },
          async (err) => {
            this.active -= 1;
            task.state = 'error';
            task.error = String(err?.message || err);
            task.finishedAt = Date.now();
            await this.append({
              k: 'r', id: task.id, status: 'error', error: task.error, finishedAt: task.finishedAt,
            });
            this.onEvent({ type: 'task_error', task: this.publicTask(task) });
            this.drain(handler);
          },
        );
    }
  }

  /**
   * Дописывает запись в журнал. Ошибка записи — не повод ронять задачу:
   * результат всё равно отдан клиенту, но очередь на диске разойдётся с
   * памятью, поэтому ошибку логируем.
   * @param {object} record
   */
  async append(record) {
    try {
      await appendFile(this.journalPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (err) {
      console.error('[local] журнал очереди недоступен:', err?.message || err);
    }
  }
}
