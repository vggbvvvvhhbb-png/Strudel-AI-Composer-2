// Обучение выученной цели офлайн (бриф §7.4).
//
//   node scripts/train-taste.mjs
//
// Что делает:
//   1. читает реестр пар и метки (server/data/*.jsonl);
//   2. собирает обучающую выборку: человеческие пары (вес 1) + прокси-пары
//      от best-of-N (вес ≤0.2, бриф §7.4);
//   3. обучает Bradley–Terry (чистый JS, без инфраструктуры);
//   4. проверяет leave-prompt-out CV и выносит вердикт о допуске;
//   5. пишет docs/TASTE.md и машинночитаемое доказательство
//      в docs/evidence/taste/taste.json.
//
// Честность: если человеческих пар мало, модель НЕ допускается в скор, и
// отчёт так и говорит. Это не сбой, а результат: символьный скор не
// проверен людьми, значит, целью оптимизации он быть не может (§2.8).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPairs, readLabels } from '../server/preference/ledger.js';
import { trainAndReport, saveModel, saveReport, modelPath } from '../server/taste/service.js';
import { proxyRowsFromIr } from '../server/taste/dataset.js';
import { planIR } from '../src/ir/intent.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const evidenceDir = join(root, 'docs', 'evidence', 'taste');
const corpusFile = join(root, 'corpus', 'baseline0', 'prompts.json');

/**
 * Прокси-пары из корпуса Baseline-0: для каждого промта строится план по
 * правилам и прогоняется best-of-N; лучший и худший кандидаты образуют
 * пару, размеченную символьным скором.
 *
 * Это НЕ замена человеку: такие пары учат модель воспроизводить символьный
 * скор, поэтому их вес ≤0.2, и в вердикт о допуске они не входят.
 *
 * @returns {Array<object>}
 */
function proxyRowsFromCorpus() {
  if (!existsSync(corpusFile)) return [];
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'));
  const entries = Array.isArray(corpus?.prompts) ? corpus.prompts : [];
  const rows = [];
  for (const entry of entries) {
    if (!entry?.prompt) continue;
    try {
      const ir = planIR(entry.prompt, { seed: entry.seed });
      const result = proxyRowsFromIr(ir, {
        prompt: entry.prompt,
        seed: entry.seed ?? 0,
        n: 8,
      });
      rows.push(...result.rows);
    } catch {
      // битый промт не должен ронять обучение
    }
  }
  return rows;
}

/**
 * Печатает человекочитаемый отчёт в консоль.
 * @param {object} result
 */
function printSummary(result) {
  const { model, cv, decision, stats } = result;
  console.log('── Выученная цель: обучение ──');
  console.log(`пар в реестре:        ${stats.pairs}`);
  console.log(`меток:                ${stats.labels}`);
  console.log(`обучающих строк:      ${stats.totalRows} (живых ${stats.rows}, прокси ${stats.proxyRows})`);
  console.log(`признаков:            ${stats.featureCount}`);
  if (model) {
    console.log(`весов ненулевых:      ${model.weights.filter((w) => Math.abs(w) > 1e-9).length}`);
    console.log(`потери (train):       ${model.loss}`);
    console.log(`точность (train):     ${model.trainAccuracy}`);
  }
  console.log('── Проверка (leave-prompt-out) ──');
  console.log(`живых пар в проверке: ${cv.n}, промтов: ${cv.prompts}`);
  console.log(`CV-accuracy:          ${cv.accuracy ?? '—'} (95% CI ${cv.ci.lower}…${cv.ci.upper})`);
  for (const [name, baseline] of Object.entries(cv.baselines)) {
    if (!baseline) continue;
    console.log(`базовая линия «${baseline.label}»: ${baseline.accuracy} (n=${baseline.n})`);
  }
  console.log('── Вердикт ──');
  console.log(decision.admitted ? 'ДОПУЩЕНА в скор.' : 'НЕ допущена в скор.');
  for (const reason of decision.reasons) console.log(`  — ${reason}`);
}

/**
 * Пишет docs/TASTE.md — документ, который читает человек (бриф §7.4:
 * «веса читаются человеком»).
 * @param {object} result
 */
