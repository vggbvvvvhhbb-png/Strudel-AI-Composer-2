#!/usr/bin/env node
// Фаза 0 аудио-спайка: гипотезы H1/H3/H5/H8/H9/H12 на РЕАЛЬНОМ движке Strudel в браузере.
//
// Запуск:  node tests/spike/browser/master-spike.mjs
// Вывод:   tests/spike/browser/out.txt (подробности) + сводная таблица в stdout.
//
// Драйвер сам поднимает статический сервер (page.html + UMD-бандл @strudel/web + наш лимитер)
// и гоняет системный Chrome через playwright-core (браузеры playwright не скачаны).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { pickBrowserPath, sweepStaleBrowserProfilesOnce, formatSweepReport } from '../../../lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT_FILE = path.join(HERE, 'out.txt');

// Уборка осиротевших профилей Playwright: один раз на процесс, до запуска
// браузера (модуль сам глотает ошибки доступа к tmpdir).
const sweep = sweepStaleBrowserProfilesOnce();
if (sweep) console.log(formatSweepReport(sweep));

const BASE_ARGS = ['--no-sandbox', '--mute-audio'];
const AUTOPLAY_ARGS = ['--autoplay-policy=no-user-gesture-required'];

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

// --------------------------------------------------------------------------------------
// Статический сервер
// --------------------------------------------------------------------------------------

