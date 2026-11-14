#!/usr/bin/env node
// Пул промтов для очереди человеческих меток.
//
//   node scripts/build-queue-prompts.mjs --update   # пересобрать из корпуса
//   node scripts/build-queue-prompts.mjs --check     # проверить, что свежо
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Очередь пар должна предлагать владельцу РАЗНЫЕ
// промты: приёмка по брифу §7.2 требует ≥50 разных промтов, а очередь из
// десяти строк даёт десять. Корпус Baseline-0 уже содержит 60
// стратифицированных промтов (4 квадранта × 5 жанров × 3 плотности) —
// берём их оттуда.
//
// Файл лежит рядом с сервером (server/preference/prompts.json), потому что
// каталог corpus/ не попадает в образ, а очередь нужна и на сервере.
// Связь с корпусом проверяется по хэшу: файл не может разойтись с
// корпусом молча.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const sourceFile = join(root, 'corpus', 'baseline0', 'prompts.json');
const targetFile = join(root, 'server', 'preference', 'prompts.json');

const update = process.argv.includes('--update');

if (!existsSync(sourceFile)) {
  console.error(`Нет корпуса: ${sourceFile}. Собери его: npm run baseline:build`);
  process.exit(1);
}

const raw = readFileSync(sourceFile);
const sourceHash = createHash('sha256').update(raw).digest('hex');
const corpus = JSON.parse(raw.toString('utf8'));
const prompts = (corpus.prompts ?? []).map((item) => ({
  id: item.id,
  prompt: item.prompt,
  seed: item.seed,
  quadrant: item.quadrant,
  genre: item.genre,
  density: item.density,
}));

if (!prompts.length) {
  console.error('В корпусе нет промтов.');
  process.exit(1);
}

const document = {
  v: 1,
  note: 'Пул промтов для очереди человеческих меток. Генерируется из корпуса Baseline-0.',
  source: 'corpus/baseline0/prompts.json',
  sourceHash,
  prompts,
};

const serialized = `${JSON.stringify(document, null, 2)}\n`;

if (update) {
  writeFileSync(targetFile, serialized, 'utf8');
  console.log(`Пул промтов записан: ${targetFile} (${prompts.length} промтов, источник ${sourceHash.slice(0, 12)}…)`);
  process.exit(0);
}

// Проверка: файл есть, свежий и совпадает с корпусом.
const errors = [];
if (!existsSync(targetFile)) {
  errors.push(`нет файла ${targetFile} — собери: npm run queue:prompts`);
} else {
  const current = JSON.parse(readFileSync(targetFile, 'utf8'));
  if (current.sourceHash !== sourceHash) {
    errors.push('пул разошёлся с корпусом: sourceHash не совпадает '
      + `(пул ${String(current.sourceHash).slice(0, 12)}… vs корпус ${sourceHash.slice(0, 12)}…)`);
  }
  if ((current.prompts ?? []).length !== prompts.length) {
    errors.push(`промтов в пуле ${(current.prompts ?? []).length}, в корпусе ${prompts.length}`);
  }
  if (JSON.stringify(current.prompts ?? []) !== JSON.stringify(prompts)) {
    errors.push('состав пула не совпадает с корпусом');
  }
}

if (errors.length) {
  console.error('Пул промтов устарел:');
  for (const message of errors) console.error(`  ✗ ${message}`);
  console.error('Пересобери: npm run queue:prompts');
  process.exit(1);
}

console.log(`Пул промтов свежий: ${prompts.length} промтов, источник ${sourceHash.slice(0, 12)}…`);
