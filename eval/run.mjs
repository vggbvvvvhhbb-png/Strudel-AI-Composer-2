// Eval-харнесс: сравнение A (старый пайплайн) и B (структурный).
//
//   node eval/run.mjs [--limit N] [--out eval/results] [--dry] [--prompts eval/prompts.json]
//
// A — старый путь: модель пишет код текстом, разбор по коду, refine по коду.
// B — новый путь: модель выбирает идеи (спека), компилятор пишет код,
//     refine правит спеку.
//
// ЧТО СРАВНИВАЕМ
//   • first-try validity — доля промптов, где код прошёл проверку сразу;
//   • autofix share — доля автофиксов;
//   • скор v1 и скор v2;
//   • метрики формы (секции, размах энергии, смена гармонии);
//   • латентность и стоимость (токены).
//
// ЧЕСТНОСТЬ РЕЗУЛЬТАТА
//   Если B не лучше A — в отчёте так и написано. Отчёт не подгоняется.
//
// РЕЖИМ --dry
//   Без обращения к модели: используются запасные спеки из библиотеки.
//   Нужен, чтобы проверить сам харнесс (и CI) без трат токенов.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { completeChat } from '../server/llm/client.js';
import { prompts } from '../server/prompts.js';
import { staticValidate } from '../src/core/validator.js';
import { analyzeTrack } from '../server/music/features.js';
import { scoreTrack } from '../server/music/score.js';
import { resolveProfile } from '../server/music/references.js';
import { stripCodeFences } from '../server/music/extract.js';
import { buildTrack, detectSpecStyle, fallbackSpec, SPEC_STYLES } from '../server/music/compose/pipeline.js';
import { refineSpec } from '../server/music/compose/refine.js';
import { scoreWithV2 } from '../server/music/compose/score-adapter.js';
import { validateTrackSpec } from '../src/schemas/track-spec.schema.js';
import { compileTrackSpec } from '../server/music/compiler/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/* --- Разбор аргументов --- */

function parseArgs(argv) {
  const args = { limit: 0, out: join(here, 'results'), dry: false, prompts: join(here, 'prompts.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') args.limit = Number(argv[i + 1]) || 0;
    else if (arg === '--out') args.out = resolve(argv[i + 1]);
    else if (arg === '--dry') args.dry = true;
    else if (arg === '--prompts') args.prompts = resolve(argv[i + 1]);
  }
  return args;
}

/* --- Метрики трека --- */

/**
 * Полный набор метрик трека: скор v1, скор v2, метрики формы.
 * @param {string} code
 * @param {string} style
 */
async function measure(code, style, promptText) {
  const profile = resolveProfile(style, promptText);
  const analysis = analyzeTrack(code);
  const v1 = scoreTrack(analysis, profile);
  const v2 = await scoreWithV2(code, style, promptText);
  const total = v2 ? Math.round((v1.total * 0.6 + v2.total * 0.4) * 10) / 10 : v1.total;
  return {
    v1: v1.total,
    v2: v2 ? v2.total : null,
    total,
    criteria: v1.criteria?.length ?? 0,
    issues: (v1.issues || []).length + (v2?.issues?.length ?? 0),
  };
}

/**
 * Метрики формы по спеке: сколько секций, какой размах энергии,
 * менялась ли гармония.
 */
export function formMetrics(spec) {
  const sections = spec?.structure?.sections;
  if (!Array.isArray(sections)) return null;
  const energies = sections.map((s) => s.energy);
  const range = energies.length ? Math.max(...energies) - Math.min(...energies) : 0;
  const harmonies = new Set(sections.map((s) => s.harmony));
  return {
    sections: sections.length,
    bars: sections.reduce((sum, s) => sum + s.cycles, 0),
    energyRange: Math.round(range * 100) / 100,
    harmonyChanges: Math.max(0, harmonies.size - 1),
  };
}

/* --- Путь A: старый пайплайн --- */

/**
 * A: модель пишет код текстом → проверка → автофикс → refine по коду.
 *
 * Это тот же путь, что был до композиции: он остаётся рабочим
 * и служит точкой отсчёта.
 */
