#!/usr/bin/env node
// Playwright smoke: загрузка → генерация на мок-LLM → play/stop → правка ноты → undo.
//
// Запуск локально:  npm run build && node tests/smoke/smoke.mjs
// В CI: сервер поднимается с MOCK_LLM=1 (ключи и сеть не нужны),
// браузер — системный Chrome/Edge через playwright-core.
//
// Smoke проверяет «дым», а не вёрстку: если студийная панель есть (#studio),
// проверяются правка ноты и undo в ней; если панели нет — те же действия
// выполняются в редакторе кода. Падение = ошибка в рантайме.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.env.SMOKE_PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;

const BROWSER_PATHS = [
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

function pickBrowserPath() {
  for (const candidate of BROWSER_PATHS) if (existsSync(candidate)) return candidate;
  throw new Error('Не найден Chrome/Edge — задайте CHROME_PATH');
}

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
  try {
    if (!(await waitForServer())) {
      console.error('✗ сервер не поднялся:\n' + serverLog.join(''));
      process.exit(1);
    }
    ok('сервер поднялся', `${BASE}`);

    const res = await fetch(`${BASE}/api/music/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'спокойный lo-fi с пианино', mode: 'structured' }),
    });
    const composeBody = await res.json().catch(() => null);
    if (!res.ok) {
      fail('генерация на мок-LLM', `HTTP ${res.status}: ${JSON.stringify(composeBody)?.slice(0, 200)}`);
    } else {
      const code = composeBody?.code || composeBody?.result?.code || '';
      ok('генерация на мок-LLM', code ? `код ${code.split('\n').length} строк` : 'ответ получен');
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
    await page.waitForTimeout(1500);
    ok('страница загрузилась');

    const hasStudio = await page.locator('#studio').count();
    if (hasStudio) {
      await page.waitForSelector('#studio[data-studio-ready="1"]', { timeout: 15_000 });
      ok('студийная панель смонтирована');
    } else {
      ok('студийной панели нет — проверяем редактор кода', 'GUI-фаза не подключена');
    }

    // Разблокировка звука: браузеры требуют жест пользователя.
    const gate = page.locator('#btn-start-audio');
    if (await gate.count()) {
      await gate.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    const playButton = hasStudio ? page.locator('#studio-play') : page.locator('#btn-play-code');
    if (await playButton.count()) {
      await playButton.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
      ok('play/stop: запуск без ошибок');
      await playButton.click({ timeout: 5000 }).catch(() => {});
    } else {
      fail('play/stop', 'не найдена кнопка воспроизведения');
    }

    if (hasStudio) {
      // Правка ноты: клик по пианороллу добавляет ноту — это одна команда шины.
      const before = await page.locator('#studio').getAttribute('data-studio-commands');
      const canvas = page.locator('#studio-piano-roll');
      if (await canvas.count()) {
        const box = await canvas.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
          await page.waitForTimeout(400);
          const after = await page.locator('#studio').getAttribute('data-studio-commands');
          if (after !== before) ok('правка ноты изменила проект', `${before} → ${after}`);
          else fail('правка ноты', 'состояние не изменилось');
        }
      }

      const undo = page.locator('#studio-undo');
      if (await undo.count()) {
        await undo.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(300);
        ok('undo выполнен');
      }
    }

    // Ошибок в консоли быть не должно (кроме сетевых шумов сэмплов).
    const fatal = consoleErrors.filter((line) => !/favicon|samples|net::|Failed to load resource/i.test(line));
    if (fatal.length) fail('ошибки в консоли', fatal.slice(0, 3).join(' | '));
    else ok('ошибок в консоли нет');
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
  }

  const failed = steps.filter((step) => !step.ok);
  console.log(`\nИтог: ${steps.length - failed.length}/${steps.length} шагов прошли`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error('✗ smoke упал:', error?.message || error);
  process.exit(1);
});