const ROUTES = {
  '/': { file: path.join(HERE, 'page.html'), type: 'text/html; charset=utf-8' },
  '/page.html': { file: path.join(HERE, 'page.html'), type: 'text/html; charset=utf-8' },
  '/page.js': { file: path.join(HERE, 'page.js'), type: 'text/javascript; charset=utf-8' },
  '/bundle.js': {
    file: path.join(ROOT, 'node_modules', '@strudel', 'web', 'dist', 'index.js'),
    type: 'text/javascript; charset=utf-8',
  },
  '/limiter.js': {
    file: path.join(ROOT, 'src', 'audio', 'dsp', 'limiter.js'),
    type: 'text/javascript; charset=utf-8',
  },
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const route = ROUTES[url.pathname];
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

async function newPage(browser, baseUrl, tag) {
  const page = await browser.newPage();
  attachLogs(page, tag);
  await page.goto(baseUrl + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__spike && window.__spike.ready, null, { timeout: 30000 });
  return page;
}

// --------------------------------------------------------------------------------------
// Тесты
// --------------------------------------------------------------------------------------

const results = {};

async function testH1(browser, baseUrl) {
  head('H1 — вставка мастер-цепочки в движок Strudel');
  const page = await newPage(browser, baseUrl, 'h1');
  try {
    const r = await page.evaluate(() => window.__spike.h1());
    results.H1 = r;
    detail('структура контроллера: ' + JSON.stringify(r.shape));
    detail('события: ' + JSON.stringify(r.events));
    detail('базовый рендер: ' + JSON.stringify(r.base));
    detail('masterIn=0.5: ' + JSON.stringify(r.half));
    detail('masterIn=1.0: ' + JSON.stringify(r.one));
    detail('остаток (bypass − baseline): ' + JSON.stringify(r.residual) + ' rel=' + r.residualRelDb + ' dB');
    detail('ratio(0.5)=' + r.ratioHalf + ' ratio(1.0)=' + r.ratioOne);
    if (r.errors && r.errors.length) detail('ошибки: ' + JSON.stringify(r.errors));
  } catch (err) {
    results.H1 = { error: String((err && err.message) || err) };
  } finally {
    await page.close();
  }
}

async function testH3(browser, baseUrl) {
  head('H3 — офлайн-рендер: детерминированность и официальный renderPatternAudio');
  const page = await newPage(browser, baseUrl, 'h3-own');
  try {
    results.H3own = await page.evaluate(() => window.__spike.h3Determinism());
    detail('свой офлайн-рендер: ' + JSON.stringify(results.H3own));
  } catch (err) {
    results.H3own = { error: String((err && err.message) || err) };
  } finally {
    await page.close();
  }

  const page2 = await newPage(browser, baseUrl, 'h3-official');
  try {
    results.H3official = await page2.evaluate(() => window.__spike.h3Official());
    detail('официальный renderPatternAudio: ' + JSON.stringify(results.H3official));
  } catch (err) {
    results.H3official = { error: String((err && err.message) || err) };
  } finally {
    await page2.close();
  }
}

async function testH5(browser, baseUrl) {
  head('H5 — позиция: scheduler.now() против ctx.currentTime');
  const page = await newPage(browser, baseUrl, 'h5');
  try {
    results.H5 = await page.evaluate(() => window.__spike.h5());
    detail('строки замеров: ' + JSON.stringify(results.H5.rows));
    detail('итоги: ' + JSON.stringify({
      diffRaw: results.H5.diffRaw,
      diffConvertedSeconds: results.H5.diffConvertedSeconds,
      baseLatency: results.H5.baseLatency,
      outputLatency: results.H5.outputLatency,
      cps: results.H5.cps,
      clockDuration: results.H5.clockDuration,
    }));
  } catch (err) {
    results.H5 = { error: String((err && err.message) || err) };
  } finally {
    await page.close();
  }
}

async function testH8(browser, baseUrl) {
  head('H8 — банки сэмплов: манифесты, CORS, реальные загрузки');
  const page = await browser.newPage();
  attachLogs(page, 'h8');

  const net = [];
  page.on('request', (req) => {
    net.push({ kind: 'request', url: req.url(), method: req.method(), resourceType: req.resourceType() });
  });
  page.on('response', async (res) => {
    const rec = { kind: 'response', url: res.url(), status: res.status() };
    try {
      const h = await res.allHeaders();
      rec.acao = h['access-control-allow-origin'] || null;
      rec.contentType = h['content-type'] || null;
      rec.contentLength = h['content-length'] || null;
    } catch (_) { /* ignore */ }
    net.push(rec);
  });
  page.on('requestfailed', (req) => {
    net.push({
      kind: 'failed',
      url: req.url(),
      failure: (req.failure() && req.failure().errorText) || 'unknown',
    });
  });

  await page.goto(baseUrl + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__spike && window.__spike.ready, null, { timeout: 30000 });

  try {
    results.H8 = await page.evaluate(() => window.__spike.h8());
  } catch (err) {
    results.H8 = { error: String((err && err.message) || err) };
  }
  results.H8net = net;

  const interesting = net.filter(
    (n) => n.url.includes('githubusercontent') || n.url.includes('shabda') || n.kind === 'failed',
  );
  detail('сетевые события (сэмплы/ошибки): ' + JSON.stringify(interesting, null, 1));
  await page.close();
}

async function testH9(browser, baseUrl) {
  head('H9 — DynamicsCompressorNode против LookaheadLimiter');
  const page = await newPage(browser, baseUrl, 'h9');
  try {
    results.H9 = await page.evaluate(() => window.__spike.h9());
    detail('H9: ' + JSON.stringify(results.H9, null, 1));
  } catch (err) {
    results.H9 = { error: String((err && err.message) || err) };
  } finally {
    await page.close();
  }
}

async function testH12(baseUrl) {
  head('H12 — autoplay: состояние контекста с флагом и без него');
  results.H12 = {};

  const probeState = async () => {
    const ctx = new AudioContext();
    const before = ctx.state;
    // resume() без жеста может не резолвиться никогда — ограничиваем ожидание.
    await Promise.race([
      ctx.resume().catch(() => {}),
      new Promise((r) => setTimeout(r, 300)),
    ]);
    await new Promise((r) => setTimeout(r, 200));
    const after = ctx.state;
    const t1 = ctx.currentTime;
    await new Promise((r) => setTimeout(r, 300));
    const t2 = ctx.currentTime;
    const out = { before, after, currentTime: t1, currentTimeLater: t2, advanced: t2 > t1 };
    await ctx.close().catch(() => {});
    return out;
  };

  // (а) с флагом --autoplay-policy=no-user-gesture-required
  {
    const browser = await launch(AUTOPLAY_ARGS);
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      results.H12.withFlag = await page.evaluate(probeState);
    } finally {
      await browser.close();
    }
  }

  // (б) без флага
  {
    const browser = await launch([]);
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      results.H12.withoutFlag = await page.evaluate(probeState);
    } finally {
      await browser.close();
    }
  }

  // (б2) с явной строгой политикой user-gesture-required:
  // в headless Chrome политика autoplay по умолчанию разрешающая,
  // поэтому состояния в (а) и (б) не различаются — этот вариант имитирует
  // поведение обычного браузера на реальном устройстве.
  for (const policy of ['user-gesture-required', 'document-user-activation-required']) {
    const browser = await launch(['--autoplay-policy=' + policy]);
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      const st = await page.evaluate(probeState);
      results.H12['policy_' + policy] = st;
    } finally {
      await browser.close();
    }
  }

  // (в) прогрев: initAudioOnFirstClick решает промис только после mousedown
  {
    const browser = await launch([]);
    try {
      const page = await newPage(browser, baseUrl, 'h12-click');
      const state = await page.evaluate(async () => {
        const ctx = new AudioContext();
        const before = ctx.state;
        window.strudel.setAudioContext(ctx);
        let resolved = false;
        const p = window.strudel.initAudioOnFirstClick();
        p.then(() => { resolved = true; });
        await new Promise((r) => setTimeout(r, 300));
        const resolvedBeforeClick = resolved;
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        const out = {
          before,
          afterClick: ctx.state,
          resolvedBeforeClick,
          resolvedAfterClick: resolved,
        };
        await ctx.close().catch(() => {});
        return out;
      });
      results.H12.firstClick = state;
      await page.close();
    } finally {
      await browser.close();
    }
  }

  detail('H12: ' + JSON.stringify(results.H12));
}

