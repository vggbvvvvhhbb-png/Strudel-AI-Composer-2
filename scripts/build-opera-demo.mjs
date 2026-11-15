#!/usr/bin/env node
// Демо-опера фазы C: план -> детерминированная экспансия -> рендер -> замер.
//
// Что измеряется (а не предполагается):
//   • сколько дорожек развернулось из плана;
//   • уложилась ли группа в бюджет атак на такт;
//   • true peak, LUFS-I и клиппинг готового микса (гейт L0);
//   • сколько времени занял рендер локально.
//
// ЗАПУСК: node scripts/build-opera-demo.mjs [--bars 32] [--no-render]

import { performance } from 'node:perf_hooks';

import { specFromPlan, expandPlan } from '../src/music/expand.js';
import { compileTrackSpec } from '../server/music/compiler/index.js';
import { validateTrackSpec } from '../src/schemas/track-spec.schema.js';
import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';

const args = process.argv.slice(2);
const barArg = args.indexOf('--bars');
const bars = barArg === -1 ? 32 : Number(args[barArg + 1]);
const doRender = !args.includes('--no-render');

// План оперы: верхние уровни, как их писала бы модель.
const plan = {
  style: 'cinematic',
  key: 'Cmin',
  bpm: 90,
  sections: [
    { name: 'intro', bars: Math.round(bars * 0.25), energy: 0.35, harmony: 'Cm' },
    { name: 'verse', bars: Math.round(bars * 0.25), energy: 0.55, harmony: 'Cm Ab' },
    { name: 'drop', bars: Math.round(bars * 0.5), energy: 0.9, harmony: 'Cm Gm Ab Bb' },
  ],
  groups: [
    { group: 'strings', role: 'violin', count: 10 },
    { group: 'strings', role: 'viola', count: 4 },
    { group: 'strings', role: 'cello', count: 4 },
    { group: 'brass', role: 'horn', count: 4 },
    { group: 'brass', role: 'trumpet', count: 2 },
    { group: 'woodwinds', role: 'flute', count: 4 },
    { group: 'woodwinds', role: 'clarinet', count: 2 },
    { group: 'keys', role: 'piano', count: 4 },
    { group: 'keys', role: 'harp', count: 2 },
    { group: 'choir', role: 'choir_soprano', count: 4 },
    { group: 'choir', role: 'choir_bass', count: 2 },
    { group: 'choir', role: 'choir_alto', count: 4 },
    { group: 'pads', role: 'pad', count: 4 },
    { group: 'bass', role: 'bass', count: 2 },
    { group: 'perc', role: 'perc', count: 8 },
    { group: 'drums', role: 'kick', count: 1 },
    { group: 'drums', role: 'hats', count: 1 },
    { group: 'lead', role: 'lead', count: 2 },
    { group: 'fx', role: 'fx', count: 2 },
  ],
};

const { spec: rawSpec, report } = specFromPlan(plan);
const spec = validateTrackSpec(rawSpec);
const code = compileTrackSpec(spec);
const labels = code.split('\n').filter((line) => /^\$[A-Z][A-Z0-9_]*:/.test(line));

console.log('=== Демо-опера (фаза C) ===');
console.log(`Дорожек: ${Object.keys(spec.parts.roles).length} (меток в коде: ${labels.length})`);
console.log(`Секций: ${spec.structure.sections.map((s) => `${s.name}(${s.cycles})`).join(' → ')}`);
console.log(`Бюджет полифонии: ${report.budgetOk ? 'соблюдён' : 'НАРУШЕН'} (нарушения: ${report.budgetViolations.length})`);
console.log(`Атак на такт суммарно: ${report.totalAttacksPerBar}`);
console.table(report.groups.map((item) => ({
  группа: item.group,
  голосов: item.voices,
  'атак/такт': item.attacksPerBar,
  'бюджет/голос': item.perVoiceBudget,
})));

if (args.includes('--dump')) {
  console.log('\n--- код ---');
  console.log(code.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n'));
}

if (!doRender) {
  console.log('\n--no-render: рендер пропущен.');
  process.exit(0);
}

const worker = await createRenderWorker();
const started = performance.now();
const render = await worker.render({ code, fromCycle: 0, toCycle: bars, wantEvents: true });
const wallMs = performance.now() - started;
await worker.close();

const report2 = render.report ?? {};
const lufs = report2.lufsI ?? null;
const peak = report2.truePeakDbtp ?? null;
const clips = report2.clipCount ?? null;

console.log('\n=== Рендер и гейт L0 ===');
console.log(`Рендер: ${render.ok ? 'ок' : 'упал'}, wall ${(wallMs / 1000).toFixed(1)} с, движок ${((render.renderMs ?? 0) / 1000).toFixed(1)} с, звука ${render.durationS ?? '—'} с`);
console.log(`Событий: ${render.events?.length ?? '—'}`);
console.log(`LUFS-I: ${lufs === null ? '—' : lufs.toFixed(2)} (коридор -16…-12, как в src/audio/metrics-report.js)`);
console.log(`True peak: ${peak === null ? '—' : peak.toFixed(2)} dBTP (потолок ≤ -1)`);
console.log(`Клиппинг: ${clips ?? '—'} отсчётов`);

const lufsOk = lufs !== null && lufs >= -16 && lufs <= -12;
const peakOk = peak !== null && peak <= -1;
const clipOk = clips === null || clips === 0;
console.log(`\nГейт L0: громкость ${lufsOk ? 'зелёная' : 'КРАСНАЯ'}, потолок ${peakOk ? 'зелёный' : 'КРАСНЫЙ'}, клиппинг ${clipOk ? 'зелёный' : 'КРАСНЫЙ'}`);
console.log(`Гейт C (дорожек ≥ 64): ${Object.keys(spec.parts.roles).length >= 64 ? 'зелёный' : 'КРАСНЫЙ'}`);

process.exit(lufsOk && peakOk && clipOk ? 0 : 1);
