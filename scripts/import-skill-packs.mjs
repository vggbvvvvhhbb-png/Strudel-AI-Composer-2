#!/usr/bin/env node
// Импорт скил-паков из исходной спецификации.
//
// Скил-карты пришли как один markdown-файл с пронумерованными разделами,
// где каждый раздел — готовая карта в ограждённом блоке ````markdown.
// Скрипт вытаскивает эти блоки в отдельные файлы репозитория.
//
// Provenance важен: карты — не выдумка этого репозитория, а перенос
// согласованной спецификации. Поэтому исходник указывается явно, а не
// зашивается в код.
//
// Использование:
//   node scripts/import-skill-packs.mjs --source <путь-к-исходнику> [--dry]
//
// Файлы, которые уже есть в репозитории, перезаписываются только с --force:
// импорт не должен молча затирать правки человека.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { source: null, dry: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') args.source = argv[++i];
    else if (arg === '--dry') args.dry = true;
    else if (arg === '--force') args.force = true;
  }
  return args;
}

/**
 * Разбирает исходник на пары «путь внутри репозитория → содержимое».
 *
 * Ограждение — четыре обратные кавычки: внутри карт есть тройные блоки
 * ```js с примерами, и обычное fences-разбиение их бы потеряло.
 */
export function extractSkillPacks(source) {
  const lines = source.split(/\r?\n/);
  const packs = [];
  let current = null;
  let inFence = false;
  let buffer = [];

  for (const line of lines) {
    if (!inFence) {
      const heading = line.match(/^##\s+\d+\.\s+`([^`]+)`/);
      if (heading) {
        current = heading[1].trim();
        continue;
      }
      if (line.startsWith('````markdown')) {
        if (!current) throw new Error(`Блок markdown без заголовка раздела (строка выше)`);
        inFence = true;
        buffer = [];
      }
      continue;
    }
    if (line.startsWith('````')) {
      packs.push({ path: current, content: buffer.join('\n').trimEnd() });
      inFence = false;
      current = null;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  return packs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) {
    console.error('Нужен --source <путь-к-исходнику>');
    process.exit(2);
  }
  const source = await readFile(resolve(args.source), 'utf8');
  const packs = extractSkillPacks(source);
  if (!packs.length) {
    console.error('В исходнике не найдено ни одной скил-карты');
    process.exit(1);
  }

  const written = [];
  for (const pack of packs) {
    const target = resolve(root, pack.path);
    if (!target.startsWith(root)) {
      console.error(`Путь вне репозитория: ${pack.path}`);
      process.exit(1);
    }
    await mkdir(dirname(target), { recursive: true });
    let existing = null;
    try {
      existing = await readFile(target, 'utf8');
    } catch {
      existing = null;
    }
    if (existing !== null && existing.trimEnd() !== pack.content && !args.force) {
      console.log(`ПРОПУЩЕН (отличается, нужен --force): ${pack.path}`);
      continue;
    }
    if (args.dry) {
      console.log(`DRY: ${pack.path} (${pack.content.length} байт)`);
      continue;
    }
    await writeFile(target, `${pack.content}\n`, 'utf8');
    written.push({ path: pack.path, bytes: pack.content.length });
    console.log(`записан ${relative(root, target)} (${pack.content.length} байт)`);
  }
  console.log(`\nИтого: ${written.length} из ${packs.length}`);
}

if (process.argv[1] && process.argv[1].endsWith('import-skill-packs.mjs')) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
