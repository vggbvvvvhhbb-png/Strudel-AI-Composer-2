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
//
// ГРАНИЦА ДОВЕРИЯ (это не косметика, это четыре независимых фильтра).
//   1. Host-заголовок: только 127.0.0.1:PORT, localhost:PORT, [::1]:PORT.
//      Зачем: защита от DNS rebinding — страница злоумышленника может
//      обращаться к 127.0.0.1, но пришлёт Host: attacker.example.
//   2. Origin-заголовок: пустой допустим (серверный прокси Origin не шлёт),
//      непустой должен быть локальным или перечисленным в
//      LOCAL_DAEMON_ALLOWED_ORIGINS.
//   3. Токен: Bearer, сравнение постоянного времени.
//   4. Тело запроса: не больше 8 МБ, только application/json, payload строго
//      по схеме типа задачи.

import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DurableQueue, DEFAULT_TTL_MS } from './queue.mjs';
import { createTaskRegistry } from './tasks.mjs';
import { TASK_REQUEST_SCHEMA, validateTaskPayload } from './schemas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PORT = Number(process.env.LOCAL_DAEMON_PORT || 3213);
const HOST = process.env.LOCAL_DAEMON_HOST || '127.0.0.1';
const TOKEN = process.env.LOCAL_DAEMON_TOKEN || '';
const ALLOW_ANON = process.env.LOCAL_DAEMON_ALLOW_ANON === '1';
const STATE_DIR = process.env.LOCAL_DAEMON_STATE || path.join(ROOT, 'local', '.state');
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Приём задач: сколько за окно (окно — минута). */
const RATE_LIMIT = { windowMs: 60_000, max: Number(process.env.LOCAL_DAEMON_RATE_MAX || 30) };

/** Минимальная длина токена: меньше 32 символов — предупреждение при старте. */
const MIN_TOKEN_LENGTH = 32;

/** Сколько живут завершённые задачи (6 часов). */
const TASK_TTL_MS = Number(process.env.LOCAL_DAEMON_TASK_TTL_MS || DEFAULT_TTL_MS);

