// Хранилище задач разбора.
//
// ЗАЧЕМ НЕ ТОЛЬКО ПАМЯТЬ. Разбор на CPU идёт десятки минут. Пользователь
// закрыл вкладку (или пропала связь) — задача должна жить дальше, а результат
// должен быть доступен по прямой ссылке. Поэтому итог задачи пишется на диск
// рядом с её рабочей папкой: `<root>/<job-id>/job.json`.
//
// ЧТО ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК, А ЧТО НЕТ.
//   * Готовый результат — переживает перезапуск сервера (лежит на диске).
//   * Незаконченная задача — не переживает: процесс, который её вёл, убит.
//     Это не прячем: после перезапуска GET отдаёт 404, и клиент пишет об этом
//     пользователю честно.
//
// ИДЕНТИФИКАТОР И ТОКЕН. UUID из randomUUID() — идентификатор задачи,
// аккаунтов нет. Но одного идентификатора мало: по ссылке видно весь
// отчёт, поэтому доступ подтверждается ещё и токеном (см. access.js).
// Токен пишется в job.json — ссылка переживает перезапуск сервера.

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {object} options
 * @param {string} options.root корневой каталог рабочих папок задач
 * @param {number} [options.ttlMs] сколько живёт задача после завершения
 */
export function createJobStore({ root, ttlMs = DEFAULT_TTL_MS } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map();

  function workspaceDir(id) {
    return path.join(root, id);
  }

  function recordPath(id) {
    return path.join(workspaceDir(id), 'job.json');
  }

  /** Записать состояние задачи на диск (атомарно: tmp + rename). */
  async function save(job) {
    if (!job?.id) return;
    const dir = workspaceDir(job.id);
    const record = {
      id: job.id,
      status: job.status,
      progress: job.progress ?? 0,
      createdAt: job.createdAt ?? Date.now(),
      finishedAt: job.finishedAt ?? null,
      fileName: job.fileName ?? null,
      model: job.model ?? null,
      separate: Boolean(job.separate),
      // Токен доступа: без него отчёт не отдаётся даже тому, кто знает id.
      accessToken: job.accessToken ?? null,
      error: job.error ?? null,
      result: job.result ?? null,
      artifacts: {
        twinWavPath: job.artifacts?.twinWavPath ?? null,
        originalWavPath: job.artifacts?.originalWavPath ?? null,
        totalBars: job.artifacts?.totalBars ?? null,
        // Ритм нужен экспорту MIDI после перезапуска: без него ударные
        // пропадают из файла у того, кто открыл разбор по ссылке.
        rhythm: job.artifacts?.rhythm ?? null,
        stemPaths: job.artifacts?.stemPaths ?? null,
      },
    };
    try {
      await mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `job.json.tmp-${process.pid}`);
      await writeFile(tmp, JSON.stringify(record), 'utf8');
      await rename(tmp, recordPath(job.id));
    } catch {
      // Диск мог кончиться или папку уже убрали по TTL: задача продолжает
      // жить в памяти, permalink просто не переживёт перезапуск.
    }
  }

  /** Прочитать задачу с диска (если её больше нет в памяти). */
  async function load(id) {
    try {
      const raw = await readFile(recordPath(id), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed?.id) return null;
      return { ...parsed, fromDisk: true };
    } catch {
      return null;
    }
  }

  return {
    root,

    /** Завести новую задачу. */
    create(fields) {
      const job = {
        id: fields.id,
        status: fields.status ?? 'running',
        progress: fields.progress ?? 0,
        createdAt: fields.createdAt ?? Date.now(),
        finishedAt: null,
        fileName: fields.fileName ?? null,
        model: fields.model ?? null,
        separate: Boolean(fields.separate),
        accessToken: fields.accessToken ?? null,
        workspaceDir: fields.workspaceDir ?? workspaceDir(fields.id),
        inputPath: fields.inputPath ?? null,
        result: null,
        artifacts: null,
        error: null,
      };
      jobs.set(job.id, job);
      return job;
    },

    /** Задача из памяти (без обращения к диску). */
    peek(id) {
      return jobs.get(id) ?? null;
    },

    /** Задача из памяти; если её там нет — с диска. */
    async get(id) {
      const memory = jobs.get(id);
      if (memory) return memory;
      return load(id);
    },

    /** Сохранить на диск. */
    save,

    /** Убрать задачу из памяти и с диска. */
    async remove(id) {
      jobs.delete(id);
      await rm(workspaceDir(id), { recursive: true, force: true }).catch(() => {});
    },

    /** Убрать задачи, ушедшие за TTL. */
    async prune(now = Date.now()) {
      const removed = [];
      for (const [id, job] of jobs) {
        const stamp = job.finishedAt ?? job.createdAt;
        if (now - stamp < ttlMs) continue;
        jobs.delete(id);
        await rm(workspaceDir(id), { recursive: true, force: true }).catch(() => {});
        removed.push(id);
      }
      return removed;
    },

    /** Сколько задач в памяти (для диагностики). */
    size() {
      return jobs.size;
    },
  };
}

/**
 * Есть ли на диске папка задачи — используется в /api/deepdive/health,
 * чтобы отличить «задача ещё в памяти» от «результат лежит на диске».
 */
export async function jobRecordExists(root, id) {
  try {
    await stat(path.join(root, id, 'job.json'));
    return true;
  } catch {
    return false;
  }
}
