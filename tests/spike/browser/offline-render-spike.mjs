#!/usr/bin/env node
// Фаза 3, браузерный спайк: офлайн-рендер → метрики (MetricsReport) → замечания Audio QA.
//
// Запуск:  node tests/spike/browser/offline-render-spike.mjs
// Вывод:   tests/spike/browser/out-offline.txt (подробности) + сводная таблица в stdout.
//
// Драйвер сам собирает браузерный бандл (esbuild: наши src/audio/* + zod),
// поднимает статический сервер и гоняет системный Chrome через playwright-core
// (браузеры playwright не скачаны). Движок @strudel/web грузится отдельным
// UMD-скриптом и доступен в странице как window.strudel.

import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT_FILE = path.join(HERE, 'out-offline.txt');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const BASE_ARGS = ['--no-sandbox', '--mute-audio'];
const AUTOPLAY_ARGS = ['--autoplay-policy=no-user-gesture-required'];
const RUN_TIMEOUT_MS = 240_000;

const VERBOSE = process.argv.includes('--verbose');

const lines = [];
function say(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  lines.push(text);
}
function detail(...args) {
  say(...args);
  if (VERBOSE) console.log('[detail]', ...args);
}
function head(title) {
  say('');
  say('== ' + title + ' ==');
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return 'н/д';
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  return value.toFixed(digits);
}

// --------------------------------------------------------------------------------------
// Сборка браузерного бандла
// --------------------------------------------------------------------------------------

