// Локальный демон Strudel AI Composer.
//
// Shebang здесь намеренно отсутствует: файл импортируется тестами, а
// vite SSR-трансформ при CRLF поднимает импорты выше `#!` и ломает парсинг
// (на LF/LINUX дефект не виден). Запуск всегда через `node local/daemon.mjs`.
//
// ЗАЧЕМ ОН. Тяжёлое считается на машине владельца: рендер, разделение на
// стемы, анализ (D-097). Сервер остаётся витриной и оркестратором, LLM —
// в облаке. На сервере 2 vCPU дают 207–396 с на минуту аудио, то есть 56.4
// минуты на 4-минутный трек: цикл «спросил → услышал» там невозможен.
//
// ЧТО ОН УМЕЕТ.
//   • очередь задач на диске: обрыв связи или перезапуск демона не теряют
//     задачу (local/queue.mjs);
//   • прогресс по каждой задаче в SSE — тем же протоколом, что и весь проект;
//   • авторизация по токену: демон не открыт в сеть без токена;
//   • офлайн-режим: демон работает сам, без сервера.
//
// ЗАПУСК.
//   LOCAL_DAEMON_TOKEN=<длинный случайный токен> node local/daemon.mjs
//   Порт: LOCAL_DAEMON_PORT (по умолчанию 3213). Адрес: 127.0.0.1.
//
// БЕЗОПАСНОСТЬ ПО УМОЛЧАНИЮ. Если токен не задан, демон НЕ стартует: молча
// открытый в сеть рендерер — это дыра. Можно задать LOCAL_DAEMON_ALLOW_ANON=1
// только для локальных экспериментов.

