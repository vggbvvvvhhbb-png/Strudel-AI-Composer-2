// Node-сторона рендер-воркера режима «Разбор».
//
// ЗАЧЕМ. На сервере нет ни Web Audio, ни OfflineAudioContext, поэтому Strudel-код
// нельзя отрендерить в звук напрямую. Но звук нужен: без него нечем сравнивать
// двойник с оригиналом (log-mel cosine) и нечем честно мерить громкость рендера.
//
// РЕШЕНИЕ. Настоящий движок (superdough) работает в headless-браузере: тот же
// код, что и в студии, тот же реестр сэмплов. Браузер отдаёт WAV и метрики,
// Node считает свою часть DSP по тем же модулям (src/audio/dsp/*), что и браузер.
//
// ДЕТЕРМИНИЗМ. Для чистых осцилляторов и чистых сэмплов два прогона подряд
// дают maxAbsDiff = 0 (tests/spike/browser/out-offline.txt). Для СМЕСИ
// осциллятора и сэмпла — расхождение до 1 LSB 16-битного звука (≈3.1e-5) в
// единицах на миллион: это в пределах допуска проекта (docs/BRIEF.md:73,
// maxAbsDiff ≤ 1e-4), но НЕ побитовое совпадение (docs/EXPERIMENTS.md E-019).
// Паспорт рендера (renderFingerprint) обязателен: без него метрики разных
// прогонов несравнимы (docs/BRIEF.md:73).
//
// ОГРАНИЧЕНИЕ. Офлайн-рендер — операция с глобальным состоянием: движок
// переключает глобальный аудиоконтекст, поэтому два рендера «в одном флаконе»
// перехватывают контекст друг у друга (docs/HANDOFF.md:28-43).
// => Рендеры строго последовательные. Это ограничение движка, не воркера.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { POOL_AUDIO_DIR } from '../../samples/pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

export const DEFAULT_SAMPLE_RATE = 48000;
export const DEFAULT_CPS = 0.5; // 120 BPM: один такт (цикл) = 2 с

const BUNDLE_FILE = path.join(HERE, 'dist', 'render-bundle.js');
const STRUDEL_BUNDLE = path.join(ROOT, 'node_modules', '@strudel', 'web', 'dist', 'index.js');
const PAGE_FILE = path.join(HERE, 'render-page.html');

// Браузер ищется в стандартных местах; переменная CHROME_PATH переопределяет.
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const BASE_ARGS = ['--no-sandbox', '--mute-audio'];
const AUTOPLAY_ARGS = ['--autoplay-policy=no-user-gesture-required'];

function pickBrowserPath() {
  for (const candidate of CHROME_PATHS) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Не найден ни Chrome, ни Edge в стандартных путях. Задайте CHROME_PATH или поставьте браузер в образ.',
  );
}

/** sha256 кода — часть паспорта рендера. */
export function codeFingerprint(code) {
  return createHash('sha256').update(String(code ?? ''), 'utf8').digest('hex');
}

/**
 * Собирает браузерный бандл (esbuild). Нужен только в режиме разработки:
 * в образе бандл собирается на этапе сборки (npm run build:render).
 */
