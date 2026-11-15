#!/usr/bin/env node
// Спайк фазы C: сколько стоит 100 дорожек и что является источником истины.
//
// ЗАЧЕМ. Гайд (§5, §10) требует решение «IR или TrackSpec» с замерами, а не с
// мнением, и ставит порог: если мост IR→студия дороже 5 инженерных дней —
// возвращаемся к «TrackSpec + новая схема идентичности частей».
//
// ЧТО МЕРЯЕМ (всё — числа, не мнения):
//   1. Потолок партий сегодня: IR-схема, TrackSpec-схема, модель студии.
//   2. Слой кода: разбирает ли студия 100 меток вида $P001: (микшер, mute/solo).
//   3. Рендер: держит ли 100 дорожек headless-движок, за сколько и с какой
//      плотностью атак.
//   4. Мост: существует ли конвертер TrackSpec→IR сегодня.
//
// ЗАПУСК: node tests/spike/parts-100.probe.mjs
//
// ЭТО НЕ ТЕСТ. Это измерение для решения D-100.

import { performance } from 'node:perf_hooks';

import { CompositionIRSchema, IR_ROLES } from '../../src/ir/schema.js';
import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';
import { StudioSpecSchema } from '../../src/studio/model.js';
import { parseParts, captureMixer, setPartSolo } from '../../src/core/code-model.js';
import { createRenderWorker } from '../../server/deepdive/render/render-worker.mjs';

const TARGET_PARTS = 100;

const measured = {};

// --- 1. Потолок партий в схемах ------------------------------------------
function trySchema(name, schema, data) {
  const started = performance.now();
  const result = schema.safeParse(data);
  const ms = performance.now() - started;
  const ok = result.success;
  const message = ok ? null : String(result.error?.issues?.[0]?.message ?? result.error?.message ?? '').slice(0, 160);
  console.log(`${name}: ${ok ? 'ПРИНЯТО' : 'ОТКЛОНЕНО'} (${ms.toFixed(2)} мс)${message ? ` — ${message}` : ''}`);
  return { ok, ms, message };
}

// IR: 100 слоёв с разными ключами.
const ir100 = {
  v: 1,
  seed: 1,
  meta: {
    title: '100', bpm: 120, meter: '4/4',
    key: { tonic: 'C', mode: 'minor' },
    mood: { valence: 0, arousal: 0.5 },
  },
  palette: {},
  motifs: {},
  sections: [{
    id: 'a', kind: 'verse', bars: 4, energy: 0.5, tension: 0.5,
    harmony: [{ rn: 'i', bars: 4 }],
    layers: Object.fromEntries(Array.from({ length: TARGET_PARTS }, (_, i) => [
      `p${i + 1}`,
      { plan: 'sustained', density: 0.3, register: [48, 72], weight: 0.2 },
    ])),
  }],
  groove: { template: 'straight', amount: 1 },
  mix: { sidechain: [], pan: {}, orbit: {} },
};
measured.ir100 = trySchema(`IR со 100 слоями`, CompositionIRSchema, ir100);

// TrackSpec: 100 ролей.
const spec100 = {
  meta: { style: 'techno', key: 'c:minor', bpm: 120, seed: 1 },
  sections: [{ name: 'a', kind: 'intro', bars: 4 }],
  parts: {
    roles: Object.fromEntries(Array.from({ length: TARGET_PARTS }, (_, i) => [
      `p${i + 1}`,
      { activeIn: ['a'], pattern: '~ x ~ x ~ x ~ x', sound: 'bd' },
    ])),
  },
};
measured.spec100 = trySchema('TrackSpec со 100 ролями', TrackSpecSchema, spec100);