async function runA(item, options) {
  const started = Date.now();
  const usage = [];
  const result = {
    id: item.id,
    style: item.style,
    type: item.type,
    valid: false,
    autofixed: false,
    code: null,
    error: null,
    tokens: 0,
  };

  try {
    const content = await completeChat({
      messages: [
        { role: 'system', content: prompts.system },
        { role: 'user', content: `Запрос: ${item.text}` },
      ],
      temperature: 0.8,
      signal: options.signal,
      onUsage: (u) => {
        usage.push(u);
        result.tokens += u.total_tokens || 0;
      },
    });

    let code = stripCodeFences(content);
    let check = staticValidate(code);
    // Автофикс: чинящая итерация модели, пока код не пройдёт проверку.
    for (let attempt = 0; attempt < 2 && !check.ok; attempt += 1) {
      result.autofixed = true;
      const fixed = await completeChat({
        messages: [
          { role: 'system', content: prompts.system },
          {
            role: 'user',
            content: `Запрос: ${item.text}\n\nКод не прошёл проверку: ${check.error.message}\n\nВерни исправленный полный код.`,
          },
        ],
        temperature: 0.4,
        signal: options.signal,
        onUsage: (u) => {
          usage.push(u);
          result.tokens += u.total_tokens || 0;
        },
      });
      code = stripCodeFences(fixed);
      check = staticValidate(code);
    }

    if (!check.ok) {
      result.error = check.error.message;
      result.latency = Date.now() - started;
      return result;
    }

    result.valid = true;
    result.code = code;

    // Refine по коду: модель переписывает код по замечаниям разбора.
    const profile = resolveProfile(item.style, item.text);
    const analysis = analyzeTrack(code);
    const score = scoreTrack(analysis, profile);
    if (score.issues.length) {
      const refined = await completeChat({
        messages: [
          { role: 'system', content: prompts.critic },
          { role: 'user', content: `Текущий код:\n\n${code}\n\nИсправь замечания и верни полный обновлённый код.` },
        ],
        temperature: 0.5,
        signal: options.signal,
        onUsage: (u) => {
          usage.push(u);
          result.tokens += u.total_tokens || 0;
        },
      });
      const candidate = stripCodeFences(refined);
      if (staticValidate(candidate).ok) {
        result.code = candidate;
        result.refined = true;
      }
    }
  } catch (err) {
    result.error = err?.message || String(err);
  }

  result.latency = Date.now() - started;
  if (result.code) {
    const measured = await measure(result.code, item.style, item.text);
    result.measured = measured;
    result.form = null; // у A нет спеки — форма не измеряется
  }
  return result;
}

/* --- Путь B: структурный --- */

async function runB(item, options) {
  const started = Date.now();
  const usage = [];
  const result = {
    id: item.id,
    style: item.style,
    type: item.type,
    valid: false,
    autofixed: false,
    code: null,
    error: null,
    tokens: 0,
  };

  try {
    const style = SPEC_STYLES.includes(item.style) ? item.style : detectSpecStyle(item.text);
    let built;
    if (options.dry) {
      // Без модели: запасная спека из библиотеки.
      const spec = fallbackSpec(style, item.id.length);
      const checked = validateTrackSpec(spec);
      built = { spec: checked, compiled: { code: compileTrackSpec(checked) }, usedFallback: true, attempts: 0 };
    } else {
      built = await buildTrack({
        prompt: item.text,
        style,
        completeChat: (args) =>
          completeChat({
            ...args,
            onUsage: (u) => {
              usage.push(u);
              result.tokens += u.total_tokens || 0;
            },
          }),
        signal: options.signal,
      });
    }

    result.spec = built.spec;
    result.usedFallback = built.usedFallback;
    result.attempts = built.attempts;

    // Refine правит спеку.
    const refined = await refineSpec({
      spec: built.spec,
      scoreFn: async (code) => {
        const measured = await measure(code, style, item.text);
        return { total: measured.total, issues: [] };
      },
      maxIterations: 2,
      signal: options.signal,
    });
    result.refined = refined.improved;
    result.code = refined.code;
    result.spec = refined.spec;

    const check = staticValidate(result.code);
    result.valid = check.ok;
    if (!check.ok) result.error = check.error.message;

    const measured = await measure(result.code, style, item.text);
    result.measured = measured;
    result.form = formMetrics(result.spec);
  } catch (err) {
    result.error = err?.message || String(err);
  }

  result.latency = Date.now() - started;
  return result;
}

/* --- Итоги --- */

/**
 * Сводка по набору результатов.
 */
function summarize(results, key) {
  const ok = results.filter((r) => r.valid);
  const withScore = ok.filter((r) => r.measured);
  const avg = (list, fn) => (list.length ? list.reduce((s, x) => s + fn(x), 0) / list.length : 0);

  return {
    count: results.length,
    valid: ok.length,
    validRate: results.length ? ok.length / results.length : 0,
    autofixRate: results.length ? results.filter((r) => r.autofixed).length / results.length : 0,
    v1: avg(withScore, (r) => r.measured.v1),
    v2: avg(withScore.filter((r) => r.measured.v2 !== null), (r) => r.measured.v2),
    total: avg(withScore, (r) => r.measured.total),
    latency: avg(results, (r) => r.latency || 0),
    tokens: avg(results, (r) => r.tokens || 0),
    sections: avg(ok.filter((r) => r.form), (r) => r.form.sections),
    energyRange: avg(ok.filter((r) => r.form), (r) => r.form.energyRange),
    harmonyChanges: avg(ok.filter((r) => r.form), (r) => r.form.harmonyChanges),
  };
}

