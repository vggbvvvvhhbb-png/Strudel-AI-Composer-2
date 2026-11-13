// Синхронизация списка доступных сэмплов с манифестами банков.
//
// Манифесты банков — внешние источники: они меняются без нашего ведома.
// Поэтому список имён вендорится в репозиторий (server/music/data/sample-banks.json),
// а тест сверяет с ним имена, которые разрешены промптом: имя из промпта,
// которого нет в банке, даёт партию без звука.
//
// Запуск: npm run sync:samples
// (сеть нужна только здесь; в CI используется вендоренный файл)

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const BANKS = [
  { key: 'github:tidalcycles/dirt-samples', url: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json' },
  { key: 'shabda:piano', url: 'https://shabda.ndre.gr/piano.json?strudel=1' },
];

const out = { generatedAt: new Date().toISOString(), banks: {} };

for (const bank of BANKS) {
  const res = await fetch(bank.url);
  if (!res.ok) throw new Error(`${bank.key}: HTTP ${res.status}`);
  const manifest = await res.json();
  const names = Object.keys(manifest)
    .filter((name) => name !== '_base')
    .sort();
  out.banks[bank.key] = { url: bank.url, names };
  console.log(`${bank.key}: ${names.length} имён`);
}

const file = join(root, 'server', 'music', 'data', 'sample-banks.json');
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`записано: ${file}`);