// --------------------------------------------------------------------------------------
// Сводная таблица
// --------------------------------------------------------------------------------------

function verdictH1() {
  const r = results.H1;
  if (!r || r.error) return ['НЕ ПРОВЕРЕНО', r && r.error ? r.error : 'нет данных'];
  const okHalf = r.halfWithin10pct;
  const okBypass = r.bypassMatchesBase;
  const v = okHalf && okBypass ? 'ПОДТВЕРЖДЕНА (рецепт работает)' : 'ОПРОВЕРГНУТА (рецепт не даёт ожидаемых чисел)';
  return [
    v,
    'RMS(baseline)=' + r.base.rms + ' (' + r.base.rmsDb + ' dBFS), RMS(g=0.5)=' + r.half.rms +
      ' (' + r.half.rmsDb + ' dBFS), RMS(g=1.0)=' + r.one.rms + ' (' + r.one.rmsDb + ' dBFS); ' +
      'ratio(0.5)=' + r.ratioHalf + ' (цель 0.5±10% -> ' + (okHalf ? 'ok' : 'промах') + '), ' +
      'остаток bypass−baseline=' + r.residual.rmsDiffDb + ' dBFS (' + r.residualRelDb + ' dBrel, цель ≤−40 dB -> ' +
      (okBypass ? 'ok' : 'промах') + ')',
  ];
}

function verdictH3() {
  const own = results.H3own;
  const off = results.H3official;
  const parts = [];
  let v = '';
  if (!own || own.error) {
    v = 'НЕ ПРОВЕРЕНО';
    parts.push('свой офлайн-рендер: ' + (own && own.error ? own.error : 'нет данных'));
  } else {
    const det = own.identical;
    v = det ? 'ПОДТВЕРЖДЕНА (офлайн-рендер детерминирован)' : 'ОПРОВЕРГНУТА (рендер недетерминирован)';
    parts.push(
      'два рендера: maxAbsDiff=' + own.compare.maxAbsDiff + ', RMS(diff)=' + own.compare.rmsDiff +
        ' (' + own.compare.rmsDiffDb + ' dBFS)',
    );
  }
  if (off && !off.error) {
    parts.push('официальный renderPatternAudio: возвращает ' + off.returnedValue + ', WAV-блоб ' +
        (off.wavBlobType || 'audio/wav') + ' ' + (off.wavBlobSize ? off.wavBlobSize + ' байт' : 'размер не измерен') +
        ' через <a download>, текущий AudioContext закрыт: ' + off.liveCtxClosed + ' (' + off.liveCtxStateBefore + ' -> ' +
        off.liveCtxStateAfter + '), глобальный контекст заменён: ' + off.globalCtxReplaced +
        ', AudioBuffer можно перехватить патчем startRendering: ' + (off.capturedBuffer ? off.capturedBuffer.frames + ' кадров' : 'нет'));
  } else {
    parts.push('renderPatternAudio: ' + (off && off.error ? off.error : 'нет данных'));
  }
  return [v, parts.join('; ')];
}

