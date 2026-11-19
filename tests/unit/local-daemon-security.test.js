// Негативная матрица локального демона.
//
// ЗАЧЕМ ТЕСТЫ ИМЕННО «ОТРИЦАТЕЛЬНЫЕ». Демон — единственная точка, где тяжёлое
// считается на машине владельца, и единственная точка, куда можно сунуть
// произвольный путь, код и файл. Каждая защита (токен, Host, Origin, формат,
// размер, лимит) — это отказ. Значит, и проверять надо отказ: «демон ответил
// 200 там, где должен был сказать 401» — это дефект.
//
// ЗАЧЕМ РЕАЛЬНЫЙ ДЕМОН, А НЕ МОК. Мок проверяет, что тест ожидает то, что
// сам же и подставил. Здесь поднимается настоящий демон из local/daemon.mjs:
// настоящий HTTP-сервер, настоящая очередь на диске, настоящий журнал.
//
// ТЯЖЁЛЫЕ ЗАДАЧИ НЕ ЗАПУСКАЮТСЯ. Рендер подменён заглушкой, которая никогда не
// завершается: так проверяется «задача в работе», не тратя минуты на Chromium.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDaemon, redactSecret, tokenEntropyWarning } from '../../local/daemon.mjs';
import { DurableQueue } from '../../local/queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TOKEN = 'security-test-token-0123456789abcdef';

/** Рендер-заглушка: задача уходит в «работает» и там остаётся. */
function blockingRender() {
  const gates = [];
  const factory = async () => ({
    render: () => new Promise((resolve) => { gates.push(resolve); }),
    close: async () => {},
  });
  factory.gates = gates;
  return factory;
}

/** Рендер-заглушка: задача сразу завершается пустым результатом. */
function instantRender() {
  return async () => ({
    render: async () => ({
      renderMs: 1,
      durationS: 0,
      sampleRate: 44100,
      report: {},
      events: [],
      fingerprint: 'test',
      wav: null,
    }),
    close: async () => {},
  });
}

/** @type {Array<() => Promise<void>|void>} */
const cleanups = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try {
      await fn();
    } catch {
      // уборка не должна ронять тест
    }
  }
});

/**
 * Поднимает настоящий демон на случайном порту.
 * @param {object} [options]
 */
