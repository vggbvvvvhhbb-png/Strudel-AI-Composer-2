#!/usr/bin/env node
// CI-проверка Baseline-0: корпус не должен меняться молча.
//
//   node scripts/check-baseline.mjs
//
// Проверяет:
//   • sha256 файлов корпуса совпадает с манифестом (заморозка);
//   • сплит train/val/test пересчитывается из id и совпадает с манифестом;
//   • 60 промтов: 4 квадранта × 5 жанров × 3 плотности, без повторов;
//   • каждому промту соответствует рендер: IR валиден, код есть, хэши записаны.
//
// Код возврата: 0 — корпус цел, 1 — корпус изменён или сломан.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dir = join(root, 'corpus', 'baseline0');

const errors = [];

/**
 * @param {string} where
 * @param {string} message
 */
function fail(where, message) {
  errors.push({ where, message });
}

const promptsFile = join(dir, 'prompts.json');
const rendersFile = join(dir, 'renders.json');
const manifestFile = join(dir, 'manifest.json');

for (const file of [promptsFile, rendersFile, manifestFile]) {
  if (!existsSync(file)) {
    console.error(`Baseline-0: нет файла ${file}. Собери корпус: npm run baseline:build`);
    process.exit(1);
  }
}

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const promptsDoc = JSON.parse(readFileSync(promptsFile, 'utf8'));
const rendersDoc = JSON.parse(readFileSync(rendersFile, 'utf8'));

/** sha256 файла. */
function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ─── заморозка ────────────────────────────────────────────────────────────
for (const [name, expected] of Object.entries(manifest.files ?? {})) {
  const actual = fileHash(join(dir, name));
  if (actual !== expected) {
    fail(name, `файл изменён: sha256 ${actual.slice(0, 12)}… ≠ манифест ${String(expected).slice(0, 12)}… `
      + '(Baseline-0 заморожен; пересборка — осознанное решение, см. docs/DECISIONS.md)');
  }
}

// ─── состав корпуса ──────────────────────────────────────────────────────
const prompts = promptsDoc.prompts ?? [];
if (prompts.length !== 60) {
  fail('prompts.json', `промтов ${prompts.length}, ожидалось 60`);
}
const texts = new Set();
const quadrants = new Set();
const genres = new Set();
const densities = new Set();
for (const item of prompts) {
  if (!item.id || !item.prompt) fail('prompts.json', `промт без id или текста: ${JSON.stringify(item).slice(0, 80)}`);
  if (texts.has(item.prompt)) fail('prompts.json', `повтор промта: «${item.prompt}»`);
  texts.add(item.prompt);
  quadrants.add(item.quadrant);
  genres.add(item.genre);
  densities.add(item.density);
}
if (quadrants.size !== 4) fail('prompts.json', `квадрантов ${quadrants.size}, ожидалось 4`);
if (genres.size !== 5) fail('prompts.json', `жанров ${genres.size}, ожидалось 5`);
if (densities.size !== 3) fail('prompts.json', `плотностей ${densities.size}, ожидалось 3`);

// ─── сплит ────────────────────────────────────────────────────────────────
const ordered = [...prompts].sort((a, b) => {
  const ha = createHash('sha256').update(a.id, 'utf8').digest('hex');
  const hb = createHash('sha256').update(b.id, 'utf8').digest('hex');
  return ha < hb ? -1 : ha > hb ? 1 : 0;
});
const ids = ordered.map((item) => item.id);
const expectedSplits = {
  train: ids.slice(0, 36),
  val: ids.slice(36, 48),
  test: ids.slice(48, 60),
};
for (const [name, expected] of Object.entries(expectedSplits)) {
  const actual = manifest.splits?.[name] ?? [];
  if (actual.length !== expected.length) {
    fail('manifest.json', `сплит ${name}: ${actual.length} промтов, ожидалось ${expected.length}`);
  }
  const missing = expected.filter((id) => !actual.includes(id));
  if (missing.length) {
    fail('manifest.json', `сплит ${name}: состав не совпадает с пересчётом по хэшу (например, ${missing[0]})`);
  }
}

// ─── рендеры ──────────────────────────────────────────────────────────────
const renders = rendersDoc.renders ?? [];
if (renders.length !== prompts.length) {
  fail('renders.json', `рендеров ${renders.length}, промтов ${prompts.length}`);
}
const byId = new Map(prompts.map((item) => [item.id, item]));
for (const render of renders) {
  if (!byId.has(render.id)) fail('renders.json', `рендер с неизвестным id ${render.id}`);
  if (!render.valid) fail('renders.json', `${render.id}: IR не прошёл проверку схемы`);
  if (!render.code || !render.code.includes('$')) fail('renders.json', `${render.id}: нет скомпилированного кода`);
  const hash = createHash('sha256').update(render.code, 'utf8').digest('hex');
  if (hash !== render.codeHash) fail('renders.json', `${render.id}: codeHash не совпадает с кодом`);
}

// ─── отчёт ────────────────────────────────────────────────────────────────
const lintBad = renders.filter((item) => item.lintErrors > 0);
const meanScore = renders.length
  ? (renders.reduce((sum, item) => sum + item.score, 0) / renders.length).toFixed(1)
  : '—';

console.log(`Baseline-0 ${manifest.version}: ${prompts.length} промтов, версия ${String(manifest.files['prompts.json']).slice(0, 12)}…`);
console.log(`  сплит: train ${manifest.splits.train.length} / val ${manifest.splits.val.length} / test ${manifest.splits.test.length}`);
console.log(`  средний символьный скор: ${meanScore}; с lint-ошибками: ${lintBad.length}`);

// Доказательство — файл, а не пересказ.
const evidenceFile = join(root, 'docs', 'evidence', 'baseline', 'check-baseline.json');
mkdirSync(dirname(evidenceFile), { recursive: true });
writeFileSync(evidenceFile, `${JSON.stringify({
  checkedAt: new Date().toISOString(),
  version: manifest.version,
  prompts: prompts.length,
  counts: manifest.counts,
  files: manifest.files,
  meanScore: Number(meanScore),
  lintErrorTracks: lintBad.length,
  errors,
  ok: errors.length === 0,
}, null, 2)}\n`, 'utf8');

if (errors.length) {
  console.log(`\nОшибки (${errors.length}):`);
  for (const item of errors) console.log(`  ✗ ${item.where}: ${item.message}`);
  process.exit(1);
}
console.log('\nКорпус цел: Baseline-0 не менялся.');
console.log('Доказательство: docs/evidence/baseline/check-baseline.json');