/** Локальные имена хоста: демон слушает петлю, и запросы приходят только оттуда. */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Дополнительные доверенные Host (через запятую) — нужно для LAN-режима. */
const EXTRA_HOSTS = new Set(
  String(process.env.LOCAL_DAEMON_ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

/** Дополнительные доверенные Origin (через запятую) — домен студии. */
const EXTRA_ORIGINS = new Set(
  String(process.env.LOCAL_DAEMON_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {Record<string,string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

/**
 * Читает тело запроса. Превышение лимита — это 413, а не 500: клиент
 * прислал слишком много, и это его ошибка, а не сбой демона.
 *
 * Тело после превышения дочитывается, но не копится: иначе клиент получит
 * разрыв соединения вместо внятного ответа 413.
 *
 * @param {http.IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        chunks.length = 0;
        const err = new Error('тело запроса слишком велико');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * Имя хоста из заголовка Host: без IPv6-скобок и без порта.
 * @param {string} host
 * @returns {string}
 */
function hostnameOf(host) {
  const value = String(host || '').trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(1, end);
  }
  return value.split(':')[0];
}

/**
 * Список допустимых значений Host-заголовка для текущего порта.
 * @param {number} port
 * @param {string} host
 * @param {Set<string>} [extra]
 * @returns {Set<string>}
 */
function hostAllowList(port, host, extra = EXTRA_HOSTS) {
  const set = new Set();
  for (const name of [host, '127.0.0.1', 'localhost', '[::1]']) {
    if (!name) continue;
    set.add(`${name}:${port}`.toLowerCase());
  }
  for (const value of extra) set.add(value.toLowerCase());
  return set;
}

/**
 * Хост-заголовок: демон отвечает только на локальные имена и на свой порт.
 * Зачем: защита от DNS rebinding — страница злоумышленника может
 * обращаться к 127.0.0.1, но пришлёт Host: attacker.example.
 * @param {http.IncomingMessage} req
 * @param {Set<string>} allowedHosts
 * @returns {boolean}
 */
function hostAllowed(req, allowedHosts) {
  const raw = String(req.headers.host || '').trim().toLowerCase();
  if (!raw) return false;
  if (allowedHosts.has(raw)) return true;
  // Запасной путь: хост без указания порта (бывает у старых клиентов).
  return allowedHosts.has(hostnameOf(raw));
}

/**
 * Origin-заголовок: пустой — это серверный прокси (он Origin не шлёт),
 * и он допустим. Непустой должен быть локальным: CORS сам по себе не
 * авторизует, но чужой Origin не должен доходить до демона вовсе.
 * @param {http.IncomingMessage} req
 * @param {Set<string>} allowedOrigins
 * @returns {boolean}
 */
function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const value = String(origin).trim().toLowerCase();
  if (allowedOrigins.has(value)) return true;
  try {
    const url = new URL(value);
    return LOCAL_HOSTNAMES.has(hostnameOf(url.host));
  } catch {
    return false;
  }
}

/**
 * Окно приёма задач: сколько запросов на ключ (токен или IP) за минуту.
 * @param {Map<string, number[]>} buckets
 * @param {string} key
 * @param {{windowMs:number, max:number}} [limit]
 * @returns {{allowed: boolean, retryAfterS: number}}
 */
function rateAllowed(buckets, key, limit = RATE_LIMIT) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < limit.windowMs);
  if (hits.length >= limit.max) {
    const retryAfterS = Math.ceil((limit.windowMs - (now - hits[0])) / 1000);
    buckets.set(key, hits);
    return { allowed: false, retryAfterS: Math.max(1, retryAfterS) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true, retryAfterS: 0 };
}

/**
 * Ключ для лимита: токен не логируется, но и в ключ не попадает — вместо
 * него используется короткий хэш.
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function rateKey(req) {
  const header = String(req.headers.authorization || '');
  const token = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] || '';
  if (token) return `t:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  return `ip:${req.socket.remoteAddress || 'unknown'}`;
}

/**
 * Убирает секрет из любого текста, который может уйти в лог или в ответ.
 * @param {unknown} text
 * @param {string} token
 * @returns {string}
 */
export function redactSecret(text, token) {
  let out = String(text ?? '');
  if (token && token.length >= 8) out = out.split(token).join('***');
  return out;
}

/**
 * Проверка токена на слабость. Возвращает текст предупреждения или null.
 *
 * ЗАЧЕМ ТОЛЬКО ПРЕДУПРЕЖДЕНИЕ. Токен — единственный барьер между локальной
 * машиной и сетью. Слишком короткий токен перебирается словарём за секунды,
 * а токен из одного повторяющегося символа — это не токен. Но запрещать
 * владельцу его собственный токен мы не вправе: решение о длине — его.
 *
 * @param {string} token
 * @returns {string|null}
 */
export function tokenEntropyWarning(token) {
  if (!token) return 'токен не задан';
  if (token.length < MIN_TOKEN_LENGTH) {
    return `токен короче ${MIN_TOKEN_LENGTH} символов (${token.length}) — перебирается словарём`;
  }
  if (/^(.)\1*$/.test(token)) return 'токен состоит из одного повторяющегося символа';
  const unique = new Set(token).size;
  if (unique < 8) return `в токене всего ${unique} различных символов — это почти не токен`;
  return null;
}

/**
 * @param {http.IncomingMessage} req
 * @param {string} token
 * @param {boolean} allowAnon
 * @returns {boolean}
 */
function authorized(req, token, allowAnon) {
  if (allowAnon) return true;
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
  token = TOKEN,
  stateDir = STATE_DIR,
  log = console.log,
  renderFactory,
  analysisProbe,
  referenceAnalyzer,
  allowAnon = ALLOW_ANON,
  allowedOrigins = EXTRA_ORIGINS,
  allowedHosts = EXTRA_HOSTS,
  taskTtlMs = TASK_TTL_MS,
  maxBodyBytes = MAX_BODY_BYTES,
  rateLimit = RATE_LIMIT,
} = {}) {
  const registry = createTaskRegistry({ stateDir, renderFactory, analysisProbe, referenceAnalyzer });
  /** @type {Map<string, number[]>} */
  const buckets = new Map();

  const queue = new DurableQueue({
    dir: stateDir,
    concurrency: 1,
    ttlMs: taskTtlMs,
    // Секрет не попадает ни в журнал на диске, ни в текст ошибки, которую
    // потом увидит клиент: ошибка чистится ДО записи и ДО показа.
    redact: (text) => redactSecret(text, token),
    onEvent: (event) => {
      // Жизнь очереди видна в консоли демона: владелец должен видеть, что
      // задача принята, идёт и завершилась, даже если интерфейс отвалился.
      // Секрет в лог не попадает никогда — текст прогоняется через redact.
      if (event.type === 'queue_restored') {
        log(`[local] после перезапуска возвращено задач: ${event.restored}`);
        return;
      }
      if (event.type === 'task_added') log(`[local] принята задача ${event.task.id} (${event.task.type})`);
      if (event.type === 'task_duplicate') {
        log(`[local] повторный запрос задачи ${event.task.id} — вернута та же задача (идемпотентность)`);
        return;
      }
      if (event.type === 'task_started') log(`[local] задача ${event.task.id} в работе`);
      if (event.type === 'task_done') {
        log(`[local] задача ${event.task.id} готова`);
        queue.cleanup().catch(() => {});
        return;
      }
      if (event.type === 'task_error') {
        log(`[local] задача ${event.task.id} упала: ${redactSecret(event.task.error, token)}`);
        queue.cleanup().catch(() => {});
        return;
      }
      if (event.type === 'task_expired') log(`[local] задача ${event.id} убрана по TTL`);
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
  await queue.cleanup();

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port ?? PORT;
    const hostList = hostAllowList(port, HOST, allowedHosts);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // 1. Host: отсекаем DNS rebinding до всякой логики.
    if (!hostAllowed(req, hostList)) {
      sendJson(res, 403, { error: 'Host-заголовок не в списке доверенных: демон отвечает только на локальный адрес и свой порт' });
      return;
    }

    // 2. Origin: пустой — серверный прокси, непустой должен быть доверенным.
    if (!originAllowed(req, allowedOrigins)) {
      sendJson(res, 403, { error: 'Origin не в списке доверенных' });
      return;
    }

    // 3. Токен.
    if (!authorized(req, token, allowAnon)) {
      sendJson(res, 401, { error: 'нужен токен: Authorization: Bearer <LOCAL_DAEMON_TOKEN>' });
      return;
    }

    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        const health = await registry.health();
        sendJson(res, 200, {
          ok: true,
          service: 'strudel-local-daemon',
          version: '0.3.0',
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
        // 4a. Формат: только JSON.
        const contentType = String(req.headers['content-type'] || '');
        if (!/^application\/json\b/i.test(contentType)) {
          sendJson(res, 415, { error: 'ожидается content-type: application/json' });
          return;
        }

        // 4b. Лимит приёма: демон не должен быть использован как очередь
        //     бесконечных запросов (иначе один клиент съест все слоты).
        const limit = rateAllowed(buckets, rateKey(req), rateLimit);
        if (!limit.allowed) {
          sendJson(res, 429, {
            error: `слишком много задач: не больше ${rateLimit.max} за ${rateLimit.windowMs / 1000} с`,
          }, { 'retry-after': String(limit.retryAfterS) });
          return;
        }

        // 4c. Размер тела: по заголовку — сразу, без чтения.
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > maxBodyBytes) {
          sendJson(res, 413, { error: `тело запроса слишком велико: предел ${maxBodyBytes} байт` });
          return;
        }

        const raw = await readBody(req, maxBodyBytes);
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { error: 'тело запроса — не JSON' });
          return;
        }

        const parsed = TASK_REQUEST_SCHEMA.safeParse(body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const field = issue?.path?.length ? issue.path.join('.') : 'запрос';
          sendJson(res, 400, { error: `запрос задачи: ${field} — ${issue?.message ?? 'неверное значение'}` });
          return;
        }

        const { type, payload, id } = parsed.data;
        if (!registry.tasks[type]) {
          sendJson(res, 400, {
            error: `неизвестный тип задачи: ${type || '—'}`,
            available: registry.types(),
          });
          return;
        }

        // 4d. Схема payload по типу задачи: неизвестное поле — отказ.
        const check = validateTaskPayload(type, payload);
        if (!check.ok) {
          sendJson(res, 400, { error: check.error });
          return;
        }

        // 4e. Идемпотентность: тот же id — та же задача, а не вторая работа.
        const duplicate = Boolean(id && queue.tasks.has(id));
        const task = await queue.enqueue(type, check.value, { id });
        sendJson(res, 202, {
          id: task.id,
          type: task.type,
          state: task.state,
          ...(duplicate ? { duplicate: true } : {}),
        });
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
      const status = Number(err?.statusCode) || 500;
      if (status === 413) {
        sendJson(res, 413, { error: `тело запроса слишком велико: предел ${maxBodyBytes} байт` });
        return;
      }
      sendJson(res, 500, { error: redactSecret(err?.message || err, token) });
    }
  });

  // Уборка завершённых задач и журнала — раз в минуту. Таймер не держит
  // процесс живым: демон должен умереть по Ctrl+C без «висит на выходе».
  const janitor = setInterval(() => {
    queue.cleanup().catch(() => {});
  }, 60_000);
  janitor.unref?.();

  server.on('close', () => clearInterval(janitor));

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
  if (ALLOW_ANON) {
    console.error('⚠ LOCAL_DAEMON_ALLOW_ANON=1: демон принимает запросы без токена. Только для локальных экспериментов.');
  }
  const warning = tokenEntropyWarning(TOKEN);
  if (warning) {
    // Сам токен не печатается — только предупреждение о его слабости.
    console.error(`⚠ Слабый LOCAL_DAEMON_TOKEN: ${warning}`);
  }
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.error(
      '⚠ Демон слушает на всех интерфейсах. Запросы с чужих Host будут отклонены — '
      + 'перечислите нужные адреса в LOCAL_DAEMON_ALLOWED_HOSTS.',
    );
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