function writeDoc(result) {
  const { model, cv, decision, stats } = result;
  const top = (model?.weights ?? [])
    .map((weight, index) => ({ id: model.ids[index], weight }))
    .filter((item) => Math.abs(item.weight) > 1e-9)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 15);

  const lines = [];
  lines.push('# Taste Model — выученная цель');
  lines.push('');
  lines.push(`*Обновлено ${new Date().toISOString().slice(0, 10)} · спринт S4.3 · бриф v2 §7.4*`);
  lines.push('');
  lines.push('## Что это');
  lines.push('');
  lines.push('Модель сравнения пар: `P(A лучше B) = σ(w · (x_A − x_B))`, где `x` —');
  lines.push('стандартизованный вектор признаков (L0 звук + L1 структура).');
  lines.push('Обучается на человеческих парах: человек слушает два варианта и говорит,');
  lines.push('какой лучше; модель учится, **какое отличие** между ними важно.');
  lines.push('');
  lines.push('## Состояние данных');
  lines.push('');
  lines.push('| что | сколько |');
  lines.push('|---|---|');
  lines.push(`| пар в реестре | ${stats.pairs} |`);
  lines.push(`| меток всего | ${stats.labels} |`);
  lines.push(`| живых обучающих строк | ${stats.rows} |`);
  lines.push(`| прокси-строк (best-of-N, вес ≤0.2) | ${stats.proxyRows} |`);
  lines.push(`| признаков | ${stats.featureCount} |`);
  lines.push(`| промтов | ${stats.prompts ?? '—'} |`);
  lines.push('');
  lines.push('## Проверка (leave-prompt-out CV)');
  lines.push('');
  lines.push('Пары одного промта не независимы, поэтому проверка оставляет целый промт');
  lines.push('целиком: «полезна ли модель на новом промте?»');
  lines.push('');
  lines.push('| величина | значение |');
  lines.push('|---|---|');
  lines.push(`| живых пар в проверке | ${cv.n} |`);
  lines.push(`| промтов | ${cv.prompts} |`);
  lines.push(`| CV-accuracy | ${cv.accuracy ?? '—'} |`);
  lines.push(`| 95% CI (Уилсон) | ${cv.ci.lower} … ${cv.ci.upper} |`);
  for (const baseline of Object.values(cv.baselines)) {
    if (!baseline) continue;
    lines.push(`| базовая линия «${baseline.label}» | ${baseline.accuracy} (n=${baseline.n}) |`);
  }
  lines.push('');
  lines.push('## Вердикт');
  lines.push('');
  lines.push(decision.admitted
    ? '**Модель допущена в скор.** Её веса заменяют ручные веса блоков.'
    : '**Модель не допущена в скор.** Ручные веса продолжают работать, помеченные «не проверено на людях».');
  lines.push('');
  if (decision.reasons.length) {
    lines.push('Причины:');
    lines.push('');
    for (const reason of decision.reasons) lines.push(`- ${reason}`);
    lines.push('');
  }
  lines.push('Условия допуска (бриф §7.4):');
  lines.push('');
  lines.push('1. человеческих пар ≥ 60;');
  lines.push('2. CV-accuracy ≥ 60%;');
  lines.push('3. нижняя граница 95% CI выше лучшей базовой линии;');
  lines.push('4. модель не вырождена (веса не нулевые).');
  lines.push('');
  if (top.length) {
    lines.push('## Веса (топ-15 по модулю)');
    lines.push('');
    lines.push('| признак | вес |');
    lines.push('|---|---|');
    for (const item of top) lines.push(`| \`${item.id}\` | ${item.weight} |`);
    lines.push('');
    lines.push('Знак веса — вклад признака в «лучше»: положительный значит, что рост');
    lines.push('признака тянет предпочтение вверх.');
    lines.push('');
  }
  lines.push('## Что нужно от владельца');
  lines.push('');
  lines.push('Открыть `/tinder.html` и послушать пары: **20 пар ≈ 6 минут**.');
  lines.push('Метки сразу становятся обучающими примерами (признаки считаются в');
  lines.push('браузере тем же DSP-ядром), а `npm run taste:train` переобучает модель.');
  lines.push('');

  writeFileSync(join(root, 'docs', 'TASTE.md'), `${lines.join('\n')}\n`, 'utf8');
}

const proxyRows = proxyRowsFromCorpus();
const result = trainAndReport({
  pairs: readPairs(),
  labels: readLabels(),
  proxyRows,
});

printSummary(result);

// Сохранение: модель и отчёт — в server/data (вне git), доказательство — в docs/evidence.
if (result.model) saveModel(result.model);
saveReport({
  trainedAt: new Date().toISOString(),
  model: result.model,
  cv: result.cv,
  decision: result.decision,
  stats: result.stats,
});

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(
  join(evidenceDir, 'taste.json'),
  `${JSON.stringify({
    trainedAt: new Date().toISOString(),
    model: result.model,
    cv: result.cv,
    decision: result.decision,
    stats: result.stats,
    modelPath: modelPath(),
  }, null, 2)}\n`,
  'utf8',
);

writeDoc(result);
console.log('\nЗаписано: docs/TASTE.md, docs/evidence/taste/taste.json');
console.log(`Модель: ${result.model ? modelPath() : '— (не обучена)'}`);
