#!/usr/bin/env node
// Единый ворота проекта: одна команда вместо десяти.
//
// ЗАЧЕМ. Проверки жили в разных местах: в pre-commit был только check:secrets,
// остальные гонялись вручную или в CI отдельными джобами. Из-за этого
// «зелёный репозиторий» означал «зелёные тесты», а не «проект собирается
// и проходит все ворота». Теперь gate — это полный набор: без него
// считать состояние проекта нельзя.
//
// ЧТО ВХОДИТ (по порядку, от дешёвого к дорогому):
//   lint             синтаксис всех исходников
//   check:secrets    ключи и токены не в репозитории
//   check:presets    пресеты разбираются движком
//   check:knowledge   библиотека знаний целостна
//   check:skills     карточки навыков не разрослись
//   check:baseline   базовый корпус не поехал
//   check:prompts    пул промтов свежий
//   check:taste      механика обучения цела
//   check:licenses   реестр лицензий полон (механика)
//   licenses:pool    раздел лицензий пула «Охотника» актуален (D-115)
//   test             все тесты
//   build            продакшен-сборка
//   bundle:budget    бюджет бандла
//   gate:a           гейт фазы A: агент проходит запрос гайда (нужен браузер)
//
// ОПЦИЯ --release. Добавляет check:licenses --release — ворота публикации.
// Сейчас они красные: два банка сэмплов без подтверждённой лицензии ждут
// решения владельца (D-099). Это НЕ сбой механики, а сознательный блок.
//
// Запуск: npm run gate   ·   npm run gate -- --release

import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
// Команда собирается строкой: на Windows npm — это npm.cmd, и без shell его
// не запустить, а передавать массив аргументов вместе с shell нельзя
// (Node предупреждает DEP0190: аргументы не экранируются). Все команды
// берутся из фиксированного списка выше — подстановки пользователя тут нет.
const NPM = isWindows ? 'npm.cmd' : 'npm';

const STEPS = [
  { name: 'lint', cmd: 'lint', why: 'синтаксис всех исходников' },
  { name: 'check:secrets', cmd: 'check:secrets', why: 'ключи не в репозитории' },
  { name: 'check:presets', cmd: 'check:presets', why: 'пресеты разбираются движком' },
  { name: 'check:knowledge', cmd: 'check:knowledge', why: 'библиотека знаний целостна' },
  { name: 'check:skills', cmd: 'check:skills', why: 'карточки навыков не разрослись' },
  { name: 'check:baseline', cmd: 'check:baseline', why: 'базовый корпус не поехал' },
  { name: 'check:prompts', cmd: 'check:prompts', why: 'пул промтов свежий' },
  { name: 'check:taste', cmd: 'check:taste', why: 'механика обучения цела' },
  { name: 'check:licenses', cmd: 'check:licenses', why: 'реестр лицензий полон' },
  { name: 'licenses:pool', cmd: 'licenses:pool -- --check', why: 'раздел лицензий пула актуален' },
  { name: 'test', cmd: 'test', why: 'все тесты' },
  { name: 'build', cmd: 'build', why: 'продакшен-сборка' },
  { name: 'bundle:budget', cmd: 'bundle:budget', why: 'бюджет бандла' },
  { name: 'gate:a', cmd: 'gate:a', why: 'гейт A: помощник-агент проходит запрос гайда' },
];

const RELEASE_STEPS = [
  { name: 'check:release', cmd: 'check:release', why: 'ворота публикации (лицензии)' },
];

const wantRelease = process.argv.slice(2).includes('--release');
const steps = wantRelease ? [...STEPS, ...RELEASE_STEPS] : STEPS;

const results = [];
let failed = false;

for (const step of steps) {
  const started = Date.now();
  process.stdout.write(`\n=== ${step.name} — ${step.why} ===\n`);
  const res = spawnSync(`${NPM} run ${step.cmd}`, {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  const code = res.status === null ? 1 : res.status;
  const ms = Date.now() - started;
  results.push({ ...step, code, ms });
  if (code !== 0) {
    failed = true;
    // Остальные шаги не имеют смысла: сборка после упавших тестов —
    // это шум, а не диагностика.
    break;
  }
}

const totalMs = results.reduce((acc, r) => acc + r.ms, 0);
console.log('\n=== ИТОГ ВОРОТ ===');
for (const r of results) {
  console.log(`  ${r.code === 0 ? '✓' : '✗'} ${r.name.padEnd(18)} ${(r.ms / 1000).toFixed(1)} с`);
}
const notRun = steps.length - results.length;
if (notRun > 0) {
  console.log(`  … не выполнено: ${notRun} шаг(ов) — остановились на первом провале.`);
}
console.log(`  всего: ${(totalMs / 1000).toFixed(1)} с`);

if (failed) {
  console.log('\nВОРОТА КРАСНЫЕ. Пройденный шаг не делает остальные зелёными.');
  process.exit(1);
}
console.log('\nВОРОТА ЗЕЛЁНЫЕ.');
if (!wantRelease) {
  console.log('Публикационные ворота (--release) не проверялись: решение владельца по лицензиям открыто (D-099).');
}