async function buildBrowserBundle(outFile) {
  await esbuild.build({
    entryPoints: [path.join(HERE, 'offline-entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110'],
    outfile: outFile,
    legalComments: 'none',
    logLevel: 'error',
  });
}

// --------------------------------------------------------------------------------------
// Статический сервер
// --------------------------------------------------------------------------------------

function makeRoutes(bundleFile) {
  return {
    '/': { file: path.join(HERE, 'offline-page.html'), type: 'text/html; charset=utf-8' },
    '/offline-page.html': { file: path.join(HERE, 'offline-page.html'), type: 'text/html; charset=utf-8' },
    '/offline-bundle.js': { file: bundleFile, type: 'text/javascript; charset=utf-8' },
    '/bundle.js': {
      file: path.join(ROOT, 'node_modules', '@strudel', 'web', 'dist', 'index.js'),
      type: 'text/javascript; charset=utf-8',
    },
  };
}

function startServer(routes) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    try {
      const body = await readFile(route.file);
      res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(err && err.message));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// --------------------------------------------------------------------------------------
// Браузер
// --------------------------------------------------------------------------------------

function pickBrowserPath() {
  for (const candidate of CHROME_PATHS) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error('Не найден ни Chrome, ни Edge в стандартных путях (задайте CHROME_PATH)');
}

async function launch(extraArgs = []) {
  return chromium.launch({
    executablePath: pickBrowserPath(),
    headless: true,
    args: [...BASE_ARGS, ...extraArgs],
  });
}

function attachLogs(page, tag) {
  page.on('console', (msg) => {
    detail('[' + tag + ' console] ' + msg.type() + ': ' + msg.text());
  });
  page.on('pageerror', (err) => {
    detail('[' + tag + ' pageerror] ' + String(err && err.message));
  });
  page.on('crash', () => {
    detail('[' + tag + ' CRASH] вкладка упала (renderer process crash)');
  });
}

// --------------------------------------------------------------------------------------
// Подробный отчёт
// --------------------------------------------------------------------------------------

function describePattern(p) {
  head('Паттерн: ' + p.id + ' — ' + (p.code || ''));
  if (p.error) {
    say('  ОШИБКА: ' + p.error);
    return;
  }
  const report = p.report || {};
  say('  движок: ' + (report.engineVersion || 'н/д'));
  say('  sampleRate: ' + (report.sampleRate ?? 'н/д') + ' Гц, renderMode: ' + (report.renderMode || 'н/д'));
  say('  такты: ' + JSON.stringify(report.bars || p.bars) +
    ', событий в паттерне: ' + (p.events ?? 'н/д') +
    ', из них с началом: ' + (p.onsets ?? 'н/д'));
  say('  первые события: ' + JSON.stringify(p.firstEvents || []));
  say('  LUFS-I: ' + fmt(report.lufsI) + ' LU, LUFS-M: ' + fmt(report.lufsM) + ' LU, LUFS-S: ' + fmt(report.lufsS) + ' LU');
  say('  true peak: ' + fmt(report.truePeakDbtp) + ' dBTP, peak: ' + fmt(report.peakDbfs) + ' dBFS');
  say('  crest: ' + fmt(report.crestDb) + ' дБ, clipCount: ' + (report.clipCount ?? 'н/д'));
  const bands = report.bands || {};
  say('  полосы (дБ): ' + Object.entries(bands).map(([k, v]) => k + '=' + fmt(v)).join(', '));
  const silence = report.silence || {};
  say('  тишина (с): head=' + fmt(silence.head, 3) + ', tail=' + fmt(silence.tail, 3) +
    ', internal=' + fmt(silence.internal, 3));
  const rep = report.repeatability;
  say('  повторяемость: ' + (rep
    ? 'прогонов=' + rep.runs + ', lufsDeltaDb=' + fmt(rep.lufsDeltaDb, 3) + ', passed=' + rep.passed
    : 'не измерялась'));
  const cmp = p.comparison;
  say('  сравнение двух рендеров: ' + (cmp
    ? 'maxAbsDiff=' + cmp.maxAbsDiff + ', rmsDiff=' + cmp.rmsDiff
    : 'нет данных'));
  say('  время рендера (2 прогона + метрики): ' + (p.renderMs ?? 'н/д') + ' мс');
  say('  приёмка по метрикам: ' + (p.acceptancePassed ? 'ПРОЙДЕНА' : 'НЕ ПРОЙДЕНА'));
  say('  контрольный пересчёт buildMetricsReport: ' + JSON.stringify(p.directReport || null));
  const findings = p.findings || [];
  say('  замечания Audio QA: ' + findings.length + (findings.length ? '' : ' (нет)'));
  for (const finding of findings) {
    say('    [' + finding.severity + '] ' + finding.code + ' — ' + finding.label +
      (finding.hint ? ' :: ' + finding.hint : ''));
  }
  const live = p.live || {};
  say('  живой контекст после рендера: state=' + (live.ctxStateAfter ?? 'н/д') +
    ', currentTime растёт=' + live.timeAdvanced +
    ', ошибок оценки=' + (live.evalError ? live.evalError : 'нет') +
    ', пик в живом контексте=' + fmt(live.livePeak, 4) +
    ' (' + (live.livePeakDb === null ? 'н/д' : fmt(live.livePeakDb, 2) + ' дБ') + ')' +
    ', хвост движока на месте=' + live.hasTail +
    ', глобальный контекст = живой: ' + live.globalCtxIsLive +
    ' (state ' + (live.globalCtxState ?? 'н/д') + ')');
}

// --------------------------------------------------------------------------------------
// Сводка в stdout
// --------------------------------------------------------------------------------------

function printSummary(payload, failure) {
  const out = [];
  out.push('');
  out.push('============ СВОДКА ФАЗЫ 3 (офлайн-рендер → метрики → QA) ============');
  if (!payload) {
    out.push('Прогон не отработал: ' + (failure || 'нет данных'));
  } else {
    const header = [
      'паттерн'.padEnd(10),
      'LUFS-I'.padStart(8),
      'TP dBTP'.padStart(9),
      'peak'.padStart(8),
      'crest'.padStart(6),
      'clip'.padStart(5),
      'тишина h/t/i'.padStart(17),
      'lufsΔ'.padStart(7),
      'maxAbsDiff'.padStart(11),
      'мс'.padStart(7),
      'QA'.padStart(9),
    ];
    out.push(header.join(' | '));
    out.push('-'.repeat(header.join(' | ').length));
    for (const pattern of payload.patterns || []) {
      if (pattern.error) {
        out.push(String(pattern.id).padEnd(10) + ' | ОШИБКА: ' + pattern.error);
        continue;
      }
      const report = pattern.report || {};
      const silence = report.silence || {};
      const rep = report.repeatability || {};
      const cmp = pattern.comparison || {};
      const findings = pattern.findings || [];
      const errors = findings.filter((f) => f.severity === 'error').length;
      const row = [
        String(pattern.id).padEnd(10),
        fmt(report.lufsI).padStart(8),
        fmt(report.truePeakDbtp).padStart(9),
        fmt(report.peakDbfs).padStart(8),
        fmt(report.crestDb).padStart(6),
        String(report.clipCount ?? 'н/д').padStart(5),
        (fmt(silence.head, 2) + '/' + fmt(silence.tail, 2) + '/' + fmt(silence.internal, 2)).padStart(17),
        fmt(rep.lufsDeltaDb, 3).padStart(7),
        String(cmp.maxAbsDiff ?? 'н/д').padStart(11),
        String(pattern.renderMs ?? 'н/д').padStart(7),
        (findings.length + ' (' + errors + ' err)').padStart(9),
      ];
      out.push(row.join(' | '));
    }
    out.push('');
    out.push('детерминизм (maxAbsDiff / rmsDiff двух рендеров): ' + (payload.patterns || [])
      .filter((p) => !p.error && p.comparison)
      .map((p) => p.id + ': ' + p.comparison.maxAbsDiff + ' / ' + p.comparison.rmsDiff)
      .join('; '));
    out.push('живой контекст: ' + (payload.engine?.liveContextStateBefore ?? 'н/д') + ' -> ' +
      (payload.engine?.liveContextStateAfter ?? 'н/д'));
    out.push('замечания Audio QA (код / severity / label):');
    let findingsTotal = 0;
    for (const pattern of payload.patterns || []) {
      for (const finding of pattern.findings || []) {
        findingsTotal += 1;
        out.push('  ' + String(pattern.id).padEnd(10) + ' ' + finding.code + ' / ' + finding.severity +
          ' / ' + finding.label);
      }
    }
    if (!findingsTotal) out.push('  (нет)');
  }
  out.push('подробности: tests/spike/browser/out-offline.txt');
  out.push('=================================================================');
  const text = out.join('\n');
  console.log(text);
  say(text);
}

// --------------------------------------------------------------------------------------

async function main() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'strudel-offline-spike-'));
  const bundleFile = path.join(tmpDir, 'offline-bundle.js');

  say('Спайк фазы 3: офлайн-рендер → MetricsReport → Audio QA');
  say('node: ' + process.version + ', chrome: ' + pickBrowserPath());
  say('репозиторий: ' + ROOT);

  await buildBrowserBundle(bundleFile);
  const bundleSize = (await readFile(bundleFile)).length;
  say('браузерный бандл: ' + bundleFile + ' (' + bundleSize + ' байт)');

  const routes = makeRoutes(bundleFile);
  const { server, port } = await startServer(routes);
  const baseUrl = 'http://127.0.0.1:' + port;
  say('статический сервер: ' + baseUrl);

  let payload = null;
  let failure = null;
  const browser = await launch(AUTOPLAY_ARGS);
  try {
    say('chrome: ' + browser.version());
    const page = await browser.newPage();
    attachLogs(page, 'offline');
    await page.goto(baseUrl + '/', { waitUntil: 'load' });
    await page.waitForFunction(
      () => !!window.__offlineSpike && window.__offlineSpike.ready,
      null,
      { timeout: 30000 },
    );
    payload = await Promise.race([
      page.evaluate(() => window.__offlineSpike.run()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('превышен лимит ожидания ' + RUN_TIMEOUT_MS + ' мс')), RUN_TIMEOUT_MS)),
    ]);
    await page.close();
  } catch (err) {
    failure = String((err && err.message) || err);
    detail('ОШИБКА прогона: ' + failure);
  } finally {
    await browser.close();
    server.close();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!payload) {
    printSummary(null, failure);
    writeFileSync(OUT_FILE, lines.join('\n') + '\n\nFATAL: ' + (failure || 'нет данных') + '\n', 'utf8');
    console.error('\nСпайк не отработал: ' + (failure || 'нет данных'));
    process.exitCode = 1;
    return;
  }

  head('Общие данные прогона');
  say('  user agent: ' + (payload.engine?.userAgent || 'н/д'));
  say('  живой контекст до рендеров: ' + (payload.engine?.liveContextStateBefore ?? 'н/д'));
  say('  живой контекст после рендеров: ' + (payload.engine?.liveContextStateAfter ?? 'н/д'));
  say('  хвост движка после init: ' + (payload.engine?.tailAfterInit ?? 'н/д'));
  say('  ошибок движка за прогон: ' + ((payload.errors || []).length) +
    ((payload.errors || []).length ? ' :: ' + payload.errors.join('; ') : ''));

  for (const pattern of payload.patterns || []) {
    describePattern(pattern);
  }

  printSummary(payload, failure);

  writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
  console.log('\nПодробности: ' + OUT_FILE);

  const problems = [];
  if (failure) problems.push('прогон упал: ' + failure);
  for (const pattern of payload.patterns || []) {
    if (pattern.error) {
      problems.push('паттерн ' + pattern.id + ': ' + pattern.error);
      continue;
    }
    if (!pattern.comparison) problems.push('паттерн ' + pattern.id + ': нет сравнения двух рендеров');
    if (pattern.acceptancePassed === false) {
      problems.push('паттерн ' + pattern.id + ': приёмка по метрикам не пройдена');
    }
    const live = pattern.live || {};
    if (live.evalError) problems.push('паттерн ' + pattern.id + ': ошибка живой оценки: ' + live.evalError);
    if (live.ctxStateAfter && live.ctxStateAfter !== 'running') {
      problems.push('паттерн ' + pattern.id + ': живой контекст в состоянии ' + live.ctxStateAfter);
    }
  }
  if (problems.length) {
    console.error('\nПроблемы:\n- ' + problems.join('\n- '));
    process.exitCode = 1;
  } else {
    console.log('Все паттерны отрендерены, метрики и замечания получены — код выхода 0.');
  }
}

main().catch((err) => {
  console.error('Спайк упал:', err && err.stack ? err.stack : err);
  try {
    writeFileSync(OUT_FILE, lines.join('\n') + '\n\nFATAL: ' + String(err && err.stack || err) + '\n', 'utf8');
  } catch (_) { /* ignore */ }
  process.exitCode = 1;
});
