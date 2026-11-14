// Мьютекс тяжёлых операций — механизм, а не правило.
//
// ЗАЧЕМ. На сервере 2 ядра и 3.8 ГБ RAM. Demucs в одиночку помещается
// (RSS ≈ 1.75 ГБ), но две тяжёлые задачи одновременно — это OOM (замер:
// разбор + сборка образа → rc=137). «Не гонять разбор и деплой одновременно»
// как правило в описании не удерживает: правило можно не прочитать. Мьютекс —
// удерживает.
//
// КАК РАБОТАЕТ. Блокировка — атомарное создание каталога (mkdir на POSIX
// атомарен) в общем томе, который видят и приложение, и хост. Внутри —
// файл `heartbeat` с меткой времени: владелец обновляет его каждые 15 секунд,
// поэтому «зависший» лок (упавший процесс) не блокирует систему навсегда —
// после паузы без heartbeat лок считается протухшим и его можно снять.
//
// ПРОТОКОЛ ОБЩИЙ ДЛЯ NODE И ДЛЯ SHELL. Рядом лежит deploy/deploy-server.sh,
// который берёт ТОТ ЖЕ лок перед сборкой образа. Поэтому формат минимален:
//   <dir>/<name>.lock/           — сам лок (каталог)
//   <dir>/<name>.lock/heartbeat  — epoch-секунды последнего обновления
//   <dir>/<name>.lock/owner      — JSON: кто держит (для человека, не для кода)
//
// Файл heavy.lock (flock) держит Python-воркер вокруг запуска Demucs: он
// защищает от двух одновременных разделений даже если они пришли из разных
// процессов. Этот модуль — про лок уровня ЗАДАЧИ (job.lock): пока задача
// идёт, деплой не может пересоздать контейнеры и убить её на середине.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_STALE_MS = 120 * 1000;
const HEARTBEAT_INTERVAL_MS = 15 * 1000;

export class LockTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LockTimeoutError';
    this.details = details;
  }
}

/** Путь лока внутри каталога. */
export function lockPath(dir, name = 'job') {
  return path.join(dir, `${name}.lock`);
}

/** Кто держит лок (для сообщений пользователю). Читает heartbeat, не ломая лок. */
export async function readLockOwner(dir, name = 'job') {
  try {
    const raw = await readFile(path.join(lockPath(dir, name), 'owner'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.name ?? parsed?.pid ?? 'другой процесс';
  } catch {
    return 'другой процесс';
  }
}

async function heartbeatAgeMs(lockDir) {
  try {
    const raw = await readFile(path.join(lockDir, 'heartbeat'), 'utf8');
    const stamp = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(stamp)) return null;
    return Date.now() - stamp * 1000;
  } catch {
    return null;
  }
}

async function writeHeartbeat(lockDir, owner) {
  await writeFile(path.join(lockDir, 'heartbeat'), String(Math.floor(Date.now() / 1000)), 'utf8');
  await writeFile(path.join(lockDir, 'owner'), JSON.stringify(owner), 'utf8');
}

/**
 * Взять мьютекс. Ждёт, если лок занят (и сообщает об ожидании), и снимает
 * протухший лок, если владелец исчез.
 *
 * @param {string} dir каталог локов (общий том)
 * @param {object} options
 * @param {string} [options.name] имя лока ('job' по умолчанию)
 * @param {number} [options.timeoutMs] сколько ждать
 * @param {number} [options.pollMs] пауза между проверками
 * @param {number} [options.staleMs] после какого молчания лок считается протухшим
 * @param {(info:{waitedMs:number, owner:string})=>void} [options.onWait] колбэк ожидания
 * @returns {Promise<{release:()=>Promise<void>, path:string, waitedMs:number}>}
 */
export async function acquireLock(dir, options = {}) {
  const {
    name = 'job',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    staleMs = DEFAULT_STALE_MS,
    onWait,
    label = 'разбор',
    hostName = process.env.HOSTNAME || os.hostname(),
  } = options;

  await mkdir(dir, { recursive: true });
  const target = lockPath(dir, name);
  const owner = { pid: process.pid, host: hostName, name: label, since: new Date().toISOString() };

  const started = Date.now();
  let announced = false;

  for (;;) {
    try {
      await mkdir(target); // атомарно: либо наш каталог, либо чужой
      await writeHeartbeat(target, owner);

      const timer = setInterval(() => {
        writeHeartbeat(target, owner).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      timer.unref?.();

      let released = false;
      return {
        path: target,
        waitedMs: Date.now() - started,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(timer);
          await rm(target, { recursive: true, force: true }).catch(() => {});
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    // Лок занят. Если владелец молчит дольше staleMs — лок протух: снимаем.
    const age = await heartbeatAgeMs(target);
    if (age !== null && age > staleMs) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    const waited = Date.now() - started;
    if (!announced) {
      announced = true;
      const holder = await readLockOwner(dir, name);
      onWait?.({ waitedMs: waited, owner: holder });
    }
    if (waited >= timeoutMs) {
      const holder = await readLockOwner(dir, name);
      throw new LockTimeoutError(
        `Мьютекс занят другим процессом (${holder}) — ждали ${Math.round(waited / 1000)} с`,
        { waitedMs: waited, owner: holder },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Взять мьютекс, если он свободен; иначе — null (не ждём).
 * Используется там, где «занято» — это нормальное состояние, а не ошибка.
 */
export async function tryAcquireLock(dir, options = {}) {
  const { name = 'job', label = 'разбор' } = options;
  await mkdir(dir, { recursive: true });
  const target = lockPath(dir, name);
  try {
    await mkdir(target);
  } catch (err) {
    if (err?.code === 'EEXIST') return null;
    throw err;
  }
  const owner = { pid: process.pid, host: os.hostname(), name: label, since: new Date().toISOString() };
  await writeHeartbeat(target, owner);
  const timer = setInterval(() => {
    writeHeartbeat(target, owner).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    path: target,
    release: async () => {
      clearInterval(timer);
      await rm(target, { recursive: true, force: true }).catch(() => {});
    },
  };
}
