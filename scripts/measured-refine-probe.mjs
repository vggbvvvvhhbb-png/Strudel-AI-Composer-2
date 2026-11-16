#!/usr/bin/env node
// Измерительный рефайн на настоящем звуке: замер до/после (D-111).
//
// Запуск: node scripts/measured-refine-probe.mjs
// Пишет: docs/evidence/refine/compose-refine.json
//
// ЧТО ДЕЛАЕТ. Берёт планы из библиотеки, рендерит их настоящим движком
// (headless-Chromium + Strudel), меряет (громкость, пик, клиппинг,
// музыкальный разбор), прогоняет цикл правок и пишет числа до/после.
//
// ДВА СЛУЧАЯ, потому что они разные по существу:
//   1. ambient — трек тише коридора: одно правило (R2) доводит его до нормы;
//   2. techno  — трек, который обрезается в PCM: правила улучшают звук
//      измеримо, но до нормы не доводят (см. ограничение в D-111).
//
// Рендер требует браузера: если Chromium не найден, скрипт пишет честное
// «нет данных» и выходит с кодом 2 — подделывать измерение нельзя.

import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fallbackSpec } from '../server/music/compose/pipeline.js';
import { compileTrackSpec } from '../server/music/compiler/index.js';
import { refineComposed } from '../server/music/compose/measured-refine.js';
import { serverRender, serverMeasure } from '../server/music/compose/measured-session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * Случай «тише коридора»: тема сама по себе не проходит приёмку по
 * громкости — правило R2 поднимает её на шаг ≤ 1 дБ.
 */
function ambientSpec() {
  return fallbackSpec('ambient', 2);
}

/**
 * Случай «обрезается»: у библиотечного плотного трека crest ≈ 19.7 дБ,
 * поэтому потолок пика и коридор LUFS недостижимы общей регулировкой.
 * Правила всё равно улучшают звук измеримо — и это тоже результат.
 */
function clippingSpec() {
  const spec = fallbackSpec('techno', 3);
  for (const part of Object.values(spec.parts.roles)) {
    part.effects = (part.effects ?? []).filter((effect) => effect.name !== 'gain');
    part.effects.push({ name: 'gain', params: [1.6] });
    if (!part.activeIn.length) part.activeIn = ['intro'];
  }
  return spec;
}

async function runCase(name, spec, maxIterations) {
  const code = compileTrackSpec(spec);
  const events = [];
  const result = await refineComposed({
    spec,
    code,
    seed: 3,
    render: serverRender,
    measure: serverMeasure,
    maxIterations,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  return {
    name,
    before: result.before,
    after: result.after,
    deltas: result.deltas,
    iterations: result.iterations,
    stoppedBy: result.stoppedBy,
    coverage: result.coverage,
    soundChanged: result.soundChanged,
    fingerprintBefore: result.fingerprintBefore,
    fingerprintAfter: result.fingerprintAfter,
    events: events.map((event) => event.type),
  };
}

async function main() {
  const cases = [];
  cases.push(await runCase('ambient: тише коридора, правило R2 доводит до нормы', ambientSpec(), 4));
  cases.push(await runCase('techno: микс обрезается, правила улучшают измеримо', clippingSpec(), 6));

  const report = {
    checkedAt: new Date().toISOString(),
    what: 'измерительный рефайн поверх compose (D-111): рендер → замер → правка → рендер → замер',
    engine: 'headless Chromium + Strudel (тот же движок, что и в студии)',
    note: 'ключи и тела запросов не пишутся; только числа замера',
    cases,
  };

  const outDir = path.join(ROOT, 'docs', 'evidence', 'refine');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'compose-refine.json');
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('=== измерительный рефайн ===');
  for (const item of cases) {
    console.log(`  ${item.name}`);
    console.log(`    до:    L0=${item.before.l0} L1=${item.before.l1} пик=${item.before.truePeakDbtp?.toFixed(2)} LUFS=${item.before.lufsI?.toFixed(2)} clip=${item.before.clipCount}`);
    console.log(`    после: L0=${item.after.l0} L1=${item.after.l1} пик=${item.after.truePeakDbtp?.toFixed(2)} LUFS=${item.after.lufsI?.toFixed(2)} clip=${item.after.clipCount}`);
    console.log(`    итераций: ${item.iterations.length}, стоп: ${item.stoppedBy}, звук изменился: ${item.soundChanged}`);
  }
  console.log('  отчёт:', path.relative(ROOT, outFile));
}

main().catch((error) => {
  const reason = error?.message || String(error);
  console.error('✗ измерительный рефайн не выполнен:', reason);
  console.error('нет данных: ' + reason
    + ' · что нужно: браузер (CHROME_PATH) и node_modules/@strudel/web · где готов скрипт: scripts/measured-refine-probe.mjs');
  const outDir = path.join(ROOT, 'docs', 'evidence', 'refine');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, 'compose-refine.json'),
    `${JSON.stringify({ checkedAt: new Date().toISOString(), error: reason, measured: false }, null, 2)}\n`,
    'utf8',
  );
  process.exit(2);
});
