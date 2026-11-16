// Локальный пул сэмплов: реестр найденных звуков с их паспортами (D-115).
//
// ЗАЧЕМ. Найденный в Freesound сэмпл должен не просто существовать, а быть
// найденным снова: по описанию («стеклянный удар с металлическим хвостом»)
// и по измеренным признакам. Пул — это реестр записей вида
// {id, name, source, license, attribution, passport, file}.
//
// ЛИЦЕНЗИЯ — ЧАСТЬ ЗАПИСИ. Запись без лицензии и атрибуции не попадает в
// пул: несвободный звук не должен ни попасть на диск, ни забыться.
//
// ЧЕСТНОСТЬ. Пустой пул — это пустой пул, а не «нашлось 12 звуков».

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalLicense } from '../agent/freesound.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Каталог пула по умолчанию. */
export const POOL_DIR = path.resolve(HERE, '..', '..', 'data', 'samples');
/** Файл реестра пула. */
export const POOL_FILE = path.join(POOL_DIR, 'pool.json');
/** Каталог с самими звуками. */
export const POOL_AUDIO_DIR = path.join(POOL_DIR, 'audio');

/**
 * Читает реестр пула.
 * @param {string} [file]
 * @returns {{samples:object, updatedAt:string|null}}
 */
export function readPool(file = POOL_FILE) {
  if (!existsSync(file)) return { samples: {}, updatedAt: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { samples: parsed.samples ?? {}, updatedAt: parsed.updatedAt ?? null };
  } catch {
    return { samples: {}, updatedAt: null };
  }
}

/**
 * Пишет реестр пула.
 * @param {{samples:object}} pool
 * @param {string} [file]
 */
