// Калибровка весов критериев по оценкам человека.
//
// Метрики музыкальности субъективны: модельный скор — это прозрачная эвристика,
// а не истина. Чтобы он не вёл в никуда, его сверяют с оценками слушателя
// на размеченных примерах и подбирают веса критериев под эти оценки.
//
// Запуск:  node scripts/calibrate.mjs [путь-к-данным.json]
// Формат данных: [{ "code": "...", "style": "techno", "humanRating": 7 }, …]
// humanRating — оценка от 1 до 10. Пропущенные примеры пропускаются.
//
// Процедура сбора данных (слепой A/B) описана в docs/calibration.md.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { analyzeTrack } from '../server/music/features.js';
import { scoreTrack, CRITERIA } from '../server/music/score.js';
import { resolveProfile } from '../server/music/references.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(here, '../docs/calibration-data.json');
// Путь к данным: аргумент может быть абсолютным или относительным.
const argPath = process.argv[2];
const dataPath = argPath
  ? isAbsolute(argPath)
    ? argPath
    : resolve(process.cwd(), argPath)
  : defaultPath;

if (!existsSync(dataPath)) {
  console.log(`Файл с оценками не найден: ${dataPath}`);
  console.log('Скопируйте docs/calibration-template.json в docs/calibration-data.json,');
  console.log('заполните humanRating и запустите скрипт снова.');
  process.exit(0);
}

let examples;
try {
  // BOM от Windows-редакторов JSON-парсер не принимает — убираем.
  const raw = readFileSync(dataPath, 'utf8').replace(/^\uFEFF/, '');
  examples = JSON.parse(raw);
} catch (err) {
  console.error(`Не удалось прочитать ${dataPath}: ${err.message}`);
  process.exit(1);
}

const rated = (examples || []).filter((ex) => Number.isFinite(ex.humanRating));
if (rated.length < 5) {
  console.log(`Примеров с оценкой: ${rated.length}. Для калибровки нужно хотя бы 5, лучше 20–30.`);
  process.exit(0);
}

// Ранги с учётом равных значений (средний ранг).
function ranks(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    const average = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[indexed[k].index] = average;
    i = j + 1;
  }
  return out;
}

function pearson(a, b) {
  const n = a.length;
  if (!n) return 0;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - meanA;
    const y = b[i] - meanB;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (!da || !db) return 0;
  return num / Math.sqrt(da * db);
}

function spearman(a, b) {
  return pearson(ranks(a), ranks(b));
}

// Подготовка: считаем разбор и критерии один раз.
const prepared = rated.map((ex) => {
  const profile = resolveProfile(ex.style, ex.prompt || '');
  const analysis = analyzeTrack(ex.code);
  const score = scoreTrack(analysis, profile);
  return {
    ex,
    profile,
    analysis,
    criterionScores: Object.fromEntries(score.criteria.map((c) => [c.id, c.score])),
  };
});

const human = prepared.map((p) => p.ex.humanRating);

function totalWith(weights, item) {
  let total = 0;
  for (const criterion of CRITERIA) {
    total += (item.criterionScores[criterion.id] ?? 0.5) * (weights[criterion.id] ?? criterion.weight);
  }
  return total;
}

const baseWeights = Object.fromEntries(CRITERIA.map((c) => [c.id, c.weight]));
const baseTotal = prepared.map((item) => totalWith(baseWeights, item));
const baseSpearman = spearman(baseTotal, human);

console.log(`Примеров: ${prepared.length}`);
console.log(`Текущая корреляция Спирмена с оценками человека: ${baseSpearman.toFixed(3)}`);
console.log('');

// Жадный подбор весов: по одному критерию ищем множитель, который поднимает корреляцию.
const FACTORS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
let weights = { ...baseWeights };
let best = baseSpearman;
const changed = [];

for (let round = 0; round < 3; round++) {
  let improvedThisRound = false;
  for (const criterion of CRITERIA) {
    const current = weights[criterion.id];
    let bestFactor = 1;
    let bestScore = best;
    for (const factor of FACTORS) {
      const candidate = { ...weights, [criterion.id]: current * factor };
      const totals = prepared.map((item) => totalWith(candidate, item));
      const corr = spearman(totals, human);
      if (corr > bestScore + 1e-6) {
        bestScore = corr;
        bestFactor = factor;
      }
    }
    if (bestFactor !== 1) {
      weights[criterion.id] = current * bestFactor;
      best = bestScore;
      improvedThisRound = true;
      changed.push(`${criterion.id}: ${current} → ${Math.round(weights[criterion.id] * 10) / 10}`);
    }
  }
  if (!improvedThisRound) break;
}

// Веса округляем до целых и нормируем на 100.
const sum = Object.values(weights).reduce((s, w) => s + w, 0);
const finalWeights = {};
for (const criterion of CRITERIA) {
  finalWeights[criterion.id] = Math.round((weights[criterion.id] / sum) * 100);
}

console.log('Изменённые веса:');
if (changed.length) changed.forEach((c) => console.log(`  ${c}`));
else console.log('  (подобрать нечего — текущие веса уже лучшие)');
console.log('');
console.log('Итоговые веса (вставьте в CRITERIA в server/music/score.js):');
console.log(JSON.stringify(finalWeights, null, 2));
console.log('');

// Проверка: корреляция с округлёнными весами.
const finalTotals = prepared.map((item) => totalWith(finalWeights, item));
console.log(`Корреляция с округлёнными весами: ${spearman(finalTotals, human).toFixed(3)}`);

console.log('');
console.log('По примеру:');
for (const [i, item] of prepared.entries()) {
  const score = scoreTrack(item.analysis, item.profile, finalWeights);
  console.log(
    `  #${i + 1} стиль=${item.profile.id} оценка=${item.ex.humanRating} скор=${score.total} ` +
      `замечаний=${score.issues.length}`,
  );
}
