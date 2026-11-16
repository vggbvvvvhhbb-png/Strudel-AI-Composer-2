// Синхронизация раздела лицензий пула в docs/LICENSES.md (D-115).
//
//   node scripts/sync-pool-licenses.mjs          # обновить раздел
//   node scripts/sync-pool-licenses.mjs --check  # только проверить
//
// ЗАЧЕМ. Пул сэмплов «Охотника» живёт на машине владельца и в git не идёт,
// но лицензия каждого сэмпла обязана быть видна в реестре проекта. Раздел
// docs/LICENSES.md генерируется из пула, поэтому он не может разойтись с
// фактическим содержимым.
//
// РАЗДЕЛ ПЕРЕЗАПИСЫВАЕТСЯ ЦЕЛИКОМ: между маркерами «начало» и «конец» живёт
// только сгенерированная таблица. Текст вокруг не трогается.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { poolLicensesMarkdown, LICENSE_SECTION_TITLE } from '../server/samples/pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const target = join(root, 'docs', 'LICENSES.md');

const START = '<!-- licenses:pool:start -->';
const END = '<!-- licenses:pool:end -->';

const checkOnly = process.argv.includes('--check');

function buildSection() {
  return [START, poolLicensesMarkdown(), END].join('\n');
}

const source = readFileSync(target, 'utf8');
const section = buildSection();

const startIndex = source.indexOf(START);
const endIndex = source.indexOf(END);
if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
  console.error(`В docs/LICENSES.md нет маркеров раздела «${LICENSE_SECTION_TITLE}»`);
  process.exitCode = 1;
} else {
  const next = `${source.slice(0, startIndex)}${section}${source.slice(endIndex + END.length)}`;
  if (next === source) {
    console.log('Раздел лицензий пула уже актуален.');
  } else if (checkOnly) {
    console.error('Раздел лицензий пула устарел: запустите npm run licenses:pool');
    process.exitCode = 1;
  } else {
    writeFileSync(target, next, 'utf8');
    console.log('Раздел лицензий пула обновлён в docs/LICENSES.md.');
  }
}