// Модель студии: спека студии (StudioSpecSchema) — она и проверяет, что все
// роли известны.
const model100 = {
  meta: { style: 'techno', key: 'c:minor', bpm: 120, seed: 1 },
  sections: [{ name: 'a', kind: 'intro', bars: 4 }],
  parts: {
    roles: Object.fromEntries(Array.from({ length: TARGET_PARTS }, (_, i) => [
      `p${i + 1}`,
      { activeIn: ['a'], pattern: '~ x ~ x', sound: 'bd' },
    ])),
  },
};
measured.studioSpec100 = trySchema('StudioSpec студии со 100 частями', StudioSpecSchema, model100);

console.log(`\nРолей в схемах: IR_ROLES = ${IR_ROLES.length}, значит потолок ролей сегодня — ${IR_ROLES.length}.`);

// --- 2. Слой кода: разбирает ли студия 100 меток --------------------------
const code100 = [
  'setCpm(120/4)',
  ...Array.from({ length: TARGET_PARTS }, (_, i) => `$P${String(i + 1).padStart(3, '0')}: s("bd").gain(0.02)`),
].join('\n');
const parsed = parseParts(code100);
const mixerState = captureMixer(code100);
const soloResult = setPartSolo(code100, 'P001', true);
measured.codeLayer = {
  parts: parsed.length,
  labels: parsed.slice(0, 3).map((p) => p.label),
  mixerEntries: mixerState.length,
  soloMutedOthers: (String(soloResult.code).match(/^_/gm) || []).length,
};
console.log(`\nСлой кода: разобрано партий ${parsed.length} из ${TARGET_PARTS}; снимок микшера — ${mixerState.length}; заглушено при solo — ${measured.codeLayer.soloMutedOthers}`);

// --- 3. Рендер 100 дорожек -------------------------------------------------
const worker = await createRenderWorker();
const started = performance.now();
const render = await worker.render({ code: code100, fromCycle: 0, toCycle: 16, wantEvents: true });
const wallMs = performance.now() - started;
await worker.close();

let maxConcurrent = 0;
let onsetsInWindow = 0;
if (Array.isArray(render.events) && render.events.length) {
  // Плотность: сколько атак звучат одновременно (окно 10 мс). Считаем по
  // индексу внутри окна, а не от общего числа событий — иначе получается
  // «все события одновременны».
  const times = render.events
    .filter((e) => e?.hasOnset !== false)
    .map((e) => Number(e?.begin ?? 0))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  let left = 0;
  for (let i = 0; i < times.length; i += 1) {
    while (times[left] < times[i] - 0.01) left += 1;
    const concurrent = i - left + 1;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
  }
  onsetsInWindow = times.length;
}
measured.render = {
  ok: render.ok,
  wallMs: Math.round(wallMs),
  renderMs: render.renderMs,
  durationS: render.durationS,
  events: render.events?.length ?? null,
  onsets: onsetsInWindow,
  maxConcurrentEvents: maxConcurrent,
  lufsI: render.report?.lufsI ?? null,
  truePeak: render.report?.truePeakDbtp ?? null,
  clipCount: render.report?.clipCount ?? null,
  fingerprint: render.fingerprint,
};
console.log(`\nРендер 100 дорожек (16 тактов): ${render.ok ? 'ок' : 'упал'}, wall ${Math.round(wallMs)} мс, движок ${render.renderMs} мс`);
console.log(`  событий: ${render.events?.length ?? '—'}, атак с началом: ${onsetsInWindow}, максимум одновременных: ${maxConcurrent}`);
console.log(`  LUFS-I: ${render.report?.lufsI ?? '—'}, true peak: ${render.report?.truePeakDbtp ?? '—'}, клиппинг: ${render.report?.clipCount ?? '—'}`);

// --- 4. Мост ---------------------------------------------------------------
console.log('\nМост TrackSpec→IR: конвертера в репозитории нет (проверено поиском toIR|fromIR|specToIR|irFromSpec).');
console.log('Мост IR→код есть (src/ir/compiler.js), IR→спека v2 есть (buildSpec в том же файле).');

console.log(`\nИтог измерений:\n${JSON.stringify(measured, null, 2)}`);
