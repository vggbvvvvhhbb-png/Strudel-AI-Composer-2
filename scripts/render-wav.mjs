#!/usr/bin/env node
// Спайк S1: Strudel-код → WAV на диск + отчёт о звучании.
//
// Запуск:
//   node scripts/render-wav.mjs code.js --out twin.wav --bars 16 --bpm 120
//   node scripts/render-wav.mjs code.js --out twin.wav --metrics twin.json
//
// Код берётся из файла (обычно это сгенерированный двойник) или из --code.
// Рендер идёт через настоящий движок Strudel в headless-браузере —
// ровно тот же код, который звучит в студии.
//
// Что печатается: длительность, LUFS-I, true peak, полосы, детерминизм.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';

function parseArgs(argv) {
  const args = { file: null, code: null, out: null, metrics: null, bars: 16, bpm: 120, cps: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--metrics') args.metrics = argv[++i];
    else if (a === '--bars') args.bars = Number(argv[++i]);
    else if (a === '--bpm') args.bpm = Number(argv[++i]);
    else if (a === '--code') args.code = argv[++i];
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'н/д';
  return Number(value).toFixed(digits);
}

const args = parseArgs(process.argv.slice(2));
if (!args.file && !args.code) {
  console.error('Укажите файл с кодом или --code "..."');
  console.error('Пример: node scripts/render-wav.mjs twin.js --out twin.wav --bars 16');
  process.exit(2);
}

const code = args.code ?? (await readFile(args.file, 'utf8'));
// cps здесь — ЦИКЛЫ В СЕКУНДУ (так его ждёт pattern.queryArc({_cps})).
// Один такт = один цикл = 4 доли, поэтому cps = bpm / 4 / 60 = bpm / 240.
// Внимание: в src/audio/render/offline.js в комментарии написано «cps = bpm / 4» —
// это cpm (циклы в минуту), а DEFAULT_CPS = 0.5 при 120 BPM — это cps.
const cps = args.cps ?? args.bpm / 240;

const worker = await createRenderWorker();
try {
  const result = await worker.render({
    code,
    fromCycle: 0,
    toCycle: args.bars,
    cps,
    wantWav: true,
    wantEvents: true,
  });

  const report = result.report || {};
  console.log('=== рендер ===');
  console.log('  такты:            ' + args.bars + ' (cps=' + fmt(cps, 4) + ', bpm=' + args.bpm + ')');
  console.log('  длительность:     ' + fmt(result.durationS, 3) + ' с');
  console.log('  sampleRate:       ' + result.sampleRate + ' Гц');
  console.log('  время рендера:    ' + result.renderMs + ' мс (в браузере), ' + result.wallMs + ' мс (в стенде)');
  console.log('  движок:           ' + (report.engineVersion || 'н/д'));
  console.log('  событий:          ' + (result.events ? result.events.length : 'н/д'));
  console.log('=== звучание ===');
  console.log('  LUFS-I:           ' + fmt(report.lufsI) + ' LU');
  console.log('  true peak:        ' + fmt(report.truePeakDbtp) + ' dBTP');
  console.log('  peak:             ' + fmt(report.peakDbfs) + ' dBFS');
  console.log('  crest:            ' + fmt(report.crestDb) + ' дБ');
  console.log('  clipCount:        ' + (report.clipCount ?? 'н/д'));
  const bands = report.bands || {};
  console.log('  полосы (дБ):      ' + Object.entries(bands).map(([k, v]) => k + '=' + fmt(v)).join(', '));
  console.log('=== паспорт рендера ===');
  console.log('  ' + JSON.stringify(result.fingerprint));

  if (args.out) {
    await writeFile(args.out, result.wav);
    console.log('=== файл ===');
    console.log('  WAV:              ' + path.resolve(args.out) + ' (' + result.wav.length + ' Б)');
  }
  if (args.metrics) {
    await writeFile(
      args.metrics,
      JSON.stringify(
        {
          report,
          fingerprint: result.fingerprint,
          durationS: result.durationS,
          sampleRate: result.sampleRate,
          renderMs: result.renderMs,
          events: result.events,
        },
        null,
        2,
      ),
    );
    console.log('  метрики:          ' + path.resolve(args.metrics));
  }
  if (worker.consoleErrors.length) {
    console.log('=== ошибки консоли браузера ===');
    for (const line of worker.consoleErrors.slice(0, 10)) console.log('  ' + line);
  }
} finally {
  await worker.close();
}
