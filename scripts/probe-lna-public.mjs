#!/usr/bin/env node
// P3.5 — Chrome Local Network Access: публичный origin → 127.0.0.1.
//
// ЗАЧЕМ. E-044 измерил LNA в сценарии «origin из локальной сети → loopback»:
// Chrome 148 (Electron) запрос пропустил, разрешение LNA не запрашивалось.
// Открытым остался сценарий, ради которого LNA и существует: **публичный
// (внешний) origin → локальный адрес**. В прошлой сессии он был «нет данных»:
// на машине не было ни интернета, ни DNS, публичный origin создать нечем.
//
// МЕТОД. Три независимых источника правды, потому что одного «Failed to
// fetch» мало — из него не видно, дошёл ли запрос до цели:
//   1. страница (публичный origin) — что вернул fetch: статус, тело, текст ошибки;
//   2. сервер-цель на 127.0.0.1 — лог КАЖДОГО попадания: дошёл или нет;
//   3. консоль и события браузера — что именно Chrome сказал (LNA, CORS, сеть).
//
// Разрешение LNA в headless-Chrome выдать нельзя (диалога нет), поэтому
// ожидаемый результат для публичного origin — отказ. Важно не КАК он выглядит,
// а ЧТО он означает для продукта: прямой путь браузер→демон из публичной
// страницы сегодня невозможен, и same-origin прокси (D-121) остаётся
// единственным рабочим путём.
//
// ЗАПУСК:
//   node scripts/probe-lna-public.mjs --url <публичный URL страницы> \
//     [--port 8123] [--out docs/evidence/local/lna-public-<ДАТА>.json]
//
// Страница-зонд (минимальная, публикуется отдельно) — в этом файле она не
// нужна: пр��ба работает с ЛЮБОЙ страницей, которая шлёт fetch на 127.0.0.1 и
// кладёт результат в window.__LNA_RESULT__.

import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { pickBrowserPath, sweepStaleBrowserProfilesOnce, formatSweepReport } from '../lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const sweep = sweepStaleBrowserProfilesOnce();
if (sweep) console.log(formatSweepReport(sweep));

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const pageUrl = argValue('--url', null);
if (!pageUrl) {
  console.error('Нужен публичный URL страницы-зонда: --url <https://…>');
  process.exit(2);
}
const targetPort = Number(argValue('--port', '8123'));
const outPath = argValue('--out', path.join(ROOT, 'docs', 'evidence', 'local', `lna-public-${Date.now()}.json`));

// --- сервер-цель: логирует каждое попадание ---------------------------------
// Permissive CORS: чтобы «ответ ушёл, но его спрятал CORS» нельзя было спутать
// с «запрос не дошёл».
const hits = [];
const target = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${targetPort}`);
  hits.push({
    ts: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    case: url.searchParams.get('case'),
    origin: req.headers.origin || null,
    sec_fetch_site: req.headers['sec-fetch-site'] || null,
    sec_fetch_mode: req.headers['sec-fetch-mode'] || null,
    user_agent: req.headers['user-agent'] || null,
  });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true, hit: hits.length, case: url.searchParams.get('case'), origin: req.headers.origin || null }));
});
await new Promise((resolve) => target.listen(targetPort, '127.0.0.1', resolve));
console.log(`цель-сервер: http://127.0.0.1:${targetPort} (лог попаданий ведётся)`);

// --- браузер ---------------------------------------------------------------
const consoleMessages = [];
const failedRequests = [];
let browser = null;
let pageResult = null;
let navigationError = null;

try {
  const executablePath = pickBrowserPath();
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--mute-audio'],
  });
  const browserVersion = await browser.version();
  console.log(`браузер: ${browserVersion} (${executablePath})`);

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || null,
    });
  });

  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    navigationError = String(err?.message || err);
  }

  if (!navigationError) {
    try {
      await page.waitForFunction(() => typeof window.__LNA_RESULT__ === 'string', { timeout: 30000 });
      pageResult = await page.evaluate(() => window.__LNA_RESULT__);
    } catch (err) {
      pageResult = `результат не получен: ${String(err?.message || err)}`;
    }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
}

// --- разбор ----------------------------------------------------------------
const cases = hits.map((hit) => ({ case: hit.case, reached: true, at: hit.ts }));
const seen = new Set(hits.map((hit) => hit.case));
const expected = ['plain', 'local', 'localhost', 'nocors'];
const missing = expected.filter((name) => !seen.has(name));

const report = {
  probe: 'lna-public',
  date: new Date().toISOString(),
  publicOrigin: pageUrl,
  target: `http://127.0.0.1:${targetPort}`,
  navigationError,
  pageResult,
  targetHits: hits,
  reachedCases: cases,
  notReachedCases: missing,
  consoleMessages,
  failedRequests,
  note:
    'Разрешение LNA в headless-Chrome выдать нельзя (диалога нет), поэтому отказ — ожидаемый исход для публичного origin. '
    + 'Смысл замера — отделить «запрос не дошёл» от «ответ спрятал CORS»: попадания видны в targetHits.',
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('');
console.log('=== результат в странице ===');
console.log(pageResult || '(страница не загрузилась)');
console.log('');
console.log('=== попадания в цель (серверная правда) ===');
console.log(hits.length ? hits.map((hit) => `  ${hit.case}: ${hit.method} ${hit.path} origin=${hit.origin} site=${hit.sec_fetch_site}`).join('\n') : '  (ни одного запроса не дошло)');
console.log('');
console.log(`не дошли: ${missing.length ? missing.join(', ') : '—'}`);
const lnaMessages = consoleMessages.filter((message) => /local network|private network|LNA|loopback/i.test(message.text));
console.log(`сообщений про LNA/PNA в консоли: ${lnaMessages.length}`);
for (const message of lnaMessages.slice(0, 5)) console.log(`  [${message.type}] ${message.text}`);
console.log(`неудачных запросов (requestfailed): ${failedRequests.length}`);
for (const failed of failedRequests.slice(0, 8)) console.log(`  ${failed.url} -> ${failed.failure}`);
console.log('');
console.log(`отчёт: ${path.relative(ROOT, outPath)}`);

await new Promise((resolve) => target.close(resolve));
