// Анализ результатов слепого A/B-теста.
//
//   node eval/analyze-ab.mjs [results.json]
//
// Вход — JSON, выгруженный из eval/ab.html (структура описана там).
// Выход — доля побед B, знаковый критерий (Wilcoxon), размер эффекта.
//
// ЧЕСТНОСТЬ: если улучшения нет — так и пишется. Тест не подгоняется.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Знаковый критерий для связанных пар (нормальное приближение).
 *
 * Считается по разностям d_i = B_i − A_i:
 *   • отбрасываем нули (ничья);
 *   • W+ = число положительных разностей, W− = число отрицательных;
 *   • статистика Z = (W+ − W−) / sqrt(n);
 *   • p-value — двусторонняя аппроксимация нормальным распределением.
 *
 * @param {number[]} diffs разности B − A по парам
 * @returns {{n:number, wPlus:number, wMinus:number, z:number, p:number}}
 */
export function signTest(diffs) {
  const nonzero = diffs.filter((d) => d !== 0);
  const n = nonzero.length;
  if (!n) return { n: 0, wPlus: 0, wMinus: 0, z: 0, p: 1 };

  const wPlus = nonzero.filter((d) => d > 0).length;
  const wMinus = nonzero.length - wPlus;
  const z = (wPlus - wMinus) / Math.sqrt(n);
  // Двусторонняя нормальная CDF.
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { n, wPlus, wMinus, z: Math.round(z * 1000) / 1000, p: Math.round(p * 10000) / 10000 };
}

/** Нормальная CDF (аппроксимация erf). */
function normalCdf(x) {
  // Abramowitz & Stegun 7.1.26 — достаточно точна для отчёта.
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - p;
}

/**
 * Размер эффекта: медиана разностей и доля пар, где B лучше.
 * @param {number[]} diffs
 */
export function effectSize(diffs) {
  const nonzero = diffs.filter((d) => d !== 0);
  const sorted = [...nonzero].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const wins = diffs.filter((d) => d > 0).length;
  return {
    median,
    wins,
    losses: diffs.filter((d) => d < 0).length,
    winRate: diffs.length ? wins / diffs.length : 0,
  };
}

/**
 * Разбирает результаты из разных форматов:
 *   • массив пар [{a, b}] с оценками;
 *   • объект {pairs: [...]}.
 * @param {object} data
 * @returns {{pairs: Array<{a:number,b:number}>}}
 */
export function extractPairs(data) {
  const list = Array.isArray(data) ? data : data.pairs || data.results || [];
  const pairs = [];
  for (const item of list) {
    const a = Number(item.a?.score ?? item.a ?? item.scoreA);
    const b = Number(item.b?.score ?? item.b ?? item.scoreB);
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push({ a, b });
  }
  return { pairs };
}

/**
 * Полный анализ.
 * @param {object} data результаты A/B-теста
 */
export function analyze(data) {
  const { pairs } = extractPairs(data);
  if (!pairs.length) {
    return {
      count: 0,
      winRate: 0,
      sign: { n: 0, wPlus: 0, wMinus: 0, z: 0, p: 1 },
      effect: { median: 0, wins: 0, losses: 0, winRate: 0 },
      verdict: 'Нет данных для анализа.',
    };
  }

  const diffs = pairs.map((p) => p.b - p.a);
  const sign = signTest(diffs);
  const effect = effectSize(diffs);
  const winRate = effect.winRate;

  let verdict;
  if (sign.p < 0.05 && winRate > 0.5) {
    verdict = 'B значимо лучше A (p < 0.05).';
  } else if (sign.p < 0.05 && winRate < 0.5) {
    verdict = 'A значимо лучше B (p < 0.05).';
  } else if (winRate > 0.5) {
    verdict = 'B лучше чаще, но разница НЕ статистически значима (p ≥ 0.05).';
  } else if (winRate < 0.5) {
    verdict = 'A лучше чаще, и разница НЕ статистически значима (p ≥ 0.05).';
  } else {
    verdict = 'Ничья.';
  }

  return {
    count: pairs.length,
    winRate,
    sign,
    effect,
    verdict,
  };
}

/* --- CLI --- */

async function main() {
  const arg = process.argv[2];
  const path = arg ? resolve(arg) : join(here, 'ab-results.json');
  if (!existsSync(path)) {
    console.error(`Файл результатов не найден: ${path}`);
    console.error('Сначала пройдите слепой тест в eval/ab.html и выгрузите JSON.');
    process.exit(1);
  }
  const data = JSON.parse(await readFile(path, 'utf8'));
  const report = analyze(data);

  console.log('Анализ слепого A/B');
  console.log('='.repeat(46));
  console.log(`Пар: ${report.count}`);
  console.log(`Доля побед B: ${Math.round(report.winRate * 100)}%`);
  console.log(`Знаковый критерий: W+=${report.sign.wPlus}, W−=${report.sign.wMinus}, z=${report.sign.z}, p=${report.sign.p}`);
  console.log(`Медиана разности (B−A): ${report.effect.median}`);
  console.log('');
  console.log(`Вывод: ${report.verdict}`);
}

// CLI запускается только когда файл вызван напрямую, а не импортирован.
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
