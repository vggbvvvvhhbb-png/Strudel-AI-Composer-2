#!/usr/bin/env node
// ГЕЙТ A — помощник-агент (гайд «ПРОРЫВ», §8, «ГЕЙТ A»).
//
// ЧТО ПРОВЕРЯЕМ. Гайд требует, чтобы запрос
//   «найди в интернете, что такое phonk drift, и сделай бит в этом стиле»
// агент проходил сам: ищет → читает → строит план → компиляция;
// каждый шаг виден в панели; расход токенов виден в usage; без ключа поиска
// агент НЕ падает, а отвечает по каталогу и говорит об этом.
//
// ДВА РЕЖИМА.
//
//   node scripts/gate-a.mjs          — без интернета (15 проверок).
//     Ключа поиска в репозитории нет, поэтому замеряемая часть — честная
//     деградация: полный проход с интернетом измерить нельзя, и мы это
//     не выдаём за зелёное.
//
//   node scripts/gate-a.mjs --live   — с живым поиском (19 проверок).
//     При заданном EXA_API_KEY агент ищет по-настоящему, читает страницу
//     и цена запроса измеряется провайдером (costDollars.total) и
//     записывается в /api/stats. Без ключа живой режим честно не проходит.
//
// ЗАПУСК: node scripts/gate-a.mjs [--live]
// Пишет отчёт: docs/evidence/agent/gate-a.json  (обычный)
//               docs/evidence/agent/gate-a-live.json  (--live)

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.GATE_A_PORT || 3212);
const BASE = `http://127.0.0.1:${PORT}`;

const LIVE = process.argv.includes('--live');
const QUERY = 'найди в интернете, что такое phonk drift, и сделай бит в этом стиле';
// Тот же сценарий, но отдельный запрос: ответ агента кэшируется по запросу,
// и второй (панельный) прогон иначе получил бы кэш — без шагов и без usage.
// Кэш — это честная оптимизация, но для измерения панели нужен живой прогон.
const PANEL_QUERY = `${QUERY} (вариант для панели)`;

