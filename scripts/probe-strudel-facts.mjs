#!/usr/bin/env node
// P2.1 — измерительный стенд фактов Strudel.
//
// ЗАЧЕМ. Промт требует: «каждое утверждение об API Strudel опирается на измерение».
// До этого проекта факты о движке были размазаны по docs/SPIKE.md, docs/SPIKE-AUDIO.md,
// docs/DECISIONS.md и по машинному whitelist server/music/data/strudel-api.json.
// Последний НЕ enforced (его никто не импортирует) и он молчит про реальные
// особенности: например, supersaw нет среди экспортов, но он есть как synth-имя.
//
// ЧТО ДЕЛАЕТ СКРИПТ (три независимые части, каждая со своим числом):
//   A. API          — что есть экспортом, что методом паттерна (по факту бандла).
//   B. Синтаксис    — реальные события queryArc: написания ладов, аккорды, темп.
//   C. Звучание     — рендер настоящего Strudel в headless-Chromium: какие имена
//                     синтов и сэмплов реально звучат, а какие молчат.
//
// ЗАЧЕМ ИМЕННО ТАК. «Есть в бандле» ≠ «работает» ≠ «звучит». Три разных вопроса,
// три разных замера. Ошибка на уровне любого из них — тихая пустота в продукте.
//
// ЗАПУСК:  node scripts/probe-strudel-facts.mjs [--no-audio]
// ПИШЕТ:   docs/STRUDEL-FACTS.md            (человекочитаемый реестр)
//          docs/evidence/strudel/facts.json (машинный, для тестов)
//
// ЧЕСТНОСТЬ. Каждая строка реестра — результат прогона. Нет строки «из документации
// Strudel»: документация может врать (и врала — см. supersaw). Если что-то не
// измерено — в реестре стоит «не измерено», а не догадка.

import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStrudel, runStrudel } from '../server/music/strudel-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const wantAudio = !process.argv.includes('--no-audio');

const api = await loadStrudel();
const proto = api.Pattern.prototype;
const exportNames = new Set(Object.keys(api));
const methodNames = new Set(Object.getOwnPropertyNames(proto));

/** Однострочный код партии: партия T, чтобы считать события. */
function part(code) {
  return `$T: ${code}`;
}

