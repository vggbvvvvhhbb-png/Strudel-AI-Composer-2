// Бюджет бандла: размер собранного клиента не должен расти незаметно.
//
// Проверяем и сырой, и gzip-размер (как его отдаёт CDN). Бюджеты — в одном
// месте, чтобы их правка была осознанной, а не «размер вырос и ничего не
// сломалось».

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

// Бюджеты в килобайтах. Следим за общим размером клиента и за самым
// тяжёлым чанком: именно он определяет время до первого взаимодействия.
export const BUDGETS = {
  totalJsKb: 1200,
  totalCssKb: 120,
  largestChunkKb: 900,
  gzipTotalKb: 400,
};

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(DIST);
if (!files.length) {
  console.error('✗ нет сборки: сначала npm run build');
  process.exit(1);
}

let js = 0;
let css = 0;
let gzip = 0;
let largest = { file: '—', kb: 0 };

for (const file of files) {
  const buf = readFileSync(file);
  const kb = buf.length / 1024;
  if (file.endsWith('.js')) {
    js += kb;
    gzip += gzipSync(buf).length / 1024;
    if (kb > largest.kb) largest = { file: file.slice(DIST.length + 1), kb };
  } else if (file.endsWith('.css')) {
    css += kb;
    gzip += gzipSync(buf).length / 1024;
  }
}

const rows = [
  ['JS, всего', js, BUDGETS.totalJsKb],
  ['CSS, всего', css, BUDGETS.totalCssKb],
  ['самый тяжёлый чанк', largest.kb, BUDGETS.largestChunkKb],
  ['gzip (js+css)', gzip, BUDGETS.gzipTotalKb],
];

console.log('Бюджет бандла');
for (const [label, value, limit] of rows) {
  const ok = value <= limit;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${value.toFixed(1)} КБ / ${limit} КБ`);
}
console.log(`  крупнейший файл: ${largest.file} (${largest.kb.toFixed(1)} КБ)`);

const over = rows.filter(([, value, limit]) => value > limit);
if (over.length) {
  console.error(`✗ превышен бюджет: ${over.map(([label]) => label).join(', ')}`);
  process.exit(1);
}
