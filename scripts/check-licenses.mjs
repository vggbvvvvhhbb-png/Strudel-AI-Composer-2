// Гейт лицензий сэмпл-банков и каталога Timbre Palette.
//
//   node scripts/check-licenses.mjs           # механизм реестра
//   node scripts/check-licenses.mjs --release # ворота публикации
//
// ЧТО ПРОВЕРЯЕТСЯ (механизм):
//   * каждый банк, который грузит приложение, есть в реестре лицензий;
//   * в каждой записи есть лицензия, первоисточник, дата проверки и вердикт;
//   * список банков в коде и в реестре — один и тот же (иначе банк можно
//     добавить «по памяти», а лицензия останется непроверенной);
//   * каталог Timbre (D-126): каждый ассет имеет полную запись прав,
//     ссылки пресетов и зон целы, alias живут в неймспейсе tp_ и не
//     конфликтуют с банками/синтезаторами. Регистрация звукового источника
//     в обход этого реестра запрещена: каталог — единый источник истины
//     пресетов, гейт читает его напрямую.
//
// ЧТО ИЗМЕРЯЕТСЯ (содержание):
//   сколько банков и сколько имён сэмплов мы грузим без подтверждённой
//   лицензии. Сейчас это 2 банка и 219 имён: лицензия dirt-samples не
//   подтверждена (LICENSE-файла нет), а у shabda:piano лицензия каждого
//   сэмпла наследуется от Freesound и в манифесте не отдаётся.
//   Плюс ассеты каталога Timbre без rights_status=approved.
//
// ЧТО ЗНАЧИТ КРАСНЫЙ ЦВЕТ. Публичный релиз заблокирован, пока нет письменного
// решения владельца (docs/DECISIONS.md, D-099) и пока в публикуемом наборе
// есть ассеты без подтверждённых прав. Это не сбой гейта, а измерение:
// гейт зелёный (реестр полон и проверяем), а ворота публикации красные
// (решения нет). В CI гейт механизма зелёный; `check:release` запускается
// вручную перед публикацией.
//
// Пишет docs/evidence/licenses/gate.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditLicenses, loadRegistry, licenseReport } from '../server/music/licenses.js';
import { SAMPLE_SETS } from '../src/sample-banks.js';
import { auditTimbre, loadTimbreCatalog, timbreReport } from '../server/samples/timbre.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const evidenceDir = join(root, 'docs', 'evidence', 'licenses');

const releaseMode = process.argv.includes('--release');

const checks = [];

/**
 * Записать результат проверки.
 * @param {string} name
 * @param {boolean} passed
 * @param {string} detail
 * @param {object} [numbers]
 * @param {{releaseOnly?: boolean}} [options] releaseOnly — проверка ворот публикации, не механики
 */
function check(name, passed, detail, numbers = null, { releaseOnly = false } = {}) {
  checks.push({ name, passed: Boolean(passed), detail, numbers, releaseOnly });
}

const registry = loadRegistry();
const audit = auditLicenses(registry);

// --- 1. Покрытие банков ---

const usedNotInRegistry = SAMPLE_SETS.filter((key) => !registry.licenses?.[key]);
check(
  'Банки из кода есть в реестре лицензий',
  usedNotInRegistry.length === 0,
  usedNotInRegistry.length === 0
    ? `все ${SAMPLE_SETS.length} банка(ов) из кода зафиксированы в реестре`
    : `не зафиксированы: ${usedNotInRegistry.join(', ')}`,
  { used: SAMPLE_SETS.length, missing: usedNotInRegistry },
);

const registryNotInCode = Object.keys(registry.licenses ?? {}).filter((key) => !SAMPLE_SETS.includes(key));
check(
  'Реестр не шире списка банков в коде',
  registryNotInCode.length === 0,
  registryNotInCode.length === 0
    ? 'лишних записей нет'
    : `в реестре есть банки, которых нет в коде: ${registryNotInCode.join(', ')}`,
  { extra: registryNotInCode },
);

// --- 2. Полнота записей ---

check(
  'У каждой записи есть лицензия, источник, дата и вердикт',
  audit.incomplete.length === 0,
  audit.incomplete.length === 0
    ? 'все записи полные'
    : audit.incomplete.join('; '),
  { incomplete: audit.incomplete },
);

check(
  'Каждый банк из манифеста описан в реестре',
  audit.missing.length === 0,
  audit.missing.length === 0
    ? 'пропусков нет'
    : `нет записей: ${audit.missing.join(', ')}`,
  { missing: audit.missing },
);