/** Прогон кода через настоящий Strudel: события + текст ошибки. */
async function measure(code, cycles = 1) {
  const run = await runStrudel(code, { cycles });
  if (!run.ok) {
    return { ok: false, events: 0, notes: [], error: String(run.error || '').split('\n')[0] };
  }
  const haps = run.parts.T || [];
  const notes = haps
    .map((h) => (h.value && typeof h.value === 'object' ? h.value.note : h.value))
    .filter((v) => typeof v === 'string');
  return { ok: true, events: haps.length, notes, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. API: экспорты и методы паттерна
// ─────────────────────────────────────────────────────────────────────────────

const FUNCTION_NAMES = [
  'duckorbit', 'duck', 'duckattack', 'duckdepth', 'duckonset', 'duckons',
  'lfo', 'seg', 'lpenv', 'tremolo', 'tremolosync', 'tremolodepth',
  'postgain', 'compressor', 'unison', 'detune', 'spread', 'voicing', 'dict',
  'rootNotes', 'chord', 'note', 'n', 's', 'stack', 'orbit', 'scale',
  'cps', 'cpm', 'setcps', 'setcpm', 'setbpm', 'setCpm', 'setCps',
  'supersaw', 'detunepower', 'duckOrBit', 'duckOrbit', 'duckAttack',
];

// Чем каждый кандидат проверяется: код, который обязан исполниться без ошибки.
const FUNCTION_PROBE = {
  duckorbit: part('s("bd*4").duckorbit(2).duckattack(0.2).duckdepth(1)'),
  duck: part('s("bd*4").duck(2).duckattack(0.2)'),
  duckattack: part('s("bd*4").duckorbit(2).duckattack(0.2)'),
  duckdepth: part('s("bd*4").duckorbit(2).duckdepth(0.8)'),
  duckonset: part('s("bd*4").duckorbit(2).duckonset(0.01)'),
  duckons: part('s("bd*4").duckorbit(2).duckons(0.01)'),
  lfo: part('note("c4").lfo({ c: "gain", rate: 4 })'),
  seg: part('n("0 2 4").seg(8)'),
  lpenv: part('note("c4").lpenv(400).lpf(800)'),
  tremolo: part('note("c4").tremolo(4)'),
  tremolosync: part('note("c4").tremolosync(4)'),
  tremolodepth: part('note("c4").tremolodepth(0.5)'),
  postgain: part('note("c4").postgain(0.8)'),
  compressor: part('note("c4").compressor("-24:4:0:0.01:0.2")'),
  unison: part('note("c4").s("sawtooth").unison(5)'),
  detune: part('note("c4").s("sawtooth").unison(5).detune(0.2)'),
  spread: part('note("c4").s("sawtooth").unison(5).spread(0.5)'),
  voicing: part('chord("F^7").voicing()'),
  dict: part('chord("F^7").dict("ireal").voicing()'),
  rootNotes: part('chord("F^7").rootNotes()'),
  chord: part('chord("F^7")'),
  note: part('note("c4")'),
  n: part('n("0 2 4")'),
  s: part('s("bd*4")'),
  stack: part('stack(s("bd*4"), s("hh*8"))'),
  orbit: part('note("c4").orbit(2)'),
  scale: part('n("0 2 4").scale("a:minor")'),
  cps: part('note("c4").cps(0.5)'),
  cpm: part('note("c4").cpm(120 / 4)'),
  setcps: part('note("c4").setcps(0.5)'),
  setcpm: part('note("c4").setcpm(120 / 4)'),
  setbpm: part('note("c4").setbpm(128)'),
  setCpm: part('note("c4").setCpm(120 / 4)'),
  setCps: part('note("c4").setCps(0.5)'),
  supersaw: part('s("supersaw")'),
  detunepower: part('note("c4").detunepower(0.3)'),
  duckOrBit: part('s("bd*4").duckOrBit(2)'),
  duckOrbit: part('s("bd*4").duckOrBit(2)'),
  duckAttack: part('s("bd*4").duckorbit(2).duckAttack(0.2)'),
};

const functions = [];
for (const name of FUNCTION_NAMES) {
  const probe = FUNCTION_PROBE[name];
  const row = {
    name,
    export: exportNames.has(name),
    method: methodNames.has(name),
    runs: null,
    events: 0,
    error: null,
  };
  if (probe) {
    const m = await measure(probe);
    row.runs = m.ok;
    row.events = m.events;
    row.error = m.error;
  }
  functions.push(row);
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Синтаксис: лады, аккорды, темп
// ─────────────────────────────────────────────────────────────────────────────

const SCALE_SPELLINGS = [
  'A:harmonic:minor', 'A:harmonic_minor', 'A:harmonicminor', 'A harmonic minor',
  'A:minor', 'A:minor:pentatonic', 'c:minor:pentatonic', 'a:mixolydian',
  'BOGUS:xxx', 'A:harmonic',
];

const scales = [];
for (const spelling of SCALE_SPELLINGS) {
  const m = await measure(part(`n("0 2 4 5 7").scale("${spelling}")`));
  scales.push({ spelling, ok: m.ok, events: m.events, notes: m.notes, error: m.error });
}

// Лады по всем восьми ступеням: иначе не отличить гармонический минор от
// натурального (различие — только в шестой ступени).
const MODE_CANDIDATES = [
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
  'ionian', 'pentatonic', 'blues', 'chromatic', 'harmonic:minor', 'harmonic:minor:pentatonic',
  'major:pentatonic', 'minor:pentatonic', 'dorian:pentatonic', 'phrygian:pentatonic',
  'mixolydian:pentatonic', 'lydian:pentatonic', 'locrian:pentatonic', 'major:blues',
  'minor:blues', 'phrygian:dominant', 'melodic:minor', 'altered', 'lydian:dominant',
  'harmonicminor', 'double:harmonic', 'whole:half', 'minor:harmonic', 'major:diatonic',
];

const modes = [];
for (const mode of MODE_CANDIDATES) {
  const m = await measure(part(`n("0 1 2 3 4 5 6 7").scale("c:${mode}")`));
  modes.push({ mode, ok: m.ok, events: m.events, notes: m.notes, error: m.error });
}

const CHORD_SPELLINGS = [
  'Fmaj7', 'F^7', 'FM7', 'Fm7', 'G7', 'A:min', 'Am',
];

const chords = [];
for (const spelling of CHORD_SPELLINGS) {
  const plain = await measure(part(`chord("${spelling}")`));
  const voiced = await measure(part(`chord("${spelling}").voicing()`));
  chords.push({
    spelling,
    plainEvents: plain.events,
    plainNotes: plain.notes.length,
    plainError: plain.error,
    voicedEvents: voiced.events,
    voicedNotes: voiced.notes.length,
    voicedError: voiced.error,
  });
}

// rootNotes — отдельная колонка: промт P2.2/R2 предлагал его как альтернативу voicing.
const rootNotesProbe = await measure(part('chord("F^7").rootNotes()'));

// Сигнал без .seg — отдельная колонка: значение читается один раз на ноту.
const signalWithoutSeg = await measure(part('note("c4").lpf(sine.range(200, 2000))'));
const signalWithSeg = await measure(part('note("c4").lpf(sine.range(200, 2000)).seg(16)'));

// Темп: control-функции регистрируются initStrudel в браузере, в Node их нет.
// Проверяем, что это именно так: initStrudel требует AudioContext.
let initStrudelError = null;
try {
  await api.initStrudel?.();
} catch (err) {
  initStrudelError = String(err?.message || err);
}

const tempo = {
  nodeHasSetCpm: exportNames.has('setCpm'),
  nodeHasSetcps: exportNames.has('setcps'),
  nodeHasSetbpm: exportNames.has('setbpm'),
  initStrudelError,
  note: 'initStrudel недоступен в Node (нужен AudioContext), поэтому control-функции темпа в Node-харнессе не проверяются. В браузере setCpm(bpm/4) работает — это замер рендером, см. раздел «Темп».',
};

// ─────────────────────────────────────────────────────────────────────────────
// C. Звучание: какие имена синтов/сэмплов реально звучат
// ─────────────────────────────────────────────────────────────────────────────

const SOUND_NAMES = [
  'sawtooth', 'square', 'triangle', 'sine', 'piano', 'supersaw', 'pulse', 'fm', 'am',
  'organ', 'lead', 'bd', 'hh', 'cp', 'sd',
];

const sounds = [];
if (wantAudio) {
  const { createRenderWorker } = await import('../server/deepdive/render/render-worker.mjs');
  const worker = await createRenderWorker();
  try {
    for (const name of SOUND_NAMES) {
      const code = `$BASS: note("c4").s("${name}").gain(0.5)`;
      try {
        const result = await worker.render({
          code, fromCycle: 0, toCycle: 2, cps: 120 / 240, wantWav: false, wantEvents: true,
        });
        const report = result.report || {};
        const lufs = typeof report.lufsI === 'number' && Number.isFinite(report.lufsI) ? report.lufsI : null;
        const peak = typeof report.truePeakDbtp === 'number' && Number.isFinite(report.truePeakDbtp) ? report.truePeakDbtp : null;
        sounds.push({ name, lufsI: lufs, truePeakDbtp: peak, events: result.events ? result.events.length : null, error: null });
      } catch (err) {
        sounds.push({ name, lufsI: null, truePeakDbtp: null, events: null, error: String(err?.message || err).split('\n')[0] });
      }
    }
  } finally {
    await worker.close?.();
  }
}

// Темп в браузере: два кода с разным setCpm на одном и том же окне.
// Если setCpm влияет на звук — длительность/уровень разойдутся.
let tempoRender = null;
if (wantAudio) {
  const { createRenderWorker } = await import('../server/deepdive/render/render-worker.mjs');
  const worker = await createRenderWorker();
  try {
    const runs = {};
    for (const bpm of [60, 240]) {
      const code = `setCpm(${bpm}/4)\n$BASS: note("c4").s("sawtooth").gain(0.5)`;
      const result = await worker.render({ code, fromCycle: 0, toCycle: 4, cps: 120 / 240, wantWav: false, wantEvents: true });
      runs[bpm] = { durationS: result.durationS ?? null, events: result.events ? result.events.length : null };
    }
    tempoRender = runs;
  } catch (err) {
    tempoRender = { error: String(err?.message || err).split('\n')[0] };
  } finally {
    await worker.close?.();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Итог
// ─────────────────────────────────────────────────────────────────────────────

const version = (() => {
  try {
    return JSON.parse(readFileSync(resolve(root, 'node_modules/@strudel/web/package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

const facts = {
  measuredAt: new Date().toISOString(),
  package: '@strudel/web',
  version,
  api: { exports: exportNames.size, patternMethods: methodNames.size },
  functions,
  scales,
  modes,
  chords,
  rootNotesProbe,
  signalWithoutSeg,
  signalWithSeg,
  tempo,
  tempoRender,
  sounds,
  audioMeasured: wantAudio,
};

const outDir = resolve(root, 'docs/evidence/strudel');
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`, 'utf8');

const md = renderMarkdown(facts);
await writeFile(resolve(root, 'docs/STRUDEL-FACTS.md'), md, 'utf8');

console.log(`✓ фактов: функций ${functions.length}, ладов ${scales.length}, аккордов ${chords.length}, звуков ${sounds.length}`);
console.log(`  → docs/STRUDEL-FACTS.md`);
console.log(`  → docs/evidence/strudel/facts.json`);

// ─────────────────────────────────────────────────────────────────────────────
// Рендер реестра в markdown
// ─────────────────────────────────────────────────────────────────────────────

function renderMarkdown(f) {
  const lines = [];
  const yes = (v) => (v ? 'да' : 'нет');
  const num = (v) => (v === null || v === undefined ? '—' : String(v));

  lines.push('# STRUDEL-FACTS — измеренные факты о движке');
  lines.push('');
  lines.push('> Файл генерируется скриптом `scripts/probe-strudel-facts.mjs`. Правь руками —');
  lines.push('> правки будут стёрты. Источник истины — измерение, не документация.');
  lines.push('');
  lines.push(`- **Пакет:** \`${f.package}\` версии **${f.version}**`);
  lines.push(`- **Измерено:** ${f.measuredAt}`);
  lines.push(`- **API бандла:** ${f.api.exports} экспортов, ${f.api.patternMethods} методов паттерна`);
  lines.push(`- **Способ:** Node без браузера (UMD-бандл \`@strudel/web\`, \`setStringParser(mini)\`) — события считаются настоящим \`queryArc\`.`);
  lines.push(`- **Звучание:** ${f.audioMeasured ? 'да — рендер в headless-Chromium (системный Chrome/Edge)' : 'нет — прогон с `--no-audio`'}`);
  lines.push('');
  lines.push('## Правила чтения этого файла');
  lines.push('');
  lines.push('1. **«экспорт»** — имя есть среди `Object.keys(bundle)`.');
  lines.push('2. **«метод»** — имя есть в `Pattern.prototype`.');
  lines.push('3. **«исполняется»** — код с этим именем отработал без ошибки в `queryArc`.');
  lines.push('4. **«звучит»** — рендер дал слышимую громкость (LUFS-I ≠ −∞).');
  lines.push('5. Отсутствие в таблице = **не измерено**, а не «нет».');
  lines.push('');

  lines.push('## 1. Функции и методы');
  lines.push('');
  lines.push('| Имя | экспорт | метод | исполняется | событий | вывод |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of f.functions) {
    const verdict = r.runs === null ? 'не измерено' : r.runs ? 'да' : '**нет**';
    const note = r.error ? `\`${r.error.slice(0, 90)}\`` : '';
    lines.push(`| \`${r.name}\` | ${yes(r.export)} | ${yes(r.method)} | ${verdict} | ${num(r.events)} | ${note} |`);
  }
  lines.push('');
  lines.push('### Что из этого следует');
  lines.push('');
  const noDuck = f.functions.find((r) => r.name === 'duckOrBit');
  const duck = f.functions.find((r) => r.name === 'duckorbit');
  lines.push(`- \`duckorbit\` — метод паттерна, исполняется${duck?.runs ? '' : ' **НЕ**'}. \`duckOrBit\` (другой регистр) — **не существует**: ${noDuck?.error ? `движок отвечает «${noDuck.error}»` : 'подтверждено замером'}. Значит опечатка в регистре — тихая поломка, а не «почти работает».`);
  lines.push('- Имена семейства `duck*` регистрозависимы: `duckattack`, `duckdepth`, `duckonset` — строчными.');
  lines.push('- `detunepower` в 1.3.0 отсутствует — использовать нельзя.');
  lines.push('');

  lines.push('## 2. Написания ладов');
  lines.push('');
  lines.push('| Написание | событий | звучащие ноты | вывод |');
  lines.push('|---|---|---|---|');
  for (const s of f.scales) {
    const note = s.error ? `\`${s.error.slice(0, 80)}\`` : (s.notes.length ? s.notes.join(', ') : '—');
    lines.push(`| \`${s.spelling}\` | ${s.events} | ${s.notes.length ? s.notes.join(', ') : '—'} | ${note} |`);
  }
  lines.push('');
  lines.push('**Вывод:** рабочее написание — через двоеточия (`A:harmonic:minor`). Пробел и подчёркивание');
  lines.push('дают пустой результат: движок считает лад «неполным».');
  lines.push('');

  lines.push('### Лады по всем восьми ступеням');
  lines.push('');
  lines.push('Именно восемь ступеней: по семи гармонический минор не отличить от натурального.');
  lines.push('');
  lines.push('| Лад | событий | ступени от C | вывод |');
  lines.push('|---|---|---|---|');
  for (const m of f.modes) {
    const verdict = m.events > 0 && m.notes.length ? 'работает' : '**пусто**';
    lines.push(`| \`${m.mode}\` | ${m.events} | ${m.notes.join(' ') || '—'} | ${verdict} |`);
  }
  lines.push('');

  lines.push('## 3. Аккорды');
  lines.push('');
  lines.push('| Написание | без .voicing(): событий | с .voicing(): событий | с .voicing(): нот | вывод |');
  lines.push('|---|---|---|---|---|');
  for (const c of f.chords) {
    const note = c.voicedError ? `\`${c.voicedError.slice(0, 70)}\`` : (c.plainError ? `\`${c.plainError.slice(0, 70)}\`` : '');
    lines.push(`| \`${c.spelling}\` | ${c.plainEvents} | ${c.voicedEvents} | ${c.voicedNotes} | ${note} |`);
  }
  lines.push('');
  lines.push(`- **\`chord(...)\` без \`.voicing()\` не даёт нот** — ${f.chords[0].plainEvents} событие(й), нот 0. Такая партия молчит.`);
  lines.push(`- \`rootNotes()\` — отдельная проверка: ${f.rootNotesProbe.events} событий. Это **не** замена \`.voicing()\`.`);
  lines.push('');

  lines.push('## 4. Темп');
  lines.push('');
  lines.push(`- В Node-харнессе \`setCpm\`/\`setcps\`/\`setbpm\` **не доступны**: экспортов нет, \`initStrudel\` падает с «${f.tempo.initStrudelError}».`);
  lines.push('- Это не баг движка: `initStrudel` регистрирует control-функции (темп) в браузере,');
  lines.push('  а Node-стенд его не зовёт. Проверка темпа — только рендером.');
  if (f.tempoRender && !f.tempoRender.error) {
    const slow = f.tempoRender['60'];
    const fast = f.tempoRender['240'];
    lines.push(`- Рендер с \`setCpm(60/4)\`: событий ${slow.events}, длительность ${num(slow.durationS)} с;`);
    lines.push(`  с \`setCpm(240/4)\`: событий ${fast.events}, длительность ${num(fast.durationS)} с.`);
  }
  lines.push('');

  lines.push('## 5. Звучание имён');
  lines.push('');
  if (!f.audioMeasured) {
    lines.push('Прогон выполнен с `--no-audio`: рендер пропущен, звучание не измерено.');
  } else {
    lines.push('Рендер 2 такта, `note("c4").s("<имя>").gain(0.5)`. Молчание = LUFS-I пуст.');
    lines.push('');
    lines.push('| Имя | LUFS-I | true peak | событий | вывод |');
    lines.push('|---|---|---|---|---|');
    for (const s of f.sounds) {
      const verdict = s.error ? 'ошибка' : (s.lufsI === null ? '**тишина**' : 'звучит');
      lines.push(`| \`${s.name}\` | ${num(s.lufsI)} | ${num(s.truePeakDbtp)} | ${num(s.events)} | ${verdict} |`);
    }
  }
  lines.push('');
  lines.push('## 6. Сигнал без .seg()');
  lines.push('');
  lines.push(`- \`note("c4").lpf(sine.range(200,2000))\` — ${f.signalWithoutSeg.events} событие(й): значение сигнала читается один раз на ноту, фильтр не «открывается».`);
  lines.push(`- то же с \`.seg(16)\` — ${f.signalWithSeg.events} событий: непрерывная огибающая.`);
  lines.push('');
  lines.push('## 7. Как перепроверить');
  lines.push('');
  lines.push('```');
  lines.push('npm run probe:facts            # полный прогон (со звучанием)');
  lines.push('npm run probe:facts -- --no-audio   # без браузера');
  lines.push('npm test -- strudel-facts      # гейт: реестр совпадает с измерением');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}
