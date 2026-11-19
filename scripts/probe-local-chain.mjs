#!/usr/bin/env node
// P3.7 — живой smoke цепочки: браузер → серверный прокси → демон (SSE).
//
// ЗАЧЕМ. Архитектура local-first (D-097/D-103/D-121) держится на одном
// утверждении: браузер НЕ ходит к демону напрямую, токен демона остаётся на
// сервере, а браузер видит только same-origin прокси `/api/local/*`. Это
// утверждение проверялось тестами на уровне модулей, но не НАСТОЯЩИМ
// браузером и настоящим сервером. Этот зонд проверяет именно цепочку.
//
// ЧТО ПРОВЕРЯЕТСЯ (каждый пункт — отдельная проверка с ожидаемым кодом):
//   1. Демон fail-closed: без токена → 401; с токеном → 200.
//   2. Периметр: чужой Host → 403; чужой Origin → 403.
//   3. Браузер видит демон через прокси: GET /api/local/status → configured true.
//   4. Браузер НЕ может прочитать демон напрямую: cross-origin fetch к
//      127.0.0.1:порт демона падает (CORS), токен в браузере не нужен и не
//      отправляется.
//   5. Задача идёт через прокси: POST /api/local/tasks → 202 + id.
//   6. Прогресс идёт SSE через прокси: GET /api/local/tasks/:id/stream →
//      события snapshot … done.
//   7. Идемпотентность: повторная отправка с тем же id → тот же task, вторая
//      работа не заводится.
//
// ЧЕСТНОСТЬ. Рендер в зонде подменён (renderFactory), чтобы проверять
// ТРАНСПОРТ, а не музыку: живой рендер Chromium занимает минуты и проверяет
// другое свойство. Python-воркер тоже не нужен — его наличие проверяется
// health демона. Статус тяжёлых операций — «не измерено этим зондом».
//
// ЗАПУСК: node scripts/probe-local-chain.mjs [--out docs/evidence/local/chain-<ДАТА>.json]

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { pickBrowserPath, sweepStaleBrowserProfilesOnce, formatSweepReport } from '../lib/browser.mjs';

import { createDaemon } from '../local/daemon.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Уборка осиротевших профилей Playwright: один раз на процесс, до запуска
// браузера (модуль сам глотает ошибки доступа к tmpdir).
const sweep = sweepStaleBrowserProfilesOnce();
if (sweep) console.log(formatSweepReport(sweep));

// --- аргументы -------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const outPath = argValue('--out', path.join(ROOT, 'docs', 'evidence', 'local', `chain-${Date.now()}.json`));

// --- проверки ---------------------------------------------------------------

/**
 * Запрос с произвольными заголовками. `fetch` не даёт подменить `Host`
 * (запрещённый заголовок), а проверка периметра без него бессмысленна —
 * поэтому низкоуровневый node:http.
 * @param {number} port
 * @param {string} pathname
 * @param {Record<string,string>} headers
 * @returns {Promise<{status:number, body:string}>}
 */
function rawRequest(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const checks = [];
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {any} detail
 */
function check(name, ok, detail = null) {
  checks.push({ name, ok: Boolean(ok), detail });
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail === null ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return Boolean(ok);
}

// --- окружение зонда -------------------------------------------------------

const token = randomBytes(32).toString('base64url');
const stateDir = path.join(ROOT, '.scratch', `probe-local-chain-${Date.now()}`);
mkdirSync(stateDir, { recursive: true });

/** Рендер подменён: зонд проверяет транспорт, а не звук. */
const fakeRenderFactory = async () => ({
  render: async () => ({
    renderMs: 12,
    durationS: 2,
    sampleRate: 44100,
    report: { probe: 'local-chain', note: 'рендер подменён: зонд проверяет транспорт' },
    events: [],
    fingerprint: 'probe-fake-fingerprint',
    wav: null,
  }),
  close: async () => {},
});

const { server: daemonServer } = await createDaemon({
  token,
  stateDir,
  renderFactory: fakeRenderFactory,
  analysisProbe: async () => ({ available: false, reason: 'зонд транспорта: Python-воркер не нужен' }),
  log: () => {},
});
await new Promise((resolve) => daemonServer.listen(0, '127.0.0.1', resolve));
const daemonPort = daemonServer.address().port;
const daemonOrigin = `http://127.0.0.1:${daemonPort}`;

// Сервер — настоящий процесс проекта (тот же код, что в проде), только с
// тестовыми портами и мок-LLM: ключи владельца не нужны и не читаются.
const serverPort = 3400 + Math.floor(Math.random() * 400);
const serverOrigin = `http://127.0.0.1:${serverPort}`;
const serverProc = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    MOCK_LLM: '1',
    PORT: String(serverPort),
    HOST: '127.0.0.1',
    LOCAL_DAEMON_URL: daemonOrigin,
    LOCAL_DAEMON_TOKEN: token,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
serverProc.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
serverProc.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverOrigin}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const browserRequests = [];
let browser = null;

