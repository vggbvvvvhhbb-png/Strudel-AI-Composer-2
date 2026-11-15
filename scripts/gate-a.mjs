#!/usr/bin/env node
// ГЕЙТ A — помощник-агент (гайд «ПРОРЫВ», §8, «ГЕЙТ A»).
//
// ЧТО ПРОВЕРЯЕМ. Гайд требует, чтобы запрос
//   «найди в интернете, что такое phonk drift, и сделай бит в этом стиле»
// агент проходил сам: ищет → читает → строит план → компилирует → играет;
// каждый шаг виден в панели; расход токенов виден в usage; без ключа поиска
// агент НЕ падает, а отвечает по каталогу и говорит об этом.
//
// КЛЮЧА ПОИСКА В РЕПОЗИТОРИИ НЕТ. Поэтому замеряемая часть гейта — честная
// деградация: полный проход с интернетом измерить нельзя, и мы это не
// выдаём за зелёное. Что измеримо и проверяется здесь:
//   1. серверный цикл: план → инструменты → наблюдение → ответ (SSE);
//   2. шаг поиска присутствует и деградирует ЧЕСТНО («Интернет недоступен»);
//   3. сборка трека продолжается: спека → компиляция → готовый код;
//   4. usage отдаёт честное число токенов (оценка помечена оценкой);
//   5. в браузере каждый шаг виден в панели, а расход токенов виден в usage.
//
// ЗАПУСК: node scripts/gate-a.mjs
// Пишет отчёт: docs/evidence/agent/gate-a.json

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.GATE_A_PORT || 3212);
const BASE = `http://127.0.0.1:${PORT}`;

const QUERY = 'найди в интернете, что такое phonk drift, и сделай бит в этом стиле';

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

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(ok);
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

/** Разбирает поток SSE в массив событий. */
function parseSSE(raw) {
  return raw
    .trim()
    .split('\n\n')
    .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice('data: '.length)));
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
  const measured = {};
  try {
    if (!(await waitForServer())) {
      console.error('✗ сервер не поднялся:\n' + serverLog.join(''));
      process.exit(1);
    }

    // --- 1. Серверный цикл на запросе гайда ----------------------------
    const res = await fetch(`${BASE}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: QUERY }),
    });
    const raw = await res.text();
    const events = parseSSE(raw);
    const types = events.map((event) => event.type);
    const plan = events.find((event) => event.type === 'plan');
    const done = events.find((event) => event.type === 'done');
    const usage = events.find((event) => event.type === 'usage');
    const toolEnds = events.filter((event) => event.type === 'tool_end');

    measured.server = {
      httpStatus: res.status,
      eventTypes: types,
      mode: plan?.mode ?? null,
      planSource: plan?.planSource ?? null,
      planSteps: (plan?.steps ?? []).map((step) => step.tool),
      tools: toolEnds.map((event) => ({
        tool: event.id,
        ok: event.ok,
        degraded: event.degraded,
        reason: event.reason ?? null,
        ms: event.ms ?? null,
      })),
      usage: usage ?? null,
      degraded: done?.degraded ?? [],
      codeChars: (done?.track?.code ?? '').length,
      answerChars: (done?.answer ?? '').length,
    };

    check('цикл отдаёт план, шаги и ответ', types.includes('plan') && types.includes('tool_end') && types.includes('done'),
      `события: ${[...new Set(types)].join(', ')}`);
    check('режим — композитор (цель запроса — бит)', plan?.mode === 'composer', `режим: ${plan?.mode}`);
    check('в плане есть поиск, сборка и компиляция',
      ['web_search', 'compose_spec', 'compile'].every((tool) => measured.server.planSteps.includes(tool)),
      `шаги: ${measured.server.planSteps.join(', ')}`);

    const search = toolEnds.find((event) => event.id === 'web_search');
    check('поиск без ключа не проходит и это сказано прямо',
      search && search.ok === false && search.degraded === true && /Интернет недоступен/.test(search.reason ?? ''),
      search?.reason ?? 'шага поиска не было');
    check('агент не упал и перешёл к сборке',
      toolEnds.some((event) => event.id === 'compose_spec' && event.ok),
      `инструментов выполнено: ${toolEnds.length}`);
    check('трек собран: код получен', measured.server.codeChars > 0, `символов кода: ${measured.server.codeChars}`);
    check('деградация видна в итоге агента',
      (done?.degraded ?? []).some((item) => item.tool === 'web_search'),
      `деградировало: ${(done?.degraded ?? []).map((item) => item.tool).join(', ') || 'нет'}`);
    check('usage отдаёт честное число токенов',
      Boolean(usage) && usage.tokens > 0 && usage.estimated === true,
      usage ? `токенов ≈ ${usage.tokens} (оценка: ${usage.estimated}), цена измерена: ${usage.priceKnown}` : 'события usage не было');

    // --- 2. Панель в браузере: каждый шаг виден -------------------------
    browser = await chromium.launch({
      executablePath: pickBrowserPath(),
      args: ['--no-sandbox', '--mute-audio'],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    await page.goto(`${BASE}/studio.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    await page.fill('#agent-input', QUERY);
    await page.click('#agent-send');
    await page.waitForSelector('.agent-plan', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const panel = await page.evaluate(() => ({
      planSteps: document.querySelectorAll('.agent-step').length,
      toolCards: document.querySelectorAll('.agent-tool').length,
      failed: document.querySelectorAll('.agent-tool.is-failed').length,
      usage: document.querySelector('#agent-usage')?.textContent?.trim() ?? '',
      summary: document.querySelector('#agent-summary')?.textContent?.trim() ?? '',
      applyButton: document.querySelectorAll('.agent-apply button').length,
      services: document.querySelector('#agent-services')?.textContent?.trim() ?? '',
      panelVisible: (() => {
        const node = document.querySelector('.agent-panel');
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.top < innerHeight;
      })(),
    }));
    measured.panel = panel;

    check('панель агента видна на первом экране', panel.panelVisible, 'проверено в браузере 1440×900');
    check('шаги плана видны в панели', panel.planSteps > 0, `шагов: ${panel.planSteps}`);
    check('карточки вызовов инструментов видны', panel.toolCards > 0, `карточек: ${panel.toolCards}`);
    check('неудачный инструмент помечен, а не спрятан', panel.failed > 0, `помечено: ${panel.failed}`);
    check('расход токенов виден в usage', /Токенов/.test(panel.usage), panel.usage || 'пусто');
    check('статус сервисов сказан до запроса', /Интернет недоступен/.test(panel.services), panel.services);
    check('ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || 'нет');

    await page.screenshot({ path: path.join(ROOT, '.scratch', 'gate-a-panel.png') }).catch(() => {});
  } catch (err) {
    check('гейт выполнен без исключений', false, err?.message || String(err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
  }

  const failed = checks.filter((item) => !item.ok);
  const report = {
    checkedAt: new Date().toISOString(),
    gate: 'A — помощник-агент',
    query: QUERY,
    internet: 'не измерено: ключа поиска в репозитории нет (EXA_API_KEY не задан)',
    passed: checks.length - failed.length,
    total: checks.length,
    checks,
    measured,
  };
  const outDir = path.join(ROOT, 'docs', 'evidence', 'agent');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'gate-a.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`\nГейт A: ${checks.length - failed.length}/${checks.length} проверок прошли`);
  console.log('Отчёт: docs/evidence/agent/gate-a.json');
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error('✗ гейт A упал:', error?.message || error);
  process.exit(1);
});
