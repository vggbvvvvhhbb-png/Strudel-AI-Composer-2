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
import { fileURLToPath, pathToFileURL } from 'node:url';

import { poolLicensesMarkdown, LICENSE_SECTION_TITLE } from '../server/samples/pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const target = join(root, 'docs', 'LICENSES.md');

export const START = '<!-- licenses:pool:start -->';
export const END = '<!-- licenses:pool:end -->';

/**
 * Вставляет секцию (в LF) между маркерами, сохраняя стиль переносов файла.
 *
 * Файл может быть в CRLF (Windows-чекаут с core.autocrlf): без приведения
 * секции к стилю файла сравнение всегда даёт «устарел», хотя содержимое
 * идентично — именно так ворота licenses:pool были красными на Windows.
 *
 * @param {string} source содержимое файла
 * @param {string} sectionLf секция в LF-переносах
 * @returns {{ok:boolean, next:string, changed:boolean}}
 */
export function applySection(source, sectionLf) {
  const startIndex = source.indexOf(START);
  const endIndex = source.indexOf(END);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    return { ok: false, next: source, changed: false };
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const section = sectionLf.replace(/\r?\n/g, eol);
  const next = `${source.slice(0, startIndex)}${section}${source.slice(endIndex + END.length)}`;
  return { ok: true, next, changed: next !== source };
}

function buildSection() {
  return [START, poolLicensesMarkdown(), END].join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const source = readFileSync(target, 'utf8');
  const result = applySection(source, buildSection());
  if (!result.ok) {
    console.error(`В docs/LICENSES.md нет маркеров раздела «${LICENSE_SECTION_TITLE}»`);
    process.exitCode = 1;
    return;
  }
  if (!result.changed) {
    console.log('Раздел лицензий пула уже актуален.');
  } else if (checkOnly) {
    console.error('Раздел лицензий пула устарел: запустите npm run licenses:pool');
    process.exitCode = 1;
  } else {
    writeFileSync(target, result.next, 'utf8');
    console.log('Раздел лицензий пула обновлён в docs/LICENSES.md.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}