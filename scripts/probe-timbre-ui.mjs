#!/usr/bin/env node
// Браузерный зонд этапа 4 (D-131/D-132): панель пресетов в студии
// и тембровый A/B в тиндере. Запуск: npm run build && node scripts/probe-timbre-ui.mjs
//
// Проверяется то, что нельзя проверить в node-тестах:
//   • чип звука в таймлайне открывает панель, карточки несут лицензию,
//     паспорт и превью preload=none;
//   • резолвер с профилем warm ставит тёплый пресет первым;
//   • применение меняет .s() в коде, чип обновляется, live-правка не падает;
//   • тиндер в режиме «тембры» рендерит пару, метка уходит с pairType=timbre,
//     счётчик тембров растёт, покрытие промтов НЕ двигается;
//   • трековый режим тиндера не сломан.
//
// Метки пишутся во временный каталог (STRUDEL_DATA_DIR): настоящие метки
// владельца не трогаются. Результат — docs/evidence/timbre/ui-probe.json
// и скриншоты рядом.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { pickBrowserPath, sweepStaleBrowserProfilesOnce, formatSweepReport } from '../lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PROBE_PORT || 3117);
const BASE = `http://127.0.0.1:${PORT}`;
const EVIDENCE = path.join(ROOT, 'docs', 'evidence', 'timbre');

// Уборка осиротевших профилей Playwright: один раз на процесс, до запуска
// браузера (модуль сам глотает ошибки доступа к tmpdir).
const sweep = sweepStaleBrowserProfilesOnce();
if (sweep) console.log(formatSweepReport(sweep));