try {
  // --- 1–2. Демон: fail-closed и периметр --------------------------------
  const noToken = await fetch(`${daemonOrigin}/health`);
  check('демон без токена → 401', noToken.status === 401, `HTTP ${noToken.status}`);

  const withToken = await fetch(`${daemonOrigin}/health`, { headers: { authorization: `Bearer ${token}` } });
  const healthBody = await withToken.json().catch(() => ({}));
  check('демон с токеном → 200', withToken.status === 200, `HTTP ${withToken.status}`);
  check('демон отвечает ok=true', healthBody?.ok === true, healthBody?.ok);

  const foreignHost = await rawRequest(daemonPort, '/health', {
    authorization: `Bearer ${token}`,
    host: 'attacker.example',
  });
  check('чужой Host → 403', foreignHost.status === 403, `HTTP ${foreignHost.status}`);

  const foreignOrigin = await fetch(`${daemonOrigin}/health`, {
    headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
  });
  check('чужой Origin → 403', foreignOrigin.status === 403, `HTTP ${foreignOrigin.status}`);

  // --- сервер ------------------------------------------------------------
  const serverUp = await waitForServer();
  if (!check('сервер поднялся', serverUp, serverLog.slice(-400))) {
    throw new Error('сервер не поднялся');
  }

  // --- 3–7. Браузер ------------------------------------------------------
  browser = await chromium.launch({
    executablePath: pickBrowserPath(),
    headless: true,
    args: ['--no-sandbox', '--mute-audio'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('request', (request) => {
    browserRequests.push({
      url: request.url(),
      method: request.method(),
      hasAuthorization: Boolean(request.headers().authorization),
    });
  });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(`${serverOrigin}/api/health`, { waitUntil: 'domcontentloaded' });

  const statusFromBrowser = await page.evaluate(async () => {
    const res = await fetch('/api/local/status');
    return { httpStatus: res.status, body: await res.json() };
  });
  check(
    'браузер видит демон через прокси (same-origin)',
    statusFromBrowser.httpStatus === 200 && statusFromBrowser.body?.configured === true && statusFromBrowser.body?.available === true,
    statusFromBrowser.body,
  );

  const directFromBrowser = await page.evaluate(async (origin) => {
    try {
      const res = await fetch(`${origin}/health`);
      const text = await res.text();
      return { threw: false, status: res.status, text: text.slice(0, 120) };
    } catch (err) {
      return { threw: true, error: String(err?.message || err) };
    }
  }, daemonOrigin);
  check(
    'прямой доступ браузера к демону недоступен (CORS)',
    directFromBrowser.threw === true,
    directFromBrowser,
  );

  const taskId = `probe-chain-${Date.now()}`;
  const submitFromBrowser = await page.evaluate(async (id) => {
    const res = await fetch('/api/local/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'render', payload: { code: 's("bd*4")' }, id }),
    });
    return { httpStatus: res.status, body: await res.json() };
  }, taskId);
  check(
    'задача поставлена через прокси → 202',
    submitFromBrowser.httpStatus === 202 && Boolean(submitFromBrowser.body?.id),
    submitFromBrowser.body,
  );

  const sseEvents = await page.evaluate(async (id) => {
    const res = await fetch(`/api/local/tasks/${id}/stream`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const out = [];
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const type = /event:\s*(\S+)/.exec(chunk)?.[1] || null;
        const raw = /data:\s*(.*)/.exec(chunk)?.[1] || '';
        let data = null;
        try { data = JSON.parse(raw); } catch { /* не JSON — не наш случай */ }
        out.push({ type, state: data?.task?.state ?? null });
        if (type === 'done' || type === 'error') return out;
        index = buffer.indexOf('\n\n');
      }
    }
    return out;
  }, taskId);
  check(
    'SSE через прокси дошёл до терминального события',
    sseEvents.some((e) => e.type === 'snapshot') && sseEvents.some((e) => e.type === 'done' || e.type === 'error'),
    sseEvents.map((e) => e.type).join(' → '),
  );

  const taskState = await page.evaluate(async (id) => {
    const res = await fetch(`/api/local/tasks/${id}`);
    return { httpStatus: res.status, body: await res.json() };
  }, taskId);
  check(
    'задача в состоянии done через прокси',
    taskState.body?.task?.state === 'done',
    taskState.body?.task?.state,
  );

  const duplicate = await page.evaluate(async (id) => {
    const res = await fetch('/api/local/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'render', payload: { code: 's("bd*4")' }, id }),
    });
    return { httpStatus: res.status, body: await res.json() };
  }, taskId);
  const queueList = await page.evaluate(async () => {
    const res = await fetch('/api/local/tasks');
    return res.json();
  });
  const queueLength = Array.isArray(queueList?.tasks) ? queueList.tasks.length : null;
  check(
    'повтор с тем же id → та же задача, вторая работа не заведена',
    duplicate.body?.id === taskId && queueLength === 1,
    { id: duplicate.body?.id, duplicate: duplicate.body?.duplicate ?? null, queueLength },
  );

  // --- секрет не уехал в браузер -----------------------------------------
  const domHasToken = await page.evaluate((secret) => document.documentElement.outerHTML.includes(secret), token);
  check('токена нет в DOM страницы', domHasToken === false);

  const daemonRequests = browserRequests.filter((r) => r.url.startsWith(daemonOrigin));
  const tokenLeak = browserRequests.find((r) => r.hasAuthorization);
  check(
    'браузер не отправлял Authorization и не ходил к демону (кроме намеренной попытки)',
    !tokenLeak && daemonRequests.length <= 1,
    { daemonRequests: daemonRequests.length, requestsWithAuthorization: browserRequests.filter((r) => r.hasAuthorization).length },
  );

  // --- студия: настоящая страница ---------------------------------------
  const studioErrors = [];
  const studioPage = await context.newPage();
  studioPage.on('console', (msg) => {
    if (msg.type() === 'error') studioErrors.push(msg.text());
  });
  let studioLoaded = false;
  try {
    await studioPage.goto(`${serverOrigin}/studio.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    studioLoaded = true;
  } catch (err) {
    studioErrors.push(String(err?.message || err));
  }
  const studioStatus = studioLoaded
    ? await studioPage.evaluate(async () => {
      const res = await fetch('/api/local/status');
      const body = await res.json();
      return { httpStatus: res.status, configured: body?.configured, available: body?.available };
    })
    : null;
  check(
    'студия открывается и видит демон через прокси',
    Boolean(studioLoaded && studioStatus?.configured === true),
    { studioLoaded, studioStatus, consoleErrors: studioErrors.slice(0, 3) },
  );

  const report = {
    probe: 'local-chain',
    date: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    daemonPort,
    serverPort,
    browser: browser.version ? await browser.version() : null,
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
    },
    notMeasured: [
      'живой рендер Chromium в демоне (рендер подменён: зонд проверяет транспорт)',
      'работа Python-воркера и Demucs (не требуется для проверки транспорта)',
      'звуковое качество (не измеряется зондом)',
    ],
    browserRequests: browserRequests.map((r) => ({
      url: r.url.replace(daemonOrigin, 'daemon://'),
      method: r.method,
      hasAuthorization: r.hasAuthorization,
    })),
    consoleErrors: consoleErrors.slice(0, 10),
  };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`=== итог: ${report.summary.passed}/${report.summary.total} проверок ===`);
  console.log(`отчёт: ${path.relative(ROOT, outPath)}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log('НЕ ПРОЙДЕНО:');
    for (const item of failed) console.log(`  ✗ ${item.name}`);
    process.exitCode = 1;
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  serverProc.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  serverProc.kill('SIGKILL');
  await new Promise((resolve) => daemonServer.close(resolve));
}
