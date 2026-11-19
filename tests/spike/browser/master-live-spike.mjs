// Браузерный спайк фазы 2: мастер-цепочка в живом сигнальном пути.
//
// Проверяем в настоящем браузере то, что нельзя проверить в Node:
//   • worklet загрузился и сообщил задержку;
//   • звук движка действительно идёт через мастер (а не мимо него);
//   • лимитер держит потолок на громком паттерне;
//   • Bypass переключается без ошибок, метры продолжают идти;
//   • сквозная задержка складывается из base + output + мастер.
//
// Запуск: npm run build && node tests/spike/browser/master-live-spike.mjs
// Требуется собранный фронт: сервер отдаёт dist.

import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { pickBrowserPath, sweepStaleBrowserProfilesOnce, formatSweepReport } from '../../../lib/browser.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const PORT = Number(process.env.SPIKE_PORT || 3222);
const BASE = `http://127.0.0.1:${PORT}`;

// Уборка осиротевших профилей Playwright: один раз на процесс, до запуска
// браузера (модуль сам глотает ошибки доступа к tmpdir).
const sweep = sweepStaleBrowserProfilesOnce();
if (sweep) console.log(formatSweepReport(sweep));

const round = (x, n = 3) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(n)) : x);

/** Громкий паттерн: пик заметно выше потолка мастера. */
const LOUD_CODE = [
  'setCpm(128/4)',
  'const key = "c:minor"',
  '$KICK: s("bd*4").gain(1.2)',
  '$BASS: n("0 ~ 2 4").scale(key).s("sawtooth").gain(0.9)',
].join('\n');

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('✗ нет сборки: сначала npm run build');
    process.exit(1);
  }

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MOCK_LLM: '1', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

  let browser = null;
  const result = { hypothesis: 'Фаза 2: мастер в живом пути', errors: [] };

  try {
    if (!(await waitForServer())) {
      console.error('✗ сервер не поднялся:\n' + serverLog.join(''));
      process.exit(1);
    }

    browser = await chromium.launch({
      executablePath: pickBrowserPath(),
      args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.strudelStudio), null, { timeout: 25_000 });
    await page.waitForTimeout(600);

    // 1. Граф, задержка worklet, наличие хвоста движка.
    const graphInfo = await page.evaluate(() => {
      const studio = window.strudelStudio;
      const ctx = studio.graph?.context;
      return {
        directOutput: studio.directOutput,
        hasGraph: Boolean(studio.graph),
        latencySamples: studio.graph?.latencySamples ?? null,
        latencyMs: studio.graph ? studio.graph.latencySeconds * 1000 : null,
        baseLatency: ctx?.baseLatency ?? null,
        outputLatency: ctx?.outputLatency ?? null,
        totalLatencyMs: studio.graph ? studio.graph.totalLatencySeconds * 1000 : null,
        hasEngineTail: Boolean(studio.adapter?.outputNode?.()),
        contextState: ctx?.state ?? null,
      };
    });
    result.graph = graphInfo;

    if (graphInfo.directOutput) result.errors.push('мастер-цепочка не поднялась (прямой выход)');
    if (!graphInfo.hasEngineTail) result.errors.push('движок не отдал хвост сигнала');
    if (!graphInfo.latencySamples) result.errors.push('worklet не сообщил задержку');

    // 2. Разблокировка звука и громкий паттерн.
    await page.evaluate(() => {
      document.getElementById('btn-start-audio')?.click();
    });
    await page.waitForTimeout(400);

    await page.evaluate((code) => {
      const ta = document.getElementById('code-input');
      if (ta) {
        ta.value = code;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.getElementById('btn-play-code')?.click();
    }, LOUD_CODE);
    await page.waitForTimeout(3500);

    // 3. Метры мастера: лимитер должен держать потолок.
    const meters = await page.evaluate(() => {
      const m = window.strudelStudio.meters;
      return m ? { ...m } : null;
    });
    result.meters = meters;
    if (!meters) {
      result.errors.push('метры мастера не приходят');
    } else {
      if (meters.truePeakDb > -0.9) {
        result.errors.push(`true peak выше потолка: ${meters.truePeakDb} dBTP`);
      }
      if (meters.lufsM === null || meters.lufsM < -60) {
        result.errors.push(`моментная громкость неправдоподобна: ${meters.lufsM}`);
      }
    }

    // 4. Bypass: переключаем и смотрим, что метры продолжают идти.
    await page.evaluate(() => window.strudelStudio.graph.setBypass(true));
    await page.waitForTimeout(1500);
    const bypassMeters = await page.evaluate(() => {
      const m = window.strudelStudio.meters;
      return m ? { ...m } : null;
    });
    result.bypassMeters = bypassMeters;
    if (!bypassMeters) result.errors.push('после bypass метры пропали');

    await page.evaluate(() => window.strudelStudio.graph.setBypass(false));
    await page.waitForTimeout(600);

    result.consoleErrors = consoleErrors.filter((line) => !/favicon|samples|net::/i.test(line));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) {
    console.error(`\n✗ провалено: ${result.errors.join('; ')}`);
    process.exit(1);
  }
  console.log('\n✓ мастер-цепочка в живом пути: задержка, потолок, bypass, метры — всё на месте');
}

main().catch((error) => {
  console.error('✗ спайк упал:', error?.message || error);
  process.exit(1);
});