import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DurableQueue } from './queue.mjs';
import { createTaskRegistry } from './tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PORT = Number(process.env.LOCAL_DAEMON_PORT || 3213);
const HOST = process.env.LOCAL_DAEMON_HOST || '127.0.0.1';
const TOKEN = process.env.LOCAL_DAEMON_TOKEN || '';
const ALLOW_ANON = process.env.LOCAL_DAEMON_ALLOW_ANON === '1';
const STATE_DIR = process.env.LOCAL_DAEMON_STATE || path.join(ROOT, 'local', '.state');
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('тело запроса слишком велико'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {http.IncomingMessage} req
 * @param {string} token
 * @returns {boolean}
 */
function authorized(req, token) {
  if (ALLOW_ANON) return true;
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  // Сравнение постоянного времени: токен — секрет, и его нельзя перебирать
  // по времени ответа.
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/**
 * Собирает демон.
 * @returns {Promise<{server:http.Server, queue:DurableQueue, registry:object}>}
 */
export async function createDaemon({
  token = TOKEN, stateDir = STATE_DIR, log = console.log, renderFactory, analysisProbe, referenceAnalyzer,
} = {}) {
  const registry = createTaskRegistry({ stateDir, renderFactory, analysisProbe, referenceAnalyzer });
  const queue = new DurableQueue({
    dir: stateDir,
    concurrency: 1,
    onEvent: (event) => {
      // Жизнь очереди видна в консоли демона: владелец должен видеть, что
      // задача принята, идёт и завершилась, даже если интерфейс отвалился.
      if (event.type === 'queue_restored') {
        log(`[local] после перезапуска возвращено задач: ${event.restored}`);
        return;
      }
      if (event.type === 'task_added') log(`[local] принята задача ${event.task.id} (${event.task.type})`);
      if (event.type === 'task_started') log(`[local] задача ${event.task.id} в работе`);
      if (event.type === 'task_done') log(`[local] задача ${event.task.id} готова`);
      if (event.type === 'task_error') log(`[local] задача ${event.task.id} упала: ${event.task.error}`);
    },
    handler: (task, helpers) => {
      if (task.type === 'analyze_reference') {
        const sourceTaskId = task.payload?.sourceTaskId;
        if (typeof sourceTaskId !== 'string' || !sourceTaskId.trim()) {
          throw new Error('analyze_reference: нужен sourceTaskId зарегистрированной задачи');
        }
        const source = queue.get(sourceTaskId);
        if (!source) throw new Error('analyze_reference: sourceTaskId не найден в очереди');
        if (source.state !== 'done') throw new Error('analyze_reference: задача источника должна быть done');
        if (!['analyze', 'passport', 'render'].includes(source.type)) {
          throw new Error('analyze_reference: источник должен иметь тип analyze, passport или render');
        }
        // Публичный снимок скрывает payload; путь берём из внутренней записи владельца.
        const registered = queue.tasks.get(sourceTaskId);
        const filePath = source.type === 'render' ? source.result?.wavPath : registered?.payload?.path;
        if (typeof filePath !== 'string' || !filePath.trim()) {
          throw new Error('analyze_reference: у готовой задачи источника нет зарегистрированного WAV');
        }
        const payload = {
          path: filePath,
          outDir: path.join(stateDir, 'references', task.id, 'stems'),
        };
        return registry.tasks.analyze_reference(payload, helpers);
      }
      const runner = registry.tasks[task.type];
      if (!runner) {
        return Promise.reject(new Error(`неизвестный тип задачи: ${task.type}`));
      }
      // Рендер без своего пути пишет WAV в каталог рендеров демона: только
      // оттуда аудио отдаётся наружу (маршрут /tasks/:id/audio). Чужой путь
      // клиента остаётся возможным для записи, но не для чтения через HTTP.
      if (task.type === 'render' && !task.payload?.outPath) {
        task.payload = { ...task.payload, outPath: path.join(stateDir, 'renders', `${task.id}.wav`) };
      }
      return runner(task.payload, helpers);
    },
  });
  await queue.init();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (!authorized(req, token)) {
      sendJson(res, 401, { error: 'нужен токен: Authorization: Bearer <LOCAL_DAEMON_TOKEN>' });
      return;
    }

    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        const health = await registry.health();
        sendJson(res, 200, {
          ok: true,
          service: 'strudel-local-daemon',
          version: '0.2.0',
          machine: {
            platform: process.platform,
            arch: process.arch,
            cpus: os.cpus().length,
            totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
            node: process.version,
          },
          ...health,
          queue: queue.stats(),
        });
        return;
      }

      if (url.pathname === '/tasks' && req.method === 'GET') {
        sendJson(res, 200, { tasks: queue.list(), stats: queue.stats() });
        return;
      }

      if (url.pathname === '/tasks' && req.method === 'POST') {
        const raw = await readBody(req);
        let payload = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { error: 'тело запроса — не JSON' });
          return;
        }
        const type = String(payload.type ?? '').trim();
        if (!registry.tasks[type]) {
          sendJson(res, 400, {
            error: `неизвестный тип задачи: ${type || '—'}`,
            available: registry.types(),
          });
          return;
        }
        const task = await queue.enqueue(type, payload.payload ?? {});
        sendJson(res, 202, { id: task.id, type: task.type, state: task.state });
        return;
      }

      const taskMatch = /^\/tasks\/([\w-]+)(\/stream|\/audio)?$/.exec(url.pathname);
      if (taskMatch) {
        const [, id, suffix] = taskMatch;
        const task = queue.get(id);
        if (!task) {
          sendJson(res, 404, { error: `задача не найдена: ${id}` });
          return;
        }
        if (suffix === '/audio') {
          // WAV готового рендера — чтобы результат можно было услышать,
          // а не только увидеть в метриках. Отдаём только файлы из каталога
          // рендеров демона: путь из задачи не должен читать произвольные
          // файлы машины.
          const wavPath = task.result?.wavPath ? path.resolve(String(task.result.wavPath)) : null;
          const rendersDir = path.resolve(stateDir, 'renders');
          if (task.state !== 'done' || !wavPath || !wavPath.startsWith(`${rendersDir}${path.sep}`)) {
            sendJson(res, 404, { error: 'аудио недоступно: рендер не завершён или файл вне каталога рендеров' });
            return;
          }
          if (!existsSync(wavPath)) {
            sendJson(res, 404, { error: 'файл рендера не найден на диске' });
            return;
          }
          res.writeHead(200, {
            'content-type': 'audio/wav',
            'content-length': statSync(wavPath).size,
            'cache-control': 'no-store',
          });
          createReadStream(wavPath).pipe(res);
          return;
        }
        if (suffix === '/stream') {
          // SSE: события задачи по мере их появления. Отдельный поток, чтобы
          // долгая задача не блокировала обычные запросы.
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          const write = (event) => {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          };
          write({ type: 'snapshot', task });
          const unsubscribe = queue.subscribe(id, write);
          const timer = setInterval(() => {
            const current = queue.get(id);
            if (!current) return;
            if (current.state === 'done' || current.state === 'error') {
              write({ type: current.state, task: current });
              clearInterval(timer);
              unsubscribe();
              res.end();
            }
          }, 500);
          req.on('close', () => {
            clearInterval(timer);
            unsubscribe();
          });
          return;
        }
        sendJson(res, 200, { task });
        return;
      }

      sendJson(res, 404, { error: `нет маршрута: ${url.pathname}` });
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message || err) });
    }
  });

  return { server, queue, registry };
}

// Прямой запуск: node local/daemon.mjs
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!TOKEN && !ALLOW_ANON) {
    console.error(
      '✗ LOCAL_DAEMON_TOKEN не задан. Демон без токена открыт в сеть — это дыра.\n'
      + '  Задайте токен: LOCAL_DAEMON_TOKEN=<случайная строка> node local/daemon.mjs\n'
      + '  Для локальных экспериментов: LOCAL_DAEMON_ALLOW_ANON=1 node local/daemon.mjs',
    );
    process.exit(1);
  }
  const { server, registry } = await createDaemon();
  server.listen(PORT, HOST, () => {
    console.log(`[local] демон слушает http://${HOST}:${PORT} (очередь: ${STATE_DIR})`);
  });
  const shutdown = async () => {
    server.close();
    setTimeout(() => process.exit(0), 2000).unref();
    await registry.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
