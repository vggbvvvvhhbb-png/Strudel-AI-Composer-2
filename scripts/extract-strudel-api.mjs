// Собирает список экспортируемых функций из установленных пакетов @strudel/*.
//
// Результат — server/music/data/strudel-api.json. Это whitelist для валидатора
// и для промптов: функции вне списка в сгенерированном коде считаются
// неизвестными, и модель о них не узнаёт.
//
// Скрипт работает через UMD-бандл @strudel/web: прямой import @strudel/core
// в Node падает (см. server/music/strudel-runtime.mjs — подробное объяснение).

import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStrudel } from '../server/music/strudel-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const api = await loadStrudel();
const names = Object.keys(api)
  .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
  .sort();

// Паттерны Strudel: их вызывают как методы цепочки (.gain, .lpf, .room…).
// Отдельный список нужен, чтобы whitelist покрывал и свободные функции,
// и методы паттерна.
const patternMethods = Object.getOwnPropertyNames(api.Pattern.prototype)
  .filter((name) => name !== 'constructor')
  .sort();

const payload = {
  generatedAt: new Date().toISOString(),
  source: '@strudel/web (UMD bundle) — единая точка входа для @strudel/core, mini, tonal, transpiler',
  version: readVersion(),
  exports: names,
  patternMethods,
  counts: { exports: names.length, patternMethods: patternMethods.length },
};

const outDir = resolve(root, 'server/music/data');
await mkdir(outDir, { recursive: true });
const outFile = resolve(outDir, 'strudel-api.json');
await writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

console.log(`✓ ${names.length} экспортов, ${patternMethods.length} методов паттерна → ${outFile}`);

function readVersion() {
  try {
    return JSON.parse(
      readFileSync(resolve(root, 'node_modules/@strudel/web/package.json'), 'utf8'),
    ).version;
  } catch {
    return 'unknown';
  }
}