/** Markdown-таблица «до/после». */
function markdownTable(summaryA, summaryB) {
  const rows = [
    ['Показатель', 'A (старый)', 'B (структурный)', 'Разница'],
    ['Промптов', summaryA.count, summaryB.count, '—'],
    ['Валидность с первого раза', pct(summaryA.validRate), pct(summaryB.validRate), delta(summaryA.validRate, summaryB.validRate)],
    ['Доля автофиксов', pct(summaryA.autofixRate), pct(summaryB.autofixRate), delta(summaryA.autofixRate, summaryB.autofixRate)],
    ['Скор v1', num(summaryA.v1), num(summaryB.v1), num(summaryB.v1 - summaryA.v1)],
    ['Скор v2', summaryA.v2 ? num(summaryA.v2) : '—', summaryB.v2 ? num(summaryB.v2) : '—', summaryA.v2 && summaryB.v2 ? num(summaryB.v2 - summaryA.v2) : '—'],
    ['Скор (v1 60% + v2 40%)', num(summaryA.total), num(summaryB.total), num(summaryB.total - summaryA.total)],
    ['Секций в треке', summaryA.sections ? num(summaryA.sections) : '—', summaryB.sections ? num(summaryB.sections) : '—', '—'],
    ['Размах энергии', summaryA.energyRange ? num(summaryA.energyRange) : '—', summaryB.energyRange ? num(summaryB.energyRange) : '—', '—'],
    ['Смен гармонии', summaryA.harmonyChanges ? num(summaryA.harmonyChanges) : '—', summaryB.harmonyChanges ? num(summaryB.harmonyChanges) : '—', '—'],
    ['Латентность, мс', num(summaryA.latency), num(summaryB.latency), num(summaryB.latency - summaryA.latency)],
    ['Токенов на промпт', num(summaryA.tokens), num(summaryB.tokens), num(summaryB.tokens - summaryA.tokens)],
  ];
  return rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}

const pct = (v) => `${Math.round((v || 0) * 100)}%`;
const num = (v) => (Math.round((v || 0) * 10) / 10).toFixed(1);
const delta = (a, b) => {
  const d = Math.round(((b || 0) - (a || 0)) * 1000) / 10;
  return `${d > 0 ? '+' : ''}${d.toFixed(1)} п.п.`;
};

/**
 * График: SVG со столбиками по промптам (A против B).
 */
function chartSvg(results) {
  const width = 960;
  const height = 320;
  const padLeft = 46;
  const padBottom = 60;
  const padTop = 16;
  const plotW = width - padLeft - 16;
  const plotH = height - padTop - padBottom;

  const scores = results.flatMap((r) => [r.a?.measured?.total ?? 0, r.b?.measured?.total ?? 0]);
  const max = Math.max(100, ...scores);

  const groupW = plotW / Math.max(1, results.length);
  const barW = Math.min(14, groupW / 2 - 2);

  const bars = [];
  results.forEach((entry, index) => {
    const x = padLeft + index * groupW + groupW / 2;
    const aVal = entry.a?.measured?.total ?? 0;
    const bVal = entry.b?.measured?.total ?? 0;
    const aH = (aVal / max) * plotH;
    const bH = (bVal / max) * plotH;
    bars.push(`<rect x="${(x - barW - 1).toFixed(1)}" y="${(padTop + plotH - aH).toFixed(1)}" width="${barW}" height="${aH.toFixed(1)}" fill="#7fb5a0" />`);
    bars.push(`<rect x="${(x + 1).toFixed(1)}" y="${(padTop + plotH - bH).toFixed(1)}" width="${barW}" height="${bH.toFixed(1)}" fill="#2fe0a0" />`);
  });

  const labels = results.map((entry, index) => {
    const x = padLeft + index * groupW + groupW / 2;
    return `<text x="${x.toFixed(1)}" y="${height - padBottom + 16}" text-anchor="end" transform="rotate(-45 ${x.toFixed(1)} ${height - padBottom + 16})" fill="#7fb5a0" font-size="9" font-family="monospace">${entry.id}</text>`;
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="#031a14" />`,
    `<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - 16}" y2="${padTop + plotH}" stroke="#7fb5a0" stroke-width="1" />`,
    `<text x="8" y="${padTop + 10}" fill="#b5ffe1" font-size="11" font-family="monospace">${max}</text>`,
    `<text x="8" y="${padTop + plotH}" fill="#b5ffe1" font-size="11" font-family="monospace">0</text>`,
    bars.join(''),
    labels.join(''),
    `<text x="${width - 16}" y="${padTop + 10}" text-anchor="end" fill="#7fb5a0" font-size="10" font-family="monospace">A — старый (серый), B — структурный (яркий)</text>`,
    '</svg>',
  ].join('\n');
}