export async function buildRenderBundle({ outFile = BUNDLE_FILE, esbuild } = {}) {
  const build = esbuild || (await import('esbuild')).default;
  await build.build({
    entryPoints: [path.join(HERE, 'browser-entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110'],
    outfile: outFile,
    legalComments: 'none',
    logLevel: 'error',
  });
  return outFile;
}

/** WAV пула «Охотника» для браузера: только имя файла, без путей (D-119). */
export function poolAudioFile(name) {
  if (typeof name !== 'string' || !/^[\w-]+\.wav$/.test(name)) return null;
  const file = path.join(POOL_AUDIO_DIR, name);
  if (!file.startsWith(POOL_AUDIO_DIR + path.sep)) return null;
  return existsSync(file) ? file : null;
}

/** Статический сервер: страница + наш бандл + UMD-движок Strudel + WAV пула. */
function startServer() {
  const routes = {
    '/': { file: PAGE_FILE, type: 'text/html; charset=utf-8' },
    '/render-page.html': { file: PAGE_FILE, type: 'text/html; charset=utf-8' },
    '/render-bundle.js': { file: BUNDLE_FILE, type: 'text/javascript; charset=utf-8' },
    '/bundle.js': { file: STRUDEL_BUNDLE, type: 'text/javascript; charset=utf-8' },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/pool-audio/')) {
      const file = poolAudioFile(url.pathname.slice('/pool-audio/'.length));
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(err && err.message));
      }
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
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Создаёт рендер-воркер: браузер + страница + готовый движок.
 *
 * @param {{headless?:boolean, timeoutMs?:number, browser?:object}} [options]
 */
export async function createRenderWorker(options = {}) {
  if (!existsSync(BUNDLE_FILE)) {
    await buildRenderBundle(options);
  }
  if (!existsSync(STRUDEL_BUNDLE)) {
    throw new Error('Нет node_modules/@strudel/web — сначала npm install');
  }

  const { chromium } = options.browser || (await import('playwright-core'));
  const { server, port } = await startServer();

  const browser = await chromium.launch({
    executablePath: pickBrowserPath(),
    headless: options.headless !== false,
    args: [...BASE_ARGS, ...AUTOPLAY_ARGS],
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err && err.message)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(`http://127.0.0.1:${port}/render-page.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__renderTwin && window.__renderTwin.ready, null, { timeout: options.timeoutMs ?? 60000 });
  const init = await page.evaluate(() => window.__renderTwin.init());
  if (!init || init.ok !== true) {
    await browser.close();
    server.close();
    throw new Error('Движок в браузере не инициализировался: ' + JSON.stringify(init));
  }

  const worker = {
    browser,
    page,
    consoleErrors,

    /**
     * Рендерит код в аудио.
     *
     * @param {{code:string, fromCycle?:number, toCycle?:number, sampleRate?:number,
     *          cps?:number, wantWav?:boolean, wantEvents?:boolean}} args
     * @returns {Promise<{ok:boolean, report:object, wav:Buffer|null, events:Array|null,
     *                    sampleRate:number, durationS:number, renderMs:number, fingerprint:object}>}
     */
    async render(args) {
      const startedAt = Date.now();
      // Сэмплы пула «Охотника» (D-119): браузер грузит их с этого же сервера.
      const poolSamples = (Array.isArray(args.poolSamples) ? args.poolSamples : [])
        .filter((s) => s && /^[\w-]+$/.test(String(s.id)) && /^[\w:-]+$/.test(String(s.sound)))
        .map((s) => ({ id: String(s.id), sound: String(s.sound) }));
      const payload = await page.evaluate((a) => window.__renderTwin.render(a), {
        code: args.code,
        fromCycle: args.fromCycle ?? 0,
        toCycle: args.toCycle ?? 16,
        sampleRate: args.sampleRate ?? DEFAULT_SAMPLE_RATE,
        cps: args.cps ?? DEFAULT_CPS,
        wantWav: args.wantWav !== false,
        wantEvents: args.wantEvents !== false,
        poolSamples,
      });
      const wav = payload.wavBase64 ? Buffer.from(payload.wavBase64, 'base64') : null;
      const fingerprint = {
        browser: 'chromium',
        browser_version: await browser.version(),
        os: process.platform,
        engine_version: payload.report?.engineVersion ?? null,
        sample_rate: payload.sampleRate,
        code_sha256: codeFingerprint(args.code),
        seed: 'deterministic-engine',
        // Сэмплы пула — внешнее состояние рендера: без них паспорт неполон.
        ...(poolSamples.length ? { pool_samples: poolSamples.map((s) => s.sound).sort() } : {}),
      };
      return {
        ok: true,
        report: payload.report,
        wav,
        events: payload.events,
        sampleRate: payload.sampleRate,
        durationS: payload.durationS,
        renderMs: payload.renderMs,
        wallMs: Date.now() - startedAt,
        fingerprint,
      };
    },

    async close() {
      try {
        await browser.close();
      } finally {
        server.close();
      }
    },
  };
  return worker;
}
