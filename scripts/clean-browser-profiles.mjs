// Уборка осиротевших профилей Playwright из системного каталога временных
// файлов.
//
// Зачем: Playwright удаляет профиль пользователя только при штатном
// browser.close(). Процесс, убитый без finally, оставляет каталог на диске.
// Накопление таких каталогов заполнило диск C: (134 каталога, ~2.4 ГБ) и
// ворота падали на ENOSPC (E-041).
//
// Употребление:
//   npm run clean:profiles            — убрать всё старше 30 минут
//   npm run clean:profiles -- --dry   — только посчитать, ничего не удалять
//   npm run clean:profiles -- --min 5 — порог в минутах

import { sweepStaleBrowserProfiles } from '../lib/browser.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const minIndex = args.indexOf('--min');
const minMinutes = minIndex >= 0 ? Number(args[minIndex + 1]) : 30;
const minAgeMs = Number.isFinite(minMinutes) && minMinutes > 0 ? minMinutes * 60 * 1000 : 30 * 60 * 1000;

const result = sweepStaleBrowserProfiles({ minAgeMs, dryRun });

console.log(dryRun ? 'Сухая уборка (ничего не удалено):' : 'Уборка профилей Playwright:');
console.log('  просмотрено каталогов: ' + result.scanned);
console.log('  ' + (dryRun ? 'подлежало бы удалению: ' : 'удалено: ') + result.removed.length);
console.log('  освобождено: ' + (result.freedBytes / (1024 * 1024)).toFixed(1) + ' МБ');
if (result.skipped.length) {
  console.log('  пропущено: ' + result.skipped.length);
  for (const item of result.skipped.slice(0, 10)) console.log('    ' + item.name + ' — ' + item.reason);
  if (result.skipped.length > 10) console.log('    …ещё ' + (result.skipped.length - 10));
}
