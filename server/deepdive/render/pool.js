// Пул рендер-воркера: один браузер на сервер, рендеры строго последовательно.
//
// ЗАЧЕМ. Поднимать headless-Chromium на каждый рендер дорого (запуск браузера —
// сотни миллисекунд и ~150 МБ памяти). При этом два рендера «в одном флаконе»
// невозможны: движок Strudel переключает глобальный аудиоконтекст, и рендеры
// перехватывают контекст друг у друга (см. server/deepdive/render/render-worker.mjs).
//
// Поэтому: один воркер + очередь. Очередь важнее параллелизма: сравнение
// слоёв требует, чтобы каждый рендер был завершён до следующего.

import { createRenderWorker } from './render-worker.mjs';

let workerPromise = null;
let queue = Promise.resolve();

/** Создаёт (или отдаёт уже созданный) воркер. */
export async function getRenderWorker() {
  if (!workerPromise) {
    workerPromise = createRenderWorker().catch((err) => {
      workerPromise = null; // не кэшируем поломку — попробуем в следующий раз
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Ставит задачу в очередь рендера. Задачи выполняются строго по очереди.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function enqueueRender(task) {
  const run = queue.then(task, task);
  // Ошибка одной задачи не должна ломать очередь.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

/** Закрывает воркер (при остановке сервера). */
export async function closeRenderWorker() {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  if (worker) await worker.close();
}
