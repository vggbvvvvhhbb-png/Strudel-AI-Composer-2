// Приёмочный сценарий Timbre Palette (D-128):
// «Сделай пианино в первой партии теплее, но сохрани мелодию».
//
//   node scripts/probe-timbre-swap.mjs
//
// Шаги: найти партию → зафиксировать события → резолвер даёт кандидатов →
// подмена instrumentId → компиляция → инвариант событий → прогрев и рендер
// ОБОИХ вариантов тем же движком (headless Chromium) → A/B-метрики → diff.
// Доказательство сохраняется в docs/evidence/timbre/swap-probe.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileTrackSpec } from '../server/music/compiler/index.js';
import { noteToMidi } from '../server/music/notes.js';
import { runStrudel } from '../server/music/strudel-runtime.mjs';
import { resolveTimbre } from '../server/samples/timbre-resolver.js';
import { applyPartEdit } from '../src/music/part-edit.js';
import { decodeWav } from '../src/core/wav.js';
import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const spec = {
  meta: { style: 'lo-fi', bpm: 84, key: 'Amin' },
  structure: {
    sections: [
      { name: 'intro', cycles: 4, energy: 0.4, harmony: 'Amin Fmin' },
      { name: 'verse', cycles: 12, energy: 0.7, harmony: 'Amin Gmin' },
    ],
  },
  parts: {
    roles: {
      PIANO_1: {
        role: 'chords',
        activeIn: ['intro', 'verse'],
        pattern: '0 2 4 6',
        sound: 'piano',
        gainPattern: '0.8 0.5 0.6 ~',
        effects: [{ name: 'room', params: [0.2] }],
      },
      BASS_1: { role: 'bass', activeIn: ['verse'], pattern: '0 ~ 3 ~', sound: 'sine' },
    },
  },
};

const musicalEvents = (events) => events.map((hap) => {
  const value = { ...hap.value };
  delete value.s;
  delete value.sound;
  return { whole: hap.whole, part: hap.part, value };
});

const codeBefore = compileTrackSpec(spec);
const runBefore = await runStrudel(codeBefore, { cycles: 8 });
if (!runBefore.ok) throw new Error(`Базовый код не исполнился: ${runBefore.error}`);
const eventsBefore = runBefore.parts.PIANO_1;

// Диапазон партии — из звучащих событий (MIDI), не из догадки.
// scale() отдаёт note строкой («A3»), числовые паттерны — числом.
const notes = eventsBefore
  .map((hap) => {
    const note = hap.value?.note;
    if (Number.isFinite(note)) return note;
    return noteToMidi(note);
  })
  .filter((note) => Number.isFinite(note));
const range = notes.length ? [Math.min(...notes), Math.max(...notes)] : null;
console.log(`Партия PIANO_1: событий ${eventsBefore.length}, диапазон ${range ? range.join('..') : 'нет данных'}`);

const candidates = resolveTimbre({ role: 'chords', range, profile: 'warm', style: 'lo-fi', limit: 5 });
console.log(`Резолвер: кандидатов ${candidates.length}`);
for (const candidate of candidates) {
  console.log(`  • ${candidate.id} (скор ${candidate.score}): ${candidate.reasons[0] ?? ''}`);
}
if (!candidates.length) throw new Error('Резолвер не дал кандидатов — сценарий не пройден');
const chosen = candidates[0];

const edit = applyPartEdit(spec, { id: 'PIANO_1', op: 'setInstrument', params: { instrumentId: chosen.id } });
if (!edit.ok) throw new Error(`Правка не применилась: ${edit.error}`);
const codeAfter = compileTrackSpec(edit.spec);
const runAfter = await runStrudel(codeAfter, { cycles: 8 });
if (!runAfter.ok) throw new Error(`Код после смены не исполнился: ${runAfter.error}`);

const invariantOk = JSON.stringify(musicalEvents(runAfter.parts.PIANO_1)) === JSON.stringify(musicalEvents(eventsBefore));
console.log(`Инвариант событий (ноты/тайминги/gain): ${invariantOk ? 'СОБЛЮДЁН' : 'НАРУШЕН'}`);
if (!invariantOk) throw new Error('Смена инструмента изменила музыкальные события');

