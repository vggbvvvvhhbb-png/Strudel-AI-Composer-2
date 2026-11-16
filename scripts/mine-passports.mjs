// Добыча библиотеки стилей из паспортов глубокого разбора (D-112).
//
// ЗАЧЕМ. Глубокие разборы треков учили только человека: из отчёта нельзя было
// взять числа, на которых строится следующий трек. Этот скрипт превращает
// паспорта (`<job-id>/job.json` рабочего каталога разборов) в библиотеку
// СТАТИСТИК, которую композитор читает через styleDigest.
//
// ЧЕСТНОСТЬ. Скрипт не добирает данные: паспортов на машине может быть
// ноль, и тогда библиотека остаётся пустой, а index.json честно показывает
// «источников: 0». Ничего синтетического не подставляется.
//
// ЗАПУСК.
//   node scripts/mine-passports.mjs --batch
//   node scripts/mine-passports.mjs --batch --root F:/razbory --style techno
//   node scripts/mine-passports.mjs --batch --map styles.json --dry-run
//
// ФЛАГИ.
//   --batch     разобрать все паспорта в каталоге (по умолчанию — да)
//   --root DIR  каталог рабочих папок разборов
//               (по умолчанию DD_WORKSPACE_DIR или %TEMP%/strudel-deepdive)
//   --out DIR   куда писать библиотеку (по умолчанию server/music/knowledge/mined)
//   --style S   стиль для всех паспортов (если стиль не известен из паспорта)
//   --map FILE  json {jobId: style} — стиль для каждой задачи
//   --dry-run   ничего не писать, только показать, что будет собрано

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFeatures } from '../server/music/mining/extract.js';
import { buildLibrary, verifyLibrary } from '../server/music/mining/aggregate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function parseArgs(argv) {
  const args = { batch: false, dryRun: false, root: null, out: null, style: null, map: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--batch') args.batch = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--root') args.root = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--style') args.style = argv[++i];
    else if (arg === '--map') args.map = argv[++i];
  }
  return args;
}

function defaultRoot() {
  return process.env.DD_WORKSPACE_DIR || path.join(os.tmpdir(), 'strudel-deepdive');
}

/**
 * Стиль паспорта: из задачи, из карты, из ключа — иначе null.
 * @param {object} job
 * @param {object} map
 * @param {string|null} fallback
 * @returns {string|null}
 */
function styleOf(job, map, fallback) {
  const candidates = [
    job?.style,
    job?.result?.style,
    job?.result?.track?.style,
    map?.[job?.id],
    fallback,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().toLowerCase();
  }
  return null;
}

/**
 * Находит готовые паспорта в рабочем каталоге разборов.
 * @param {string} root
 * @returns {object[]} записи задач
 */
function collectJobs(root) {
  if (!existsSync(root)) return [];
  const jobs = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = path.join(root, entry.name, 'job.json');
    if (!existsSync(record)) continue;
    try {
      const job = JSON.parse(readFileSync(record, 'utf8'));
      if (job?.status && job.status !== 'done' && job.status !== 'completed') continue;
      if (!job?.result) continue;
      jobs.push(job);
    } catch {
      // Битый job.json — пропускаем, как будто его нет.
    }
  }
  return jobs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || defaultRoot());
  const out = path.resolve(args.out || path.join(REPO, 'server', 'music', 'knowledge', 'mined'));
  let map = {};
  if (args.map) {
    const mapPath = path.resolve(args.map);
    if (existsSync(mapPath)) map = JSON.parse(readFileSync(mapPath, 'utf8'));
  }

  const jobs = collectJobs(root);
  const features = [];
  const skipped = [];
  for (const job of jobs) {
    const style = styleOf(job, map, args.style);
    if (!style) {
      skipped.push({ id: job.id, reason: 'стиль неизвестен' });
      continue;
    }
    try {
      const extracted = extractFeatures(job.result, { style });
      features.push(extracted);
    } catch (err) {
      skipped.push({ id: job.id, reason: `не разобрался: ${err?.message || err}` });
    }
  }

  const library = buildLibrary(features);
  library.index.target = 20;
  library.index.generatedAt = new Date().toISOString();
  library.index.skipped = skipped.length;
  const check = verifyLibrary(library);
  if (!check.ok) {
    console.error(`Страж утечки мелодии сработал: ${check.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Паспортов найдено: ${jobs.length}`);
  console.log(`Взято в библиотеку: ${features.length}`);
  console.log(`Стилей: ${library.index.styles.length} (порог источников: ${library.index.minSources})`);
  if (skipped.length) {
    console.log(`Пропущено: ${skipped.length}`);
    for (const item of skipped.slice(0, 10)) console.log(`  ${item.id}: ${item.reason}`);
  }

  if (args.dryRun) {
    console.log('(--dry-run: файлы не записаны)');
    return;
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'index.json'), `${JSON.stringify(library.index, null, 2)}\n`, 'utf8');
  for (const [style, stats] of Object.entries(library.styles)) {
    writeFileSync(path.join(out, `${style}.json`), `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
  }
  console.log(`Библиотека записана: ${out}`);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