export function writePool(pool, file = POOL_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    note: 'Реестр локального пула сэмплов. Паспорт — измеренные признаки, не пересказ.',
    samples: pool.samples ?? {},
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

/**
 * Строка атрибуции TASL: название, автор, источник, лицензия.
 *
 * Для CC-BY атрибуция обязательна, поэтому строка готовится всегда: показывать
 * её — значит не забыть про неё.
 *
 * @param {object} entry
 * @returns {string}
 */
export function attributionFor(entry) {
  if (!entry) return 'Сэмпл: источник неизвестен';
  const name = entry.name ?? 'без названия';
  const author = entry.author ? ` by ${entry.author}` : '';
  const license = entry.licenseId === 'cc-by'
    ? 'CC BY 4.0'
    : (entry.licenseId === 'cc0' ? 'CC0 1.0' : (entry.license ?? 'лицензия неизвестна'));
  const source = entry.url ?? entry.source ?? 'источник не указан';
  return `«${name}»${author} — ${license} — ${source}`;
}

/**
 * Добавляет запись в пул. Лицензия проверяется: неразрешённая отклоняется.
 *
 * @param {object} entry {id, name, author, url, license, licenseId, passport, file}
 * @param {{file?:string}} [options]
 * @returns {{ok:boolean, reason?:string, entry?:object}}
 */
export function addToPool(entry, { file = POOL_FILE } = {}) {
  const id = String(entry?.id ?? '').trim();
  if (!id) return { ok: false, reason: 'у записи нет идентификатора' };
  const licenseId = entry.licenseId ?? canonicalLicense(entry.license);
  if (!licenseId) {
    return { ok: false, reason: `лицензия «${entry.license ?? '—'}» не в списке разрешённых (cc0, cc-by)` };
  }
  const pool = readPool(file);
  const record = {
    id,
    name: entry.name ?? id,
    author: entry.author ?? null,
    url: entry.url ?? null,
    source: entry.source ?? 'freesound',
    license: entry.license ?? (licenseId === 'cc0' ? 'Creative Commons 0' : 'Attribution'),
    licenseId,
    file: entry.file ?? null,
    passport: entry.passport ?? null,
    addedAt: entry.addedAt ?? new Date().toISOString(),
  };
  record.attribution = attributionFor(record);
  pool.samples[id] = record;
  writePool(pool, file);
  return { ok: true, entry: record };
}

/**
 * Запись из пула по идентификатору.
 * @param {string} id
 * @param {{file?:string}} [options]
 * @returns {object|null}
 */
export function getFromPool(id, { file = POOL_FILE } = {}) {
  return readPool(file).samples[String(id ?? '')] ?? null;
}

/**
 * Все записи пула.
 * @param {{file?:string}} [options]
 * @returns {object[]}
 */
export function listPool({ file = POOL_FILE } = {}) {
  const pool = readPool(file);
  return Object.values(pool.samples).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Поиск по пулу по описанию.
 *
 * Сопоставление по словам описания (теги, имя) и по измеренным признакам:
 * «ударный» и «тональный» сопоставляются с character из паспорта.
 *
 * @param {string} query
 * @param {{file?:string, limit?:number}} [options]
 * @returns {Array<{entry:object, score:number, matched:string[]}>}
 */
export function searchPool(query, { file = POOL_FILE, limit = 10 } = {}) {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return [];
  const words = text.split(/[^a-zа-я0-9+#-]+/i).filter((word) => word.length >= 3);
  const results = [];
  for (const entry of listPool({ file })) {
    const haystack = [
      entry.name,
      entry.author,
      entry.attribution,
      ...(entry.passport?.character ?? []),
      ...(entry.passport?.tags ?? []),
    ].filter(Boolean).join(' ').toLowerCase();
    const matched = words.filter((word) => haystack.includes(word));
    if (!matched.length) continue;
    results.push({ entry, score: matched.length / Math.max(1, words.length), matched });
  }
  results.sort((a, b) => b.score - a.score || String(a.entry.id).localeCompare(String(b.entry.id)));
  return results.slice(0, limit);
}

/**
 * Реестр лицензий пула — машинный вид для гейта.
 *
 * @param {{file?:string}} [options]
 * @returns {{samples:object, totals:{samples:number, cc0:number, ccBy:number}}}
 */
export function poolLicenseRegistry({ file = POOL_FILE } = {}) {
  const entries = listPool({ file });
  const samples = {};
  for (const entry of entries) {
    samples[entry.id] = {
      license: entry.license ?? null,
      licenseId: entry.licenseId ?? null,
      source: entry.url ?? entry.source ?? null,
      checkedAt: (entry.addedAt ?? '').slice(0, 10) || null,
      verdict: entry.licenseId === 'cc0' || entry.licenseId === 'cc-by'
        ? 'разрешено по умолчанию'
        : 'требует решения владельца',
      attributionRequired: entry.licenseId === 'cc-by',
      attribution: entry.attribution ?? null,
    };
  }
  return {
    samples,
    totals: {
      samples: entries.length,
      cc0: entries.filter((entry) => entry.licenseId === 'cc0').length,
      ccBy: entries.filter((entry) => entry.licenseId === 'cc-by').length,
    },
  };
}

/** Заголовок раздела пула в docs/LICENSES.md. */
export const LICENSE_SECTION_TITLE = '## 8. Локальный пул сэмплов «Охотника» (D-115)';

/**
 * Markdown-раздел для docs/LICENSES.md: все записи пула с лицензией.
 *
 * Атрибуция CC-BY обязательна, поэтому строка атрибуции печатается целиком.
 *
 * @param {{file?:string}} [options]
 * @returns {string}
 */
export function poolLicensesMarkdown({ file = POOL_FILE } = {}) {
  const entries = listPool({ file });
  const lines = [
    LICENSE_SECTION_TITLE,
    '',
    '*Раздел генерируется из `data/samples/pool.json` — скриптом `npm run licenses:pool`. '
    + 'Пул живёт на машине владельца; в публичный релиз он не входит, но лицензия каждого '
    + 'сэмпла обязана быть видна.*',
    '',
  ];
  if (!entries.length) {
    lines.push('Записей нет: пул пуст.');
    return lines.join('\n');
  }
  lines.push('| Сэмпл | Автор | Лицензия | Атрибуция (TASL) | Источник | Добавлен |');
  lines.push('|---|---|---|---|---|---|');
  for (const entry of entries) {
    const license = entry.licenseId === 'cc-by' ? 'CC BY 4.0' : (entry.licenseId === 'cc0' ? 'CC0 1.0' : (entry.license ?? '—'));
    lines.push('| ' + [
      entry.name ?? entry.id,
      entry.author ?? '—',
      license,
      entry.attribution ?? '—',
      entry.url ? `[ссылка](${entry.url})` : '—',
      (entry.addedAt ?? '').slice(0, 10) || '—',
    ].map((cell) => String(cell).replaceAll('|', '\\|')).join(' | ') + ' |');
  }
  return lines.join('\n');
}