async function startDaemon(options = {}) {
  const stateDir = options.stateDir || await mkdtemp(path.join(tmpdir(), 'daemon-sec-'));
  const logs = [];
  const renderFactory = options.renderFactory || blockingRender();
  const daemon = await createDaemon({
    token: TOKEN,
    stateDir,
    log: (line) => logs.push(String(line)),
    analysisProbe: async () => ({ available: false }),
    renderFactory,
    ...(options.daemonOptions || {}),
  });
  await new Promise((resolve) => daemon.server.listen(0, '127.0.0.1', resolve));
  const port = daemon.server.address().port;
  cleanups.push(async () => {
    await new Promise((resolve) => daemon.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  return {
    daemon,
    stateDir,
    logs,
    port,
    base: `http://127.0.0.1:${port}`,
    async request(pathname, init = {}) {
      const res = await fetch(`${`http://127.0.0.1:${port}`}${pathname}`, init);
      const text = await res.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      return { status: res.status, headers: res.headers, body, text };
    },
    async postTask(payload, { token = TOKEN, contentType = 'application/json', raw = null } = {}) {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (contentType) headers['content-type'] = contentType;
      const res = await fetch(`http://127.0.0.1:${port}/tasks`, {
        method: 'POST',
        headers,
        body: raw ?? JSON.stringify(payload),
      });
      const text = await res.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      return { status: res.status, headers: res.headers, body };
    },
  };
}

/**
 * Сырой HTTP-запрос: нужен, чтобы подменить Host-заголовок (fetch его не даёт).
 * @param {{port:number, method?:string, path?:string, headers?:object, body?:string}} options
 */
function rawRequest({ port, method = 'GET', path: pathname = '/health', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Ждёт условия с таймаутом.
 * @param {() => Promise<any>} fn
 */
async function waitFor(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return null;
}

describe('негативная матрица демона (P3.2)', () => {
  it('без токена — 401, с неверным токеном — 401, с верным — 200', async () => {
    const app = await startDaemon();
    const without = await app.request('/health');
    const wrong = await app.request('/health', { headers: { authorization: 'Bearer wrong-token-value' } });
    const right = await app.request('/health', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(without.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(right.status).toBe(200);
    // В отказе нет токена даже фрагментом.
    expect(without.text).not.toContain(TOKEN);
  });

  it('анонимный режим выключен по умолчанию', async () => {
    // Демон, собранный без явного allowAnon, не принимает запрос без токена.
    const app = await startDaemon();
    const res = await app.request('/health');
    expect(res.status).toBe(401);
  });

  it('демон без токена не стартует вовсе (fail-closed)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'daemon-failclosed-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    // Пустой .env: репозиторный файл с секретами не должен подмешиваться.
    await writeFile(path.join(dir, '.env'), '', 'utf8');
    const env = {
      ...process.env,
      DOTENV_CONFIG_PATH: path.join(dir, '.env'),
      LOCAL_DAEMON_STATE: path.join(dir, 'state'),
      LOCAL_DAEMON_PORT: '0',
    };
    delete env.LOCAL_DAEMON_TOKEN;
    delete env.LOCAL_DAEMON_ALLOW_ANON;
    const child = spawn(process.execPath, ['local/daemon.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const [code] = await new Promise((resolve) => child.on('exit', (...args) => resolve(args)));
    expect(code).toBe(1);
    expect(stderr).toMatch(/LOCAL_DAEMON_TOKEN/);
  });

  it('неизвестный тип задачи — 400 со списком доступных типов', async () => {
    const app = await startDaemon();
    const res = await app.postTask({ type: 'выдумать-трек', payload: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/неизвестный тип задачи/);
    expect(res.body.available).toContain('render');
  });

  it('аудио незавершённой задачи — 404', async () => {
    const app = await startDaemon();
    const submitted = await app.postTask({ type: 'render', payload: { code: 'setCpm(120/4)' } });
    expect(submitted.status).toBe(202);
    const res = await app.request(`/tasks/${submitted.body.id}/audio`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('аудио с путём вне каталога рендеров — 404', async () => {
    const app = await startDaemon();
    const submitted = await app.postTask({ type: 'render', payload: { code: 'setCpm(120/4)' } });
    const id = submitted.body.id;
    // Подмена внутренней записи: задача «готова», но WAV лежит вне renders/.
    const record = app.daemon.queue.tasks.get(id);
    record.state = 'done';
    record.result = { wavPath: path.join(app.stateDir, 'renders', '..', '..', 'чужой-файл.wav') };
    const res = await app.request(`/tasks/${id}/audio`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it('тело больше 8 МБ — 413, а не 500', async () => {
    const app = await startDaemon();
    const huge = JSON.stringify({ type: 'render', payload: { code: 'x'.repeat(9 * 1024 * 1024) } });
    const res = await app.postTask(null, { raw: huge });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/слишком велик/i);
  });

  it('очередь переживает убийство процесса: задача возвращается в работу', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'daemon-kill-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
    const daemonUrl = new URL('../../local/daemon.mjs', import.meta.url).href;

    // Настоящий демон в отдельном процессе: его убивают — как умирает
    // демон владельца при перезагрузке или сбое питания.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createDaemon } from ${JSON.stringify(daemonUrl)};
      const daemon = await createDaemon({
        stateDir: process.env.STATE_DIR,
        token: process.env.TOKEN,
        log: () => {},
        analysisProbe: async () => ({ available: false }),
        renderFactory: async () => ({ render: () => new Promise(() => {}), close: async () => {} }),
      });
      daemon.server.listen(0, '127.0.0.1', () => {
        console.log(JSON.stringify({ port: daemon.server.address().port }));
      });
    `], {
      cwd: ROOT,
      env: { ...process.env, STATE_DIR: stateDir, TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
        const match = /\{.*\}/.exec(out);
        if (match) resolve(JSON.parse(match[0]).port);
      });
      child.on('exit', () => reject(new Error('дочерний демон умер раньше времени')));
    });

    const submitted = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'render', payload: { code: 'setCpm(120/4)' } }),
    });
    expect(submitted.status).toBe(202);
    const { id } = await submitted.json();

    // Убиваем процесс без шанса на корректное завершение.
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));

    // Читаем журнал как файл: задача должна была остаться в нём.
    const journal = await readFile(path.join(stateDir, 'queue.jsonl'), 'utf8');
    expect(journal).toContain(id);

    // Новый демон на том же каталоге возвращает задачу в работу.
    const events = [];
    const queue = new DurableQueue({
      dir: stateDir,
      onEvent: (event) => events.push(event),
    });
    await queue.init();
    const restored = events.find((event) => event.type === 'queue_restored');
    expect(restored).toBeTruthy();
    expect(restored.restored).toBe(1);
    expect(queue.tasks.get(id)).toBeTruthy();
    expect(queue.tasks.get(id).state).toBe('queued');
  });

  it('concurrency=1: вторая тяжёлая задача ждёт первой', async () => {
    const render = blockingRender();
    const app = await startDaemon({ renderFactory: render });
    const first = await app.postTask({ type: 'render', payload: { code: 'setCpm(120/4)' } });
    const second = await app.postTask({ type: 'render', payload: { code: 'setCpm(130/4)' } });

    const running = await waitFor(async () => {
      const res = await app.request(`/tasks/${first.body.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      return res.body.task?.state === 'running';
    });
    expect(running).toBeTruthy();

    const secondRes = await app.request(`/tasks/${second.body.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(secondRes.body.task.state).toBe('queued');
    // Пока первая задача в работе, рендер вызван ровно один раз.
    expect(render.gates.length).toBe(1);
  });
});

describe('усиление демона (P3.3)', () => {
  it('чужой Host-заголовок — 403 (защита от DNS rebinding)', async () => {
    const app = await startDaemon();
    const res = await rawRequest({
      port: app.port,
      headers: { host: 'attacker.example', authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
    // С правильным Host — 200: фильтр не бьёт по своим.
    const own = await rawRequest({
      port: app.port,
      headers: { host: `127.0.0.1:${app.port}`, authorization: `Bearer ${TOKEN}` },
    });
    expect(own.status).toBe(200);
  });

  it('чужой Origin — 403, пустой Origin — допустим', async () => {
    const app = await startDaemon();
    const foreign = await app.request('/health', { headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' } });
    expect(foreign.status).toBe(403);
    // Серверный прокси Origin не шлёт — это штатный путь.
    const noOrigin = await app.request('/health', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(noOrigin.status).toBe(200);
    const local = await app.request('/health', { headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://localhost:5173' } });
    expect(local.status).toBe(200);
  });

  it('неизвестное поле в payload — 400 (строгая схема типа)', async () => {
    const app = await startDaemon();
    const res = await app.postTask({ type: 'render', payload: { code: 'setCpm(120/4)', неожиданноеПоле: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payload задачи render/);
  });

  it('неверное значение поля — 400', async () => {
    const app = await startDaemon();
    const res = await app.postTask({ type: 'render', payload: { code: 'x', sampleRate: 'быстро' } });
    expect(res.status).toBe(400);
  });

  it('неизвестное поле верхнего уровня — 400', async () => {
    const app = await startDaemon();
    const res = await app.postTask({ type: 'render', payload: { code: 'x' }, лишнее: true });
    expect(res.status).toBe(400);
  });

  it('content-type не application/json — 415', async () => {
    const app = await startDaemon();
    const res = await app.postTask(null, { contentType: 'text/plain', raw: 'не json' });
    expect(res.status).toBe(415);
  });

  it('лимит приёма задач — 429 с retry-after', async () => {
    const app = await startDaemon({
      daemonOptions: { rateLimit: { windowMs: 60_000, max: 2 } },
    });
    const first = await app.postTask({ type: 'render', payload: { code: 'a' } });
    const second = await app.postTask({ type: 'render', payload: { code: 'b' } });
    const third = await app.postTask({ type: 'render', payload: { code: 'c' } });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
  });

  it('повторный запрос с тем же id не запускает работу дважды', async () => {
    const render = blockingRender();
    const app = await startDaemon({ renderFactory: render });
    const id = 'idem-task-0001';
    const first = await app.postTask({ type: 'render', payload: { code: 'setCpm(120/4)' }, id });
    const second = await app.postTask({ type: 'render', payload: { code: 'setCpm(120/4)' }, id });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.duplicate).toBe(true);
    await waitFor(async () => render.gates.length >= 1);
    // Рендер запущен один раз: тяжёлая работа не удвоилась.
    expect(render.gates.length).toBe(1);
    const list = await app.request('/tasks', { headers: { authorization: `Bearer ${TOKEN}` } });
    const same = list.body.tasks.filter((task) => task.id === id);
    expect(same.length).toBe(1);
  });

  it('токен не попадает ни в логи, ни в queue.jsonl, ни в текст ошибки', async () => {
    const app = await startDaemon();
    // Путь с токеном внутри: ошибка чтения файла его содержит.
    const res = await app.postTask({
      type: 'passport',
      payload: { path: path.join(app.stateDir, `нет-${TOKEN}.wav`) },
    });
    expect(res.status).toBe(202);
    await waitFor(async () => app.logs.some((line) => line.includes('упала')));
    const errorLine = app.logs.find((line) => line.includes('упала'));
    expect(errorLine).toBeTruthy();
    expect(errorLine).not.toContain(TOKEN);
    expect(app.logs.join('\n')).not.toContain(TOKEN);

    const journal = await readFile(path.join(app.stateDir, 'queue.jsonl'), 'utf8');
    expect(journal).not.toContain(TOKEN);

    const task = await app.request(`/tasks/${res.body.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(task.body.task.error || '').not.toContain(TOKEN);
  });

  it('слабый токен распознаётся, сильный — нет', () => {
    expect(tokenEntropyWarning('')).toMatch(/не задан/);
    expect(tokenEntropyWarning('короткий')).toMatch(/короче 32/);
    expect(tokenEntropyWarning('a'.repeat(40))).toMatch(/одного повторяющегося/);
    expect(tokenEntropyWarning('ab'.repeat(16))).toMatch(/различных символов/);
    expect(tokenEntropyWarning(TOKEN)).toBeNull();
  });

  it('redactSecret вычищает секрет из произвольного текста', () => {
    expect(redactSecret(`токен ${TOKEN} внутри`, TOKEN)).toBe('токен *** внутри');
    expect(redactSecret('без секрета', TOKEN)).toBe('без секрета');
    expect(redactSecret('текст', '')).toBe('текст');
  });

  it('завершённая задача исчезает по TTL, журнал ужимается', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'daemon-ttl-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const events = [];
    const queue = new DurableQueue({
      dir,
      ttlMs: 0,
      onEvent: (event) => events.push(event),
      handler: async () => ({ ok: true }),
    });
    await queue.init();
    await queue.enqueue('render', { code: 'setCpm(120/4)' });
    await waitFor(async () => queue.get(queue.list()[0].id)?.state === 'done');
    expect(queue.tasks.size).toBe(1);

    const { expired } = await queue.cleanup();
    expect(expired).toBe(1);
    expect(queue.tasks.size).toBe(0);
    expect(events.some((event) => event.type === 'task_expired')).toBe(true);
    // Журнал ужат: запись исчезла, а не осталась навсегда.
    const journal = await readFile(path.join(dir, 'queue.jsonl'), 'utf8');
    expect(journal.trim()).toBe('');
  });

  it('демон убирает завершённые задачи из своей карты по TTL', async () => {
    const app = await startDaemon({
      renderFactory: instantRender(),
      daemonOptions: { taskTtlMs: 0 },
    });
    const submitted = await app.postTask({ type: 'render', payload: { code: 'setCpm(120/4)' } });
    await waitFor(async () => {
      const res = await app.request(`/tasks/${submitted.body.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      return res.body.task?.state === 'done';
    });
    await app.daemon.queue.cleanup();
    const res = await app.request(`/tasks/${submitted.body.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });
});
