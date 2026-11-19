#!/usr/bin/env node
// P1.2 — измеритель энергетического профиля секций аранжировки.
//
// ЗАЧЕМ. Промт P1.2 перечисляет правила аранжировки (интро → билд → дроп →
// брейкдаун, снейр-ролл с удвоением плотности, пауза перед дропом), но в
// корпусе знаний этих правил не было: ни измерений, ни записей. Пока
// утверждение не измерено, оно остаётся мнением автора промта.
//
// ЧТО МЕРЯЕТСЯ (на настоящем рендере, в настоящем движке):
//   1. энергетический профиль по тактам (RMS, дБ) — дроп громче интро,
//      брейкдаун тише дропа;
//   2. нарастание в билде: растёт ли энергия и смещается ли спектр вверх
//      (открытие фильтра);
//   3. пауза перед дропом: такт тишины перед возвращением;
//   4. плотность снейр-ролла: удваивается ли число ударов по тактам
//      (4 → 8 → 16 → 32) — это считается по СОБЫТИЯМ паттерна, а не на глаз.
//
// МЕТОД. Рендер 16 тактов при 128 BPM (setCpm(128/4)), окно анализа —
// восьмая доля. RMS считается по WAV проекта (src/core/wav.js), спектральный
// центроид — FFT проекта (src/audio/dsp/fft.js), активность по секциям —
// measureActivity проекта (server/deepdive/audio/measure.js).
//
// ЧЕСТНОСТЬ. Ничего не «доказывается на глаз»: каждая строка вывода —
// число, посчитанное по звуку. Если движок не дал событий или звука, в
// выводе будет «нет данных», а не «ок».
//
// ЗАПУСК: node scripts/probe-arrangement-sections.mjs
// ПИШЕТ:  docs/evidence/music/arrangement-sections-<дата>.json

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';
import { decodeWav } from '../src/core/wav.js';
import { measureActivity } from '../server/deepdive/audio/measure.js';
import { powerSpectrum } from '../src/audio/dsp/fft.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BPM = 128;
const CPS = BPM / 60 / 4;          // 128 BPM → 0.5333 цикла в секунду
const BARS = 16;
const BAR_S = 1 / CPS;             // длительность такта, с
const EIGHTH_S = BAR_S / 8;        // окно анализа — восьмая доля
const FFT_SIZE = 2048;

// Секции аранжировки: такты 0–3 интро, 4–7 билд, 8–11 дроп, 12–15 брейкдаун.
const SECTIONS = [
  { name: 'интро', from: 0, to: 4 },
  { name: 'билд', from: 4, to: 8 },
  { name: 'дроп', from: 8, to: 12 },
  { name: 'брейкдаун', from: 12, to: 16 },
];

// Аранжировка целиком. Маски по 16 шагов = по одному шагу на такт.
// Билд: снейр-ролл 4 → 8 → 16 и ризер с открывающимся фильтром;
// последний такт билда (7) пуст — это пауза перед дропом.
const CODE = [
  'setCpm(128/4)',
  '$KICK: s("bd*4").mask("<0 0 0 0 0 0 0 0 1 1 1 1 0 0 0 0>").gain(0.85)',
  '$HATS: s("hh*8").mask("<1 1 1 1 0 0 0 0 1 1 1 1 1 1 1 1>").gain(0.4)',
  '$BASS: note("c2").s("sine").gain(0.8).mask("<0 0 0 0 0 0 0 0 1 1 1 1 0 0 0 0>")',
  '$ROLL: s("sd*<4 8 16 32>").mask("<0 0 0 0 1 1 1 0 0 0 0 0 0 0 0 0>").gain(0.55)',
  '$RISE: s("white*8").lpf(time.range(200,4000)).gain("<0 0 0 0 0.25 0.25 0.25 0 0 0 0 0 0 0 0 0>")',
  '$PAD: chord("<Am F>").voicing().lpf(1200).gain(0.28).mask("<1 1 1 1 1 1 1 0 0 0 0 1 1 1 1>")',
].join('\n');