/** Жёсткий стоп по цене платного поиска за ночь (см. server/agent/budget.js). */
const NIGHT_EXA_BUDGET_USD = Number(process.env.NIGHT_EXA_BUDGET_USD ?? 2.0);
/** Ночной лимит вызовов поиска. */
const NIGHT_EXA_CALL_CAP = Number(process.env.NIGHT_EXA_CALL_CAP ?? 40);

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

  const liveKeyPresent = Boolean(String(process.env.EXA_API_KEY ?? '').trim());
  if (LIVE && !liveKeyPresent) {
    console.error('✗ живой режим требует EXA_API_KEY: гейт не выдаёт зелёного без измерения.');
    process.exit(1);
  }

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    // В живом режиме модель настоящая: иначе «ответ агента» — мок, а ссылка
    // на источник в нём не появилась бы. Без интернета модель остаётся моком:
    // гейт без сети не должен стоить денег.
    env: {
      ...process.env,
      PORT: String(PORT),
      MOCK_LLM: LIVE ? '' : '1',
      // Без интернета гейт проверяет ветку деградации, поэтому ключ поиска
      // выключается явно: на машине владельца он может быть задан в .env.
      // dotenv не перезаписывает уже заданную переменную — пустая строка
      // остаётся пустой, и сервер честно считает, что интернета нет.
      EXA_API_KEY: LIVE ? process.env.EXA_API_KEY : '',
      NODE_ENV: 'test',
    },
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
    // Планов может быть два: нативный путь публикует план своих вызовов
    // инструментов, а текстовый — план шагов. Проверяем ПОСЛЕДНИЙ: он
    // соответствует шагам, которые реально выполнялись.
    const planEvents = events.filter((event) => event.type === 'plan');
    const plan = planEvents.at(-1);
    const done = events.find((event) => event.type === 'done');
    const usage = events.find((event) => event.type === 'usage');
    const toolEnds = events.filter((event) => event.type === 'tool_end');

    measured.server = {
      httpStatus: res.status,
      eventTypes: types,
      mode: plan?.mode ?? null,
      planSource: plan?.planSource ?? null,
      planSteps: (plan?.steps ?? []).map((step) => step.tool),
      planCount: planEvents.length,
      tools: toolEnds.map((event) => ({
        tool: event.id,
        ok: event.ok,
        degraded: event.degraded,
        reason: event.reason ?? null,
        chars: event.chars ?? null,
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
    // Шаги плана и реально выполненные инструменты — разные вещи: сборка и
    // компиляция входят в гарантию режима «композитор» и могут отсутствовать
    // в плане модели. Проверяем по факту выполнения.
    const executed = toolEnds.map((event) => event.id);
    check('выполнены поиск, сборка и компиляция',
      ['web_search', 'compose_spec', 'compile'].every((tool) => executed.includes(tool)),
      `выполнено: ${executed.join(', ')}`);

    const search = toolEnds.find((event) => event.id === 'web_search');
    if (LIVE) {
      check('поиск прошёл и вернул источники',
        search && search.ok === true,
        search?.reason ?? (search ? 'поиск выполнен' : 'шага поиска не было'));
      check('агент не упал и перешёл к сборке',
        toolEnds.some((event) => event.id === 'compose_spec' && event.ok),
        `инструментов выполнено: ${toolEnds.length}`);
      check('трек собран: код получен', measured.server.codeChars > 0, `символов кода: ${measured.server.codeChars}`);
      check('деградации нет: интернет отвечал',
        !(done?.degraded ?? []).some((item) => item.tool === 'web_search'),
        `деградировало: ${(done?.degraded ?? []).map((item) => item.tool).join(', ') || 'нет'}`);
    } else {
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
    }
    // Контракт usage: число есть и честно помечено, измерено оно или оценка.
    // В живом режиме провайдер может ответить 429 — тогда токены считаются
    // оценкой, и это нормально; строгость живого гейта — цена поиска, а не
    // способ посчитать токены.
    check('usage отдаёт честное число токенов',
      Boolean(usage) && usage.tokens > 0
        && (LIVE ? typeof usage.estimated === 'boolean' : usage.estimated === true),
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

    await page.fill('#agent-input', PANEL_QUERY);
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
    check(LIVE ? 'неудачных инструментов нет' : 'неудачный инструмент помечен, а не спрятан',
      LIVE ? panel.failed === 0 : panel.failed > 0,
      `помечено: ${panel.failed}`);
    check('расход токенов виден в usage', /Токенов/.test(panel.usage), panel.usage || 'пусто');
    check(LIVE ? 'панель честно говорит, что интернет доступен' : 'статус сервисов сказан до запроса',
      LIVE ? /Интернет доступен/.test(panel.services) : /Интернет недоступен/.test(panel.services),
      panel.services);
    check('ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || 'нет');

    await page.screenshot({ path: path.join(ROOT, '.scratch', 'gate-a-panel.png') }).catch(() => {});

    // --- 3. Живые проверки поиска (только в режиме --live) ---------------
    if (LIVE) {
      // Источники достаём из фактического вызова web_search: домены и адреса
      // берём из тела ответа инструмента, а не из текста ответа модели.
      const searchEvent = toolEnds.find((event) => event.id === 'web_search');
      const urls = [...new Set(
        (searchEvent?.summary ?? '').match(/https?:\/\/[^\s—]+/g) ?? [],
      )];
      const domains = [...new Set(urls.map((url) => {
        try {
          return new URL(url).hostname.replace(/^www\./, '');
        } catch {
          return null;
        }
      }).filter(Boolean))];
      const fetchEvent = toolEnds.find((event) => event.id === 'web_fetch');
      const readChars = Number(fetchEvent?.chars ?? 0);
      const answer = String(done?.answer ?? '');
      const answerHasSource = urls.some((url) => answer.includes(url))
        || domains.some((domain) => answer.includes(domain));

      const statsResponse = await fetch(`${BASE}/api/stats`);
      const stats = statsResponse.ok ? await statsResponse.json() : {};
      const searchFeature = stats.byFeature?.web_search ?? {};
      const searchCost = Number(searchFeature.costUsd ?? 0);

      measured.live = {
        sources: urls.map((url) => {
          let domain = null;
          try {
            domain = new URL(url).hostname.replace(/^www\./, '');
          } catch {
            domain = null;
          }
          return { url, domain };
        }),
        domains,
        readChars,
        searchCostUsd: searchCost,
        searchCalls: Number(searchFeature.requests ?? 0),
        answerHasSource,
        budget: {
          limitUsd: NIGHT_EXA_BUDGET_USD,
          callCap: NIGHT_EXA_CALL_CAP,
          spentUsd: searchCost,
        },
      };

      check('источники из разных доменов (≥2)', domains.length >= 2, `домены: ${domains.join(', ') || 'нет'}`);
      check('страница прочитана: текст >500 символов', readChars > 500, `прочитано символов: ${readChars}`);
      check('ответ агента ссылается на источник', answerHasSource, answerHasSource ? 'ссылка есть' : 'ссылки нет');
      check('цена поиска измерена и записана в /api/stats', searchCost > 0, `$${searchCost.toFixed(4)}`);
      check('цена в пределах ночного бюджета', searchCost <= NIGHT_EXA_BUDGET_USD,
        `$${searchCost.toFixed(4)} из $${NIGHT_EXA_BUDGET_USD.toFixed(2)}`);
    }
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
    mode: LIVE ? 'live' : 'offline',
    query: QUERY,
    internet: LIVE
      ? 'измерено: живой поиск Exa, цена запроса взята из costDollars.total провайдера'
      : 'не измерено: ключа поиска в репозитории нет (EXA_API_KEY не задан)',
    passed: checks.length - failed.length,
    total: checks.length,
    checks,
    measured,
  };
  const outDir = path.join(ROOT, 'docs', 'evidence', 'agent');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, LIVE ? 'gate-a-live.json' : 'gate-a.json');
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`\nГейт A (${LIVE ? 'live' : 'offline'}): ${checks.length - failed.length}/${checks.length} проверок прошли`);
  console.log(`Отчёт: ${path.relative(ROOT, outFile)}`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error('✗ гейт A упал:', error?.message || error);
  process.exit(1);
});