// --- 3. Измерение: сколько грузим без подтверждённой лицензии ---

const unresolved = audit.banks.filter((row) => !row.confirmed);
check(
  'Публичный релиз не заблокирован',
  !audit.releaseBlocked,
  audit.releaseBlocked
    ? `заблокирован: ${unresolved.length} банка(ов) без подтверждённой лицензии, `
      + `${audit.totals.unresolvedNames} имён сэмплов — ждём решения владельца (D-099)`
    : 'блокеров нет',
  { unresolved: unresolved.map((row) => row.key), names: audit.totals.unresolvedNames },
  { releaseOnly: true },
);

// --- 4. Каталог Timbre Palette (D-126): asset-level права ---

const timbreCatalog = loadTimbreCatalog();
const bankNames = Object.values(registry.banks ?? {}).flatMap((bank) => bank.names ?? []);
const timbreAudit = auditTimbre(timbreCatalog, { bankNames });

check(
  'Каталог Timbre: реестр прав полон и ссылки целы',
  timbreAudit.ok,
  timbreAudit.ok
    ? `источников ${timbreAudit.totals.sources}, ассетов ${timbreAudit.totals.assets}, `
      + `пресетов ${timbreAudit.totals.presets}, зон ${timbreAudit.totals.zones}`
    : timbreAudit.issues.map((issue) => issue.detail).join('; '),
  { totals: timbreAudit.totals, issues: timbreAudit.issues },
);

check(
  'Ассеты каталога Timbre подтверждены для релиза',
  !timbreAudit.releaseBlocked,
  timbreAudit.releaseBlocked
    ? `заблокирован: ${timbreAudit.unapprovedAssets.length} ассет(ов) пресетов без rights_status=approved: `
      + timbreAudit.unapprovedAssets.join(', ')
    : 'все ассеты публикуемого набора approved (или каталог пуст)',
  { unapproved: timbreAudit.unapprovedAssets, usedAssets: timbreAudit.totals.usedAssets },
  { releaseOnly: true },
);

// --- Вывод ---

for (const item of checks) {
  console.log(`${item.passed ? '✓' : '✗'} ${item.name} — ${item.detail}`);
}

console.log('');
console.log(`банков: ${audit.totals.banks}, имён сэмплов: ${audit.totals.names}`);
console.log(`подтверждено: ${audit.totals.confirmed} банка(ов); без подтверждения: ${audit.totals.unresolved} банка(ов), ${audit.totals.unresolvedNames} имён`);
for (const row of audit.banks) {
  console.log(`  • ${row.key}: ${row.license ?? 'нет данных'} — ${row.verdict ?? 'вердикт не задан'}${row.reason ? ` (${row.reason})` : ''}`);
}
console.log(`каталог Timbre: источников ${timbreAudit.totals.sources}, ассетов ${timbreAudit.totals.assets} (approved ${timbreAudit.totals.approvedAssets}), пресетов ${timbreAudit.totals.presets}, зон ${timbreAudit.totals.zones}`);

const mechanismOk = checks
  .filter((item) => !item.releaseOnly)
  .every((item) => item.passed);

const releaseBlocked = audit.releaseBlocked || timbreAudit.releaseBlocked;

const evidence = {
  generatedAt: new Date().toISOString(),
  mode: releaseMode ? 'release' : 'mechanism',
  ok: mechanismOk,
  releaseBlocked,
  totals: audit.totals,
  usedBanks: SAMPLE_SETS,
  banks: licenseReport(registry).banks,
  timbre: timbreReport(timbreCatalog, { bankNames }),
  checks,
};
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, 'gate.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log('');
console.log(`Записано: docs/evidence/licenses/gate.json`);

if (!mechanismOk) {
  console.log('');
  console.log('механика реестра: КРАСНЫЙ');
  process.exit(1);
}
console.log(`механика реестра: зелёная (${checks.filter((item) => !item.releaseOnly).length} проверок)`);

if (releaseMode && releaseBlocked) {
  console.log('');
  console.log('ворота публикации: КРАСНЫЕ — решение владельца по лицензиям не принято (D-099)');
  if (timbreAudit.releaseBlocked) {
    console.log(`ассеты каталога без approved: ${timbreAudit.unapprovedAssets.join(', ')}`);
  }
  process.exit(2);
}
if (releaseMode) {
  console.log('ворота публикации: зелёные');
}