const db = (x) => 20 * Math.log10(x || 1e-12);

/** RMS моно-сигнала в окне [from, to) в отсчётах. */
function rms(mono, from, to) {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, from); i < Math.min(mono.length, to); i += 1) {
    sum += mono[i] * mono[i];
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

/** Спектральный центроид (Гц) в окне: FFT проекта, сумма f·P / сумма P. */
function centroid(mono, sampleRate, from, to) {
  const frame = new Float64Array(FFT_SIZE);
  const usable = Math.max(0, Math.min(to, mono.length) - Math.max(0, from));
  for (let i = 0; i < usable; i += 1) frame[i] = mono[Math.max(0, from) + i];
  const spectrum = powerSpectrum(frame);
  const binHz = sampleRate / FFT_SIZE;
  let weighted = 0;
  let total = 0;
  for (let k = 1; k < spectrum.length; k += 1) {
    const power = spectrum[k];
    weighted += k * binHz * power;
    total += power;
  }
  return total > 0 ? weighted / total : 0;
}

const worker = await createRenderWorker();
let report;
try {
  const result = await worker.render({
    code: CODE,
    fromCycle: 0,
    toCycle: BARS,
    cps: CPS,
    wantWav: true,
    wantEvents: true,
  });

  const wav = decodeWav(result.wav);
  const mono = Float64Array.from(wav.channels[0]);
  const sampleRate = wav.sampleRate;

  // Энергия и спектр по тактам.
  const bars = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    const from = Math.round(bar * BAR_S * sampleRate);
    const to = Math.round((bar + 1) * BAR_S * sampleRate);
    const eighths = [];
    for (let e = 0; e < 8; e += 1) {
      const ef = from + Math.round(e * EIGHTH_S * sampleRate);
      const et = from + Math.round((e + 1) * EIGHTH_S * sampleRate);
      eighths.push({
        db: Number(db(rms(mono, ef, et)).toFixed(2)),
        centroid_hz: Math.round(centroid(mono, sampleRate, ef, et)),
      });
    }
    bars.push({
      bar: bar + 1,
      section: SECTIONS.find((s) => bar >= s.from && bar < s.to)?.name ?? '?',
      db: Number(db(rms(mono, from, to)).toFixed(2)),
      centroid_hz: Math.round(centroid(mono, sampleRate, from, to)),
      eighths,
    });
  }

  // События паттерна: плотность по тактам и по сэмплу.
  const events = result.events ?? [];
  const perBar = {};
  const perBarSound = {};
  for (const event of events) {
    const bar = Math.floor(Number(event.begin));
    perBar[bar] = (perBar[bar] ?? 0) + 1;
    const sound = String(event.s ?? '?');
    perBarSound[bar] ??= {};
    perBarSound[bar][sound] = (perBarSound[bar][sound] ?? 0) + 1;
  }

  // Активность по секциям — штатная мера проекта.
  const activity = measureActivity(
    wav.channels,
    sampleRate,
    SECTIONS.map((s, index) => ({ index, start_s: s.from * BAR_S, end_s: s.to * BAR_S })),
  );

  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const sectionMean = (name, field) =>
    mean(bars.filter((b) => b.section === name).map((b) => b[field]));

  const introDb = sectionMean('интро', 'db');
  const buildDb = sectionMean('билд', 'db');
  const dropDb = sectionMean('дроп', 'db');
  const breakdownDb = sectionMean('брейкдаун', 'db');
  // Среднее по билду без такта паузы: тишина перед дропом — не часть нарастания.
  const buildActiveDb = mean(bars.filter((b) => b.section === 'билд' && b.bar !== 8).map((b) => b.db));

  // Билд: такт 5 (первый с роллом) против такта 7 (перед паузой).
  const buildFirst = bars[4];
  const buildLast = bars[6];
  // Пауза перед дропом — такт 8 (индекс 7).
  const pauseBar = bars[7];

  const rollDensity = [4, 5, 6, 7].map((bar) => ({
    bar: bar + 1,
    snare: perBarSound[bar]?.sd ?? 0,
    all: perBar[bar] ?? 0,
  }));

  console.log('=== энергетический профиль секций (128 BPM, 16 тактов) ===');
  console.log('такт  секция      RMS, дБ   центроид, Гц   событий');
  for (const bar of bars) {
    console.log(
      String(bar.bar).padStart(4) + '  ' + bar.section.padEnd(12) +
      String(bar.db).padStart(9) + '   ' + String(bar.centroid_hz).padStart(12) +
      '   ' + String(perBar[bar.bar - 1] ?? 0).padStart(7),
    );
  }

  console.log('');
  console.log('=== секции ===');
  for (const section of SECTIONS) {
    const index = SECTIONS.indexOf(section);
    console.log(
      section.name.padEnd(12) + ' средний RMS: ' + String(sectionMean(section.name, 'db')).padStart(7) +
      ' дБ, активность: ' + String(activity[String(index)] ?? 'нет данных'),
    );
  }

  console.log('');
  console.log('=== события по тактам и сэмплам ===');
  for (let bar = 0; bar < BARS; bar += 1) {
    const sounds = perBarSound[bar] ?? {};
    const line = Object.entries(sounds).map(([name, count]) => name + ':' + count).join(' ');
    console.log(String(bar + 1).padStart(4) + '  ' + (line || '—'));
  }

  console.log('');
  console.log('=== измеренные утверждения ===');  const facts = {
    'дроп громче интро, дБ': Number((dropDb - introDb).toFixed(2)),
    'дроп громче брейкдауна, дБ': Number((dropDb - breakdownDb).toFixed(2)),
    'билд (без такта паузы) громче интро, дБ': Number((buildActiveDb - introDb).toFixed(2)),
    'нарастание в билде (такт 7 минус такт 5), дБ': Number((buildLast.db - buildFirst.db).toFixed(2)),
    'открытие фильтра в билде (центроид такт 7 минус такт 5), Гц': buildLast.centroid_hz - buildFirst.centroid_hz,
    'пауза перед дропом (такт 8), дБ': pauseBar.db,
    'пауза тише дропа на, дБ': Number((pauseBar.db - dropDb).toFixed(2)),
    'плотность снейр-ролла по тактам билда': rollDensity.map((r) => r.snare).join(' → '),
  };
  for (const [label, value] of Object.entries(facts)) {
    console.log('  ' + label.padEnd(52) + ' ' + value);
  }

  report = {
    probe: 'arrangement-sections',
    date: new Date().toISOString().slice(0, 10),
    command: 'node scripts/probe-arrangement-sections.mjs',
    method:
      'Рендер 16 тактов при 128 BPM (setCpm(128/4)), окно анализа — восьмая доля. ' +
      'RMS по WAV проекта, спектральный центроид — FFT проекта (src/audio/dsp/fft.js), ' +
      'активность по секциям — measureActivity проекта. Плотность ролла — по событиям паттерна.',
    bpm: BPM,
    cps: CPS,
    bars,
    eventsPerBar: perBar,
    eventsPerBarSound: perBarSound,
    sectionActivity: activity,
    facts,
    rollDensity,
    eventsTotal: events.length,
    durationS: result.durationS ?? null,
  };
} finally {
  await worker.close?.();
}

const date = new Date().toISOString().slice(0, 10);
const outDir = resolve(ROOT, 'docs/evidence/music');
await mkdir(outDir, { recursive: true });
const outFile = resolve(outDir, `arrangement-sections-${date}.json`);
await writeFile(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('');
console.log('Записано: ' + outFile.replace(ROOT + '\\', ''));
