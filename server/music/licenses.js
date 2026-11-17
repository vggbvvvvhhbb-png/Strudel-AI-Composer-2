// Лицензии сэмпл-банков: машинный реестр и его проверка.
//
// ЗАЧЕМ. Студия грузит банки сэмплов целиком — 218 имён dirt-samples и
// пианино shabda. Лицензия этих банков не подтверждена (docs/LICENSES.md §3),
// и до решения владельца это блокер публикации. Пока решение не принято,
// нужен честный счётчик: сколько банков и сколько имён сэмплов мы грузим
// без подтверждённого разрешения.
//
// ПРАВИЛО. «Не нашёл запрета» ≠ «разрешено». Банк считается подтверждённым
// только если в реестре стоит вердикт «разрешено по умолчанию». Всё остальное
// — «требует решения владельца», и публичный релиз заблокирован.
//
// ОХОТНИК (D-115). Сэмплы, скачанные в локальный пул, — отдельный слой
// реестра: у каждого своя лицензия (CC0 или CC-BY) и своя строка атрибуции.
// Они считаются в том же отчёте, но не блокируют банковый релиз: пул живёт
// на машине владельца и в публичный релиз не входит.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { poolLicenseRegistry } from '../samples/pool.js';
import { loadTimbreCatalog, timbreReport } from '../samples/timbre.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');

/** Вердикт, при котором банк можно распространять без дополнительных решений. */
export const VERDICT_OK = 'разрешено по умолчанию';
/** Вердикт, при котором нужен письменный ответ владельца. */
export const VERDICT_DECISION = 'требует решения владельца';

/**
 * Прочитать реестры: манифесты банков (какие имена есть) и лицензии
 * (что с ними по праву).
 * @returns {{banks: object, licenses: object, pool: object}}
 */
export function loadRegistry() {
  const banks = JSON.parse(readFileSync(join(dataDir, 'sample-banks.json'), 'utf8'));
  const licenses = JSON.parse(readFileSync(join(dataDir, 'sample-licenses.json'), 'utf8'));
  let pool = { samples: {}, totals: { samples: 0, cc0: 0, ccBy: 0 } };
  try {
    pool = poolLicenseRegistry();
  } catch {
    // Пула нет — это «нет данных», а не ошибка: счётчик остаётся нулевым.
  }
  return { banks: banks.banks ?? {}, licenses: licenses.banks ?? {}, pool };
}

/**
 * Проверка реестра лицензий.
 *
 * @param {{banks: object, licenses: object}} [registry]
 * @returns {{
 *   ok: boolean,
 *   missing: string[],
 *   incomplete: string[],
 *   banks: Array<object>,
 *   totals: {banks:number, confirmed:number, unresolved:number, names:number, unresolvedNames:number},
 *   releaseBlocked: boolean
 * }}
 */
export function auditLicenses(registry = loadRegistry()) {
  const bankNames = Object.keys(registry.banks ?? {});
  const missing = [];
  const incomplete = [];
  const rows = [];

  for (const key of bankNames) {
    const entry = registry.licenses?.[key];
    const names = registry.banks?.[key]?.names?.length ?? 0;
    if (!entry) {
      missing.push(key);
      rows.push({
        key,
        names,
        license: null,
        verdict: null,
        confirmed: false,
        requiresDecision: false,
        reason: 'нет записи в реестре лицензий',
      });
      continue;
    }
    // Запись без источника или даты проверки — не запись, а опечатка.
    const required = ['license', 'source', 'checkedAt', 'verdict'];
    const gaps = required.filter((field) => !entry[field]);
    if (gaps.length) {
      incomplete.push(`${key}: нет ${gaps.join(', ')}`);
    }
    const confirmed = entry.verdict === VERDICT_OK;
    const requiresDecision = entry.verdict === VERDICT_DECISION;
    rows.push({
      key,
      names,
      license: entry.license ?? null,
      licenseId: entry.licenseId ?? null,
      scope: entry.scope ?? null,
      verdict: entry.verdict ?? null,
      confirmed,
      requiresDecision,
      reason: gaps.length
        ? `запись неполная: нет ${gaps.join(', ')}`
        : (entry.note ?? null),
      source: entry.source ?? null,
      checkedAt: entry.checkedAt ?? null,
    });
  }

  const unresolved = rows.filter((row) => !row.confirmed);
  const totals = {
    banks: rows.length,
    confirmed: rows.length - unresolved.length,
    unresolved: unresolved.length,
    names: rows.reduce((sum, row) => sum + row.names, 0),
    unresolvedNames: unresolved.reduce((sum, row) => sum + row.names, 0),
  };

  return {
    ok: missing.length === 0 && incomplete.length === 0,
    missing,
    incomplete,
    banks: rows,
    totals,
    // Публичный релиз заблокирован, если хоть один грузимый банк без
    // подтверждённой лицензии. Это не «сбой», а измерение: решение владельца
    // ещё не принято (см. docs/DECISIONS.md, D-099).
    releaseBlocked: unresolved.length > 0,
  };
}

/**
 * Строка атрибуции для банка (TASL: название, автор, источник, лицензия).
 *
 * Если лицензия не подтверждена, строка говорит об этом прямо: лучше
 * «лицензия не подтверждена», чем тишина, которая выглядит как «всё в
 * порядке».
 *
 * @param {object} entry запись реестра
 * @returns {string}
 */
export function attributionFor(entry) {
  if (!entry) return 'Банк сэмплов: лицензия неизвестна';
  const license = entry.licenseId || entry.license || 'не подтверждена';
  const source = entry.source ?? 'источник не указан';
  return `Банк сэмплов: ${entry.repository ?? source} — лицензия ${license}`;
}

/**
 * Отчёт для API: что грузим и в каком правовом статусе.
 * @param {{banks: object, licenses: object}} [registry]
 */
export function licenseReport(registry = loadRegistry()) {
  const audit = auditLicenses(registry);
  const bankNames = Object.values(registry.banks ?? {}).flatMap((bank) => bank.names ?? []);
  const timbre = timbreReport(loadTimbreCatalog(), { bankNames });
  return {
    ok: audit.ok && timbre.ok,
    releaseBlocked: audit.releaseBlocked || timbre.releaseBlocked,
    totals: audit.totals,
    pool: registry.pool ?? { samples: {}, totals: { samples: 0, cc0: 0, ccBy: 0 } },
    timbre,
    banks: audit.banks.map((row) => ({
      key: row.key,
      names: row.names,
      license: row.license,
      licenseId: row.licenseId,
      scope: row.scope,
      verdict: row.verdict,
      confirmed: row.confirmed,
      requiresDecision: row.requiresDecision,
      reason: row.reason,
      source: row.source,
      checkedAt: row.checkedAt,
      attribution: attributionFor(registry.licenses?.[row.key]),
    })),
    policy: registry.licenses?.policy ?? null,
  };
}