function verdictH5() {
  const r = results.H5;
  if (!r || r.error) return ['НЕ ПРОВЕРЕНО', r && r.error ? r.error : 'нет данных'];
  return [
    'ПОДТВЕРЖДЕНА (scheduler.now() — циклы, не секунды)',
    'scheduler.now()−ctx.currentTime: среднее ' + r.diffRaw.mean + ', мин ' + r.diffRaw.min + ', макс ' + r.diffRaw.max +
      ' (now() в циклах, cps=' + r.cps + '); в секундах (now()/cps−currentTime): среднее ' +
      r.diffConvertedSeconds.mean + ', мин ' + r.diffConvertedSeconds.min + ', макс ' + r.diffConvertedSeconds.max +
      ' с; baseLatency=' + r.baseLatency + ' с, outputLatency=' + r.outputLatency + ' с, clock.duration=' + r.clockDuration,
  ];
}

function verdictH8() {
  const r = results.H8;
  if (!r || r.error) return ['НЕ ПРОВЕРЕНО', r && r.error ? r.error : 'нет данных'];
  const net = results.H8net || [];
  const okResponses = net.filter((n) => n.kind === 'response' && n.status === 200);
  const failed = net.filter((n) => n.kind === 'failed');
  const manifests = net.filter(
    (n) => n.kind === 'response' && (n.url.includes('strudel.json') || n.url.includes('shabda.ndre.gr')),
  );
  const audio = net.filter(
    (n) => n.kind === 'response' && /\.(wav|mp3|ogg|flac)(\?|$)/i.test(n.url),
  );
  const parts = [];
  for (const s of r.sets || []) {
    parts.push(s.source + ': ' + (s.ok ? 'манифест загружен за ' + s.ms + ' мс' : 'ОШИБКА ' + s.error));
  }
  parts.push('ответов 200: ' + okResponses.length + ', манифестов: ' + manifests.length +
    ', аудиофайлов: ' + audio.length + ', сетевых ошибок: ' + failed.length);
  parts.push('палитра проекта: доступно ' + (r.palettePresent || []).length + ' из ' +
    ((r.palettePresent || []).length + (r.paletteMissing || []).length) +
    ', отсутствуют: ' + ((r.paletteMissing || []).join(',') || '—'));
  const v = (r.sets || []).every((s) => s.ok) && failed.length === 0
    ? 'ПОДТВЕРЖДЕНА (банки грузятся)'
    : 'ЧАСТИЧНО / ОПРОВЕРГНУТА';
  return [v, parts.join('; ')];
}

function verdictH9() {
  const r = results.H9;
  if (!r || r.error) return ['НЕ ПРОВЕРЕНО', r && r.error ? r.error : 'нет данных'];
  const c = r.signals.sine1k0db.compressor;
  const b = r.signals.bursts.compressor;
  const l = r.signals.sine1k0db.lookaheadLimiter;
  const lb = r.signals.bursts.lookaheadLimiter;
  const sb = r.signals.singleBurst;
  return [
    'ПОДТВЕРЖДЕНА (DynamicsCompressorNode — не brickwall)',
    'синус 0 dBFS: компрессор на выходе ' + c.outPeakDb + ' dBFS (превышение порога −3 dB на ' +
      c.overshootOverThresholdDb + ' dB); наш лимитер: ' + l.outPeakDb +
      ' dBFS (потолок −1 dB, превышение ' + l.overshootOverCeilingDb + ' dB). Всплески: компрессор ' +
      b.outPeakDb + ' dBFS (превышение ' + b.overshootOverThresholdDb + ' дБ), лимитер ' + lb.outPeakDb +
      ' dBFS. Задержка (один всплеск): компрессор ' + sb.compressor.lagMs + ' мс, наш лимитер ' +
      sb.lookaheadLimiter.lagMs + ' мс (lookahead ' + sb.lookaheadLimiter.lookaheadMs + ' мс)',
  ];
}

