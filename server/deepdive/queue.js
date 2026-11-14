// Очередь тяжёлых операций.
//
// ЗАЧЕМ. Разделение на стемы (Demucs) — единственная операция, которая на
// этом железе способна положить сервер: 1.75 ГБ RSS на треке, две сразу —
// OOM. Поэтому тяжёлые операции идут строго по одной, а вторая задача не
// падает и не стартует, а ЖДЁТ — с честным статусом «в очереди».
//
// Смысл очереди — не «красивая подсветка», а два свойства:
//   1. Второй разбор не начинает тяжёлую работу, пока первая не кончила;
//   2. Пользователь второго разбора видит, ЧТО происходит («в очереди,
//      ждём разбор №1»), а не молчание.
//
// МЬЮТЕКС — отдельный механизм (server/deepdive/lock.js): он держит лок на
// уровне задачи и не даёт деплою пересоздать контейнеры посреди разбора.
// Очередь и мьютекс дополняют друг друга: очередь — внутри процесса, мьютекс —
// между процессами и контейнерами.

/**
 * @param {object} [options]
 * @param {number} [options.concurrency] сколько тяжёлых операций одновременно
 * @param {string} [options.name] имя очереди (для сообщений)
 */
export function createHeavyQueue({ concurrency = 1, name = 'тяжёлая операция' } = {}) {
  let active = 0;
  /** @type {Array<{task:Function, resolve:Function, reject:Function, onQueued:Function, label:string}>} */
  const waiting = [];

  function drain() {
    while (active < concurrency && waiting.length) {
      const entry = waiting.shift();
      active += 1;
      // Статус ожидания снимаем сразу, как только операция встала в работу.
      entry.onQueued?.({ started: true, position: 0, waiting: 0 });
      Promise.resolve()
        .then(() => entry.task())
        .then(
          (value) => {
            active -= 1;
            entry.resolve(value);
            drain();
          },
          (err) => {
            active -= 1;
            entry.reject(err);
            drain();
          },
        );
    }
  }

  return {
    name,

    /**
     * Поставить тяжёлую операцию в очередь.
     *
     * @param {Function} task операция
     * @param {{onQueued?:(info:{position:number, waiting:number, started:boolean})=>void, label?:string}} [options]
     */
    run(task, options = {}) {
      const { onQueued, label = '' } = options;
      if (active < concurrency) {
        return new Promise((resolve, reject) => {
          active += 1;
          onQueued?.({ started: true, position: 0, waiting: 0 });
          Promise.resolve()
            .then(() => task())
            .then(
              (value) => {
                active -= 1;
                resolve(value);
                drain();
              },
              (err) => {
                active -= 1;
                reject(err);
                drain();
              },
            );
        });
      }

      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject, onQueued, label });
        // Сообщаем позицию в очереди сразу — «в очереди» должно быть видно.
        onQueued?.({ started: false, position: waiting.length, waiting: waiting.length });
      });
    },

    /** Состояние очереди — для /api/deepdive/health и диагностики. */
    stats() {
      return { name, concurrency, active, waiting: waiting.length };
    },
  };
}

/** Очередь по умолчанию: одна тяжёлая операция одновременно. */
export const separationQueue = createHeavyQueue({ concurrency: 1, name: 'разделение на стемы' });