/* --- Главная --- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(args.prompts, 'utf8'));
  let items = raw.prompts;
  if (args.limit) items = items.slice(0, args.limit);

  console.log(`Eval: ${items.length} промптов, режим ${args.dry ? 'dry (без модели)' : 'с моделью'}`);

  const results = [];
  for (const item of items) {
    process.stdout.write(`  ${item.id} … `);
    const a = args.dry ? null : await runA(item, { signal: null });
    const b = await runB(item, { signal: null, dry: args.dry });
    results.push({ id: item.id, style: item.style, type: item.type, a, b });
    const line = (r) => (r ? `${r.valid ? 'ok' : 'ошибка'} ${r.measured ? `скор ${r.measured.total}` : ''}` : '—');
    console.log(`A: ${line(a)} | B: ${line(b)}`);
  }

  const summaryA = summarize(results.map((r) => r.a).filter(Boolean), 'a');
  const summaryB = summarize(results.map((r) => r.b), 'b');

  let report = [
    '# Eval: A (старый пайплайн) против B (структурный)',
    '',
    `Дата: ${new Date().toISOString().slice(0, 10)}`,
    `Промптов: ${items.length}${args.dry ? ' (режим dry — без обращения к модели)' : ''}`,
    '',
    '## Сводка',
    '',
    markdownTable(summaryA, summaryB),
    '',
    '## Как читать',
    '',
    '- **Валидность с первого раза** — доля промптов, где результат прошёл проверку без починки.',
    '- **Скор v1** — старые 10 критериев; **скор v2** — новые метрики развития (если модуль метрик v2 доступен).',
    '- **Размах энергии** и **смен гармонии** — метрики формы; у A спеки нет, поэтому они не измеряются.',
    '- Латентность и токены — средние на промпт.',
    '',
  ].join('\n');

  if (!args.dry) {
    const winsB = results.filter((r) => (r.b?.measured?.total ?? 0) > (r.a?.measured?.total ?? 0)).length;
    const winsA = results.filter((r) => (r.a?.measured?.total ?? 0) > (r.b?.measured?.total ?? 0)).length;
    const ties = results.length - winsB - winsA;
    report += [
      '## Побед по совокупному скору',
      '',
      `B лучше: ${winsB}, A лучше: ${winsA}, ничья: ${ties}.`,
      '',
      winsB > winsA
        ? 'Структурный пайплайн показывает лучший результат по совокупному скору.'
        : 'Структурный пайплайн НЕ показывает преимущества по совокупному скору на этом наборе.',
      '',
    ].join('\n');
  }

  await mkdir(args.out, { recursive: true });
  await writeFile(join(args.out, 'report.md'), report, 'utf8');
  await writeFile(join(args.out, 'results.json'), JSON.stringify({ results, summaryA, summaryB }, null, 2), 'utf8');
  await writeFile(join(args.out, 'chart.svg'), chartSvg(results), 'utf8');

  // Пары для слепого A/B-теста: порядок внутри пары перемешан, чтобы
  // слушатель не мог догадаться, где «старый» вариант.
  const abPairs = results
    .filter((entry) => entry.b?.code)
    .map((entry) => {
      const a = { code: entry.a?.code || '', score: entry.a?.measured?.total ?? null };
      const b = { code: entry.b.code, score: entry.b.measured?.total ?? null };
      const flip = hashFlip(entry.id);
      return {
        id: entry.id,
        style: entry.style,
        type: entry.type,
        a: flip ? b : a,
        b: flip ? a : b,
      };
    });
  const pairsPath = args.out === join(here, 'results')
    ? join(here, 'ab-pairs.json') : join(args.out, 'ab-pairs.json');
  await writeFile(pairsPath, JSON.stringify({ createdAt: new Date().toISOString(), pairs: abPairs }, null, 2), 'utf8');

  console.log(`\nОтчёт: ${join(args.out, 'report.md')}`);
  console.log(`Пары для слепого теста: ${pairsPath}`);
  console.log(markdownTable(summaryA, summaryB));
}

/**
 * Детерминированный переворот пары: по id решается, какой вариант
 * показывать первым. Один и тот же id всегда даёт один и тот же порядок.
 */
function hashFlip(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