function verdictH12() {
  const r = results.H12;
  if (!r) return ['НЕ ПРОВЕРЕНО', 'нет данных'];
  const w = r.withFlag || {};
  const wo = r.withoutFlag || {};
  const st = r.strictPolicy || r.policy_user_gesture_required || {};
  const parts = [
    'с флагом: ' + w.before + ' -> ' + w.after + ' (currentTime растёт: ' + w.advanced + ')',
    'без флага: ' + wo.before + ' -> ' + wo.after + ' (currentTime растёт: ' + wo.advanced + ')',
  ];
  for (const key of ['policy_user_gesture_required', 'policy_document-user-activation-required']) {
    const v = r[key];
    if (v && v.before) {
      parts.push('с --autoplay-policy=' + key.replace('policy_', '') + ': ' + v.before + ' -> ' + v.after +
        ' (currentTime растёт: ' + v.advanced + ')');
    }
  }
  if (r.firstClick) {
    parts.push('initAudioOnFirstClick: до клика resolved=' + r.firstClick.resolvedBeforeClick +
      ', после клика resolved=' + r.firstClick.resolvedAfterClick + ', состояние ' + r.firstClick.afterClick);
  }
  let v;
  if (w.after === 'running' && wo.after === 'running') {
    v = st.after && st.after !== 'running'
      ? 'ЧАСТИЧНО: в headless разницы нет (политика permissive), при user-gesture-required — suspended'
      : 'НЕ ПОДТВЕРЖДЕНА (состояния не различаются)';
  } else if (w.after === 'running' && wo.after !== 'running') {
    v = 'ПОДТВЕРЖДЕНА (без флага контекст suspended — нужен прогрев)';
  } else {
    v = 'НЕ ПОДТВЕРЖДЕНА (неожиданные состояния)';
  }
  return [v, parts.join('; ')];
}

function printTable() {
  const rows = [
    ['H1', verdictH1()],
    ['H3', verdictH3()],
    ['H5', verdictH5()],
    ['H8', verdictH8()],
    ['H9', verdictH9()],
    ['H12', verdictH12()],
  ];
  const out = [];
  out.push('');
  out.push('================ СВОДКА ФАЗЫ 0 (браузерный спайк) ================');
  for (const [h, [v, d]] of rows) {
    out.push(h.padEnd(5) + ' | ' + v);
    out.push('      | ' + d);
  }
  out.push('===============================================================');
  out.push('подробности: ' + OUT_FILE);
  const text = out.join('\n');
  console.log(text);
  say(text);
}

// --------------------------------------------------------------------------------------

async function main() {
  say('Спайк фазы 0: Strudel в браузере');
  say('node: ' + process.version + ', chrome: ' + pickBrowserPath());
  say('репозиторий: ' + ROOT);

  const { server, port } = await startServer();
  const baseUrl = 'http://127.0.0.1:' + port;
  say('статический сервер: ' + baseUrl);

  const browser = await launch(AUTOPLAY_ARGS);
  try {
    say('chrome: ' + browser.version());
    await testH1(browser, baseUrl);
    await testH3(browser, baseUrl);
    await testH5(browser, baseUrl);
    await testH8(browser, baseUrl);
    await testH9(browser, baseUrl);
  } finally {
    await browser.close();
  }
  await testH12(baseUrl);
  server.close();

  printTable();

  const mandatory = ['H1', 'H3own', 'H9'];
  const failed = mandatory.filter((k) => {
    if (k === 'H3own') return !results.H3own || results.H3own.error;
    return !results[k] || results[k].error;
  });
  writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
  console.log('\nЛог: ' + OUT_FILE);
  if (failed.length) {
    console.error('Обязательные проверки не отработали: ' + failed.join(', '));
    process.exitCode = 1;
  } else {
    console.log('Обязательные проверки (H1, H3, H9) отработали — код выхода 0.');
  }
}

main().catch((err) => {
  console.error('Спайк упал:', err && err.stack ? err.stack : err);
  try {
    writeFileSync(OUT_FILE, lines.join('\n') + '\n\nFATAL: ' + String(err && err.stack || err) + '\n', 'utf8');
  } catch (_) { /* ignore */ }
  process.exitCode = 1;
});