const steps = [];
function ok(name, detail = '') {
  steps.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail) {
  steps.push({ name, ok: false, detail });
  console.error(`  ✗ ${name} — ${detail}`);
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('✗ нет сборки: сначала npm run build');
    process.exit(1);
  }
  mkdirSync(EVIDENCE, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'strudel-timbre-ui-probe-'));
  const startedAt = Date.now();

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      MOCK_LLM: '1',
      NODE_ENV: 'test',
      STRUDEL_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

  let browser = null;
  const numbers = {};
  try {
    if (!(await waitForServer())) {
      console.error('✗ сервер не поднялся:\n' + serverLog.join(''));
      process.exit(1);
    }
    ok('сервер поднялся', BASE);

    browser = await chromium.launch({
      executablePath: pickBrowserPath(),
      args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    // --- Студия: панель выбора инструмента ---
    await page.goto(`${BASE}/studio.html`, { waitUntil: 'domcontentloaded' });
    await page.click('#tl-demo-opera');
    await page.waitForSelector('.tl-row', { timeout: 60_000 });
    numbers.timelineRows = await page.locator('.tl-row').count();
    ok('демо-опера в таймлайне', `${numbers.timelineRows} дорожек`);

    const keysChip = page.locator('.tl-group-keys .tl-sound').first();
    await keysChip.waitFor({ timeout: 15_000 });
    const chipBefore = await keysChip.textContent();
    await keysChip.click();
    await page.waitForSelector('.tp-panel', { timeout: 15_000 });
    await page.waitForSelector('.tp-card', { timeout: 15_000 });
    numbers.catalogCards = await page.locator('.tp-cards').nth(1).locator('.tp-card').count();
    const licenses = await page.locator('.tp-license').allTextContents();
    const previews = await page.locator('.tp-card audio[preload="none"]').count();
    if (numbers.catalogCards > 0 && licenses.every((text) => text.includes('CC0'))) {
      ok('карточки каталога с лицензией', `${numbers.catalogCards} карточек, превью preload=none: ${previews}`);
    } else {
      fail('карточки каталога', `карточек ${numbers.catalogCards}, лицензии: ${licenses.join(', ')}`);
    }
    numbers.previewPlayers = previews;

    // Резолвер: профиль warm → тёплый пресет клавишных первым.
    await page.selectOption('select[aria-label="Профиль тембра"]', 'warm');
    await page.waitForFunction(
      () => document.querySelector('.tp-cards .tp-card')?.dataset.presetId === 'tp-upright-soft-v1',
      { timeout: 15_000 },
    );
    numbers.resolverTopWarm = 'tp-upright-soft-v1';
    ok('резолвер: warm ставит тёплый пресет первым', 'tp-upright-soft-v1');
    await page.screenshot({ path: path.join(EVIDENCE, 'ui-picker.png') });

    const applyBtn = page.locator('.tp-cards .tp-card[data-preset-id="tp-upright-soft-v1"] .tp-apply').first();
    await applyBtn.click();
    await page.waitForSelector('.tp-overlay', { state: 'detached', timeout: 30_000 });
    const code = await page.inputValue('#code-input');
    const chipAfter = await keysChip.textContent();
    if (code.includes('tp_upright_soft_v1') && chipAfter.includes('tp_upright_soft_v1')) {
      ok('пресет применён к партии', `чип: ${chipBefore} → ${chipAfter}`);
    } else {
      fail('пресет применён', `код содержит alias: ${code.includes('tp_upright_soft_v1')}, чип: ${chipAfter}`);
    }
    // Live-правка: даём движку прогреть пресет и оценить код.
    await page.waitForTimeout(4000);
    const logText = await page.locator('#log').textContent().catch(() => '');
    const liveErrors = /Ошибка после правки таймлайна|Пресеты тембра не загрузились/.test(logText ?? '');
    if (!liveErrors) ok('live-правка без ошибок', 'прогрев пресета и evaluate прошли');
    else fail('live-правка', logText.slice(-300));
    numbers.studioConsoleErrors = consoleErrors.length;

    // --- Тиндер: тембровый A/B ---
    consoleErrors.length = 0;
    await page.goto(`${BASE}/tinder.html`, { waitUntil: 'domcontentloaded' });
    await page.selectOption('#pair-mode', 'timbre');
    await page.click('#btn-start');
    await page.waitForFunction(
      () => /Слушайте|Не удалось|не загрузил/.test(document.getElementById('status')?.textContent ?? ''),
      { timeout: 120_000 },
    );
    const status = await page.locator('#status').textContent();
    if (!status.includes('Слушайте')) {
      fail('тембровая пара отрендерилась', status.slice(0, 200));
    } else {
      ok('тембровая пара отрендерилась', status.slice(0, 90));
    }
    const context = await page.locator('#pair-context').textContent();
    const contextVisible = await page.locator('#pair-context').isVisible();
    if (contextVisible && context.includes('Партия')) ok('контекст партии показан', context.slice(0, 90));
    else fail('контекст партии', `visible=${contextVisible}: ${context}`);

    // Слушаем пару перед суждением (человеческий темп): офлайн-рендер
    // подряд без паузы ловит гонку удержания узлов superdough (D-133).
    await page.waitForTimeout(4000);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelectorAll('#log li').length >= 1, { timeout: 15_000 });
    const stats = await page.evaluate(() => fetch('/api/preference/stats').then((res) => res.json()));
    numbers.timbreJudged = stats.timbreJudged;
    numbers.uniquePromptsAfterTimbre = stats.uniquePrompts;
    if (stats.timbreJudged >= 1 && stats.uniquePrompts === 0) {
      ok('метка записана как тембровая', `timbreJudged=${stats.timbreJudged}, промтов закрыто: ${stats.uniquePrompts}`);
    } else {
      fail('метка тембровая', JSON.stringify(stats).slice(0, 200));
    }
    const progress = await page.locator('#progress').textContent();
    if (progress.includes('тембров')) ok('прогресс тембров отдельный', progress);
    else fail('прогресс тембров', progress);

    // Вторая пара: «ни один» (skip) — четвёртый ответ приёмки.
    await page.waitForFunction(
      () => /Слушайте/.test(document.getElementById('status')?.textContent ?? ''),
      { timeout: 120_000 },
    );
    await page.waitForTimeout(4000);
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelectorAll('#log li').length >= 2, { timeout: 15_000 });
    const logItems = await page.locator('#log li').allTextContents();
    if (logItems.some((text) => text.includes('ни один'))) ok('ответ «ни один» работает', logItems[0]);
    else fail('ответ «ни один»', logItems.join(' | ').slice(0, 200));
    await page.screenshot({ path: path.join(EVIDENCE, 'ui-tinder-timbre.png') });

    // Трековый режим не сломан: очередь загружается, пара рендерится.
    // Пауза перед переключением — человеческий темп суждения (D-133).
    await page.waitForTimeout(4000);
    await page.selectOption('#pair-mode', 'track');
    await page.waitForFunction(
      () => /Слушайте|Не удалось|не загрузил/.test(document.getElementById('status')?.textContent ?? ''),
      { timeout: 120_000 },
    );
    const trackStatus = await page.locator('#status').textContent();
    if (trackStatus.includes('Слушайте')) ok('трековый режим тиндера жив', trackStatus.slice(0, 90));
    else fail('трековый режим', trackStatus.slice(0, 200));
    const trackContextHidden = await page.locator('#pair-context').isHidden();
    if (trackContextHidden) ok('контекст тембра скрыт в трековом режиме');
    else fail('контекст тембра в трековом режиме', 'виден');
    numbers.tinderConsoleErrors = consoleErrors.length;

    const failed = steps.filter((step) => !step.ok);
    const report = {
      generatedAt: new Date().toISOString(),
      wallMs: Date.now() - startedAt,
      ok: failed.length === 0,
      steps,
      numbers,
      note: 'Метки зонда — во временном каталоге STRUDEL_DATA_DIR, настоящие метки владельца не тронуты.',
    };
    writeFileSync(path.join(EVIDENCE, 'ui-probe.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nЗонд этапа 4: ${failed.length ? 'КРАСНЫЙ' : 'зелёный'} (${steps.length - failed.length}/${steps.length})`);
    console.log('Записано: docs/evidence/timbre/ui-probe.json');
    if (failed.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('✗ зонд упал:', err);
  process.exit(1);
});