// Рендер обоих вариантов тем же движком: прогрев пресета внутри воркера.
// cps = bpm/240 (setCpm(bpm/4): цикл = 4 доли, D-010).
const worker = await createRenderWorker();
const renderArgs = { fromCycle: 0, toCycle: 8, sampleRate: 48000, cps: 84 / 240 };
const before = await worker.render({ code: codeBefore, ...renderArgs });
const after = await worker.render({ code: codeAfter, ...renderArgs });
await worker.close();

const consoleErrors = worker.consoleErrors ?? [];
const notFound = consoleErrors.filter((line) => /not found/i.test(line));
const lufs = (result) => result.report?.loudness?.lufsI ?? result.report?.lufsI ?? null;

// Первая нота после прогрева: первый не-тихий сэмпл и RMS первых 250 мс.
// Без прогрева superdough грузит файл лениво и первая нота молчит —
// этот замер и есть доказательство «первая нота звучит».
function firstNote(result) {
  if (!result.wav) return null;
  const { channels, sampleRate } = decodeWav(result.wav);
  const mono = channels[0];
  let onset = -1;
  for (let i = 0; i < mono.length; i += 1) {
    if (Math.abs(mono[i]) > 1e-4) { onset = i; break; }
  }
  const windowFrames = Math.min(mono.length, Math.round(sampleRate * 0.25));
  let sum = 0;
  for (let i = 0; i < windowFrames; i += 1) sum += mono[i] * mono[i];
  const rms = windowFrames ? Math.sqrt(sum / windowFrames) : 0;
  return {
    onsetMs: onset >= 0 ? Math.round((onset / sampleRate) * 1000) : null,
    rmsDbfsFirst250ms: rms > 0 ? Number((20 * Math.log10(rms)).toFixed(2)) : null,
  };
}
const firstAfter = firstNote(after);

const evidence = {
  generatedAt: new Date().toISOString(),
  scenario: 'Сделай пианино в первой партии теплее, но сохрани мелодию',
  part: 'PIANO_1',
  range,
  eventsCount: eventsBefore.length,
  candidates: candidates.map((candidate) => ({ id: candidate.id, score: candidate.score, reasons: candidate.reasons })),
  chosen: chosen.id,
  diff: {
    changed: { 'parts.roles.PIANO_1.instrumentId': chosen.id, sound: `piano -> ${chosen.strudelAlias}` },
    unchanged: ['pattern', 'gainPattern', 'effects', 'activeIn', 'structure', 'meta', 'BASS_1'],
  },
  invariantEvents: invariantOk,
  render: {
    before: { wallMs: before.wallMs, renderMs: before.renderMs, lufsI: lufs(before), fingerprint: before.fingerprint },
    after: { wallMs: after.wallMs, renderMs: after.renderMs, lufsI: lufs(after), firstNote: firstAfter, fingerprint: after.fingerprint },
    timbrePresetsInFingerprint: after.fingerprint?.timbre_presets ?? null,
    consoleErrors: consoleErrors.length,
    soundNotFound: notFound.length,
  },
  ok: invariantOk && notFound.length === 0
    && (after.fingerprint?.timbre_presets ?? []).includes(chosen.strudelAlias)
    && firstAfter?.onsetMs !== null && firstAfter.onsetMs <= 500,
};

mkdirSync(path.join(root, 'docs/evidence/timbre'), { recursive: true });
writeFileSync(path.join(root, 'docs/evidence/timbre/swap-probe.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log('');
console.log(`Рендер до: ${before.wallMs} мс стены, LUFS ${lufs(before) ?? 'нет данных'}`);
console.log(`Рендер после: ${after.wallMs} мс стены, LUFS ${lufs(after) ?? 'нет данных'}`);
console.log(`Первая нота после прогрева: onset ${firstAfter?.onsetMs ?? 'нет данных'} мс, RMS первых 250 мс ${firstAfter?.rmsDbfsFirst250ms ?? 'нет данных'} dBFS`);
console.log(`Пресеты в fingerprint: ${JSON.stringify(after.fingerprint?.timbre_presets ?? null)}`);
console.log(`Ошибок «sound not found»: ${notFound.length}`);
console.log(`ИТОГ: ${evidence.ok ? 'СЦЕНАРИЙ ПРОЙДЕН' : 'СЦЕНАРИЙ НЕ ПРОЙДЕН'}`);
console.log('Доказательство: docs/evidence/timbre/swap-probe.json');
process.exit(evidence.ok ? 0 : 1);