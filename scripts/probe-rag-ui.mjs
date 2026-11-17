#!/usr/bin/env node
// Браузерный зонд фазы G (D-140): панель «Музыкальный интеллект» в студии.
// Запуск: npm run build && node scripts/probe-rag-ui.mjs
//
// Проверяется то, что нельзя проверить в node-тестах:
//   • панель видна, статус базы честный (локальная/Supabase, эмбеддинги);
//   • генерация с теорией: шаги поиска и попыток видны, обоснование есть,
//     код применяется ТОЛЬКО по кнопке и попадает в редактор;
//   • объяснение кода детерминированно распознаёт ii–V–I;
//   • ошибок консоли нет.
//
// Данные изолированы: STRUDEL_DATA_DIR во временном каталоге, MOCK_LLM=1,
// Supabase принудительно отключён (зонд не трогает базу владельца).
// Результат — docs/evidence/rag/ui-probe.json и скриншоты рядом.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PROBE_PORT || 3119);
const BASE = `http://127.0.0.1:${PORT}`;
const EVIDENCE = path.join(ROOT, 'docs', 'evidence', 'rag');

const BROWSER_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
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
    } catch { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'studio.html'))) {
    console.error('✗ нет сборки: сначала npm run build');
    process.exit(1);
  }
  mkdirSync(EVIDENCE, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'strudel-rag-ui-probe-'));
  const startedAt = Date.now();

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      MOCK_LLM: '1',
      NODE_ENV: 'test',
      STRUDEL_DATA_DIR: dataDir,
      SUPABASE_DB_HOST: '',
      SUPABASE_DB_USER: '',
      SUPABASE_DB_PASSWORD: '',
    },
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
    ok('сервер поднялся', BASE);

    const status = await (await fetch(`${BASE}/api/rag/status`)).json();
    if (status.store === 'local' && status.entries === 35) {
      ok('статус базы честный', `local, ${status.entries} записей, embeddings=${status.embeddings}`);
    } else {
      fail('статус базы', JSON.stringify(status));
    }

    browser = await chromium.launch({
      executablePath: pickBrowserPath(),
      args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(`${BASE}/studio.html`, { waitUntil: 'networkidle' });
    const panelVisible = await page.locator('.rag-panel').isVisible();
    panelVisible ? ok('панель «Музыкальный интеллект» видна') : fail('панель не видна', 'нет .rag-panel');
    const statusText = await page.locator('#rag-status').textContent();
    statusText && statusText.includes('записей')
      ? ok('статус базы показан в панели', statusText.trim())
      : fail('статус в панели пуст', statusText);

    // Генерация с теорией (mock-LLM отдаёт валидный код с обоснованием).
    await page.fill('#rag-input', 'тёплые джазовые аккорды для lofi в ля миноре');
    await page.click('#rag-generate');
    await page.waitForSelector('#rag-apply:not([hidden])', { timeout: 30000 });
    const stepsText = await page.locator('#rag-steps').textContent();
    stepsText.includes('Поиск:') && stepsText.includes('Попытка 1')
      ? ok('шаги поиска и валидации видны', stepsText.replace(/\s+/g, ' ').slice(0, 120))
      : fail('шаги не видны', stepsText);
    const rationale = await page.locator('#rag-rationale').textContent();
    rationale && rationale.length > 10
      ? ok('теоретическое обоснование показано', rationale.slice(0, 80))
      : fail('обоснование пусто', rationale);

    const codeBefore = await page.locator('#code-input').inputValue();
    await page.click('#rag-apply');
    const codeAfter = await page.locator('#code-input').inputValue();
    codeAfter !== codeBefore && codeAfter.includes('setCpm') && codeAfter.includes('$')
      ? ok('код применён по кнопке', `${codeAfter.split('\n').length} строк`)
      : fail('код не применился', codeAfter.slice(0, 80));
    await page.screenshot({ path: path.join(EVIDENCE, 'ui-rag-panel.png') });

    // Объяснение кода: ii–V–I распознаётся детерминированно.
    await page.evaluate(() => {
      const el = document.getElementById('code-input');
      el.value = 'setCpm(110/4)\nconst key = "c:major"\n$CHORDS: chord("<Dm7 G7 CM7>").voicing().s("piano")';
    });
    await page.click('#rag-explain');
    await page.waitForFunction(() => document.getElementById('rag-explain-out').textContent.includes('ii–V–I'), { timeout: 10000 });
    const explainText = await page.locator('#rag-explain-out').textContent();
    explainText.includes('Каденция') && explainText.includes('тритоновая')
      ? ok('объяснение: прогрессия, каденция, совет', explainText.replace(/\s+/g, ' ').slice(0, 120))
      : fail('объяснение неполное', explainText);
    await page.screenshot({ path: path.join(EVIDENCE, 'ui-rag-explain.png') });

    consoleErrors.length === 0
      ? ok('ошибок в консоли нет')
      : fail('ошибки консоли', consoleErrors.slice(0, 3).join(' | '));
  } catch (err) {
    fail('зонд упал', String(err?.message || err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }

  const passed = steps.filter((s) => s.ok).length;
  const report = { date: new Date().toISOString(), durationMs: Date.now() - startedAt, passed, total: steps.length, steps };
  writeFileSync(path.join(EVIDENCE, 'ui-probe.json'), JSON.stringify(report, null, 2));
  console.log(`\nЗонд RAG UI: ${passed}/${steps.length} (docs/evidence/rag/ui-probe.json)`);
  process.exit(passed === steps.length ? 0 : 1);
}

main();