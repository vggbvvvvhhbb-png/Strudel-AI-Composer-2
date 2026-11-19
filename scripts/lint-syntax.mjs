// Синтаксическая проверка всех исходников без внешних линтеров.
//
// В проекте нет ESLint: держать линтер как dev-зависимость ради проверки
// синтаксиса — лишний вес. `node --check` делает ровно то, что нужно:
// ловит синтаксические ошибки в ES-модулях (включая .mjs).

import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['src', 'server', 'scripts', 'tests', 'eval', 'lib'];
const SKIP = new Set(['node_modules', 'dist', '.git', '.sharrowkin', 'public']);
// Фикстуры «сломанного» кода существуют как данные для тестов валидатора —
// проверять их синтаксис нельзя, они должны быть сломаны.
const SKIP_PATHS = ['tests\\fixtures\\broken', 'tests/fixtures/broken'];

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap((dir) => walk(join(ROOT, dir)));
const failures = [];

for (const file of files) {
  const normalized = file.replace(/\//g, '\\');
  if (SKIP_PATHS.some((skip) => normalized.includes(skip))) continue;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    const message = (error.stderr?.toString() || error.message || '').trim().split('\n').slice(0, 3).join(' ');
    failures.push(`${relative(ROOT, file)}: ${message}`);
  }
}

if (failures.length) {
  console.error(`✗ синтаксических ошибок: ${failures.length}`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`✓ синтаксис в порядке: ${files.length} файлов`);
