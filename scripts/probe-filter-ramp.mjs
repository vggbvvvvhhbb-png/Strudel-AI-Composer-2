#!/usr/bin/env node
// P1.5 — измеритель фильтровых нарастаний (открытие фильтра).
//
// ЗАЧЕМ. Фаза P2 измерила, что сигнал в фильтре без .seg() даёт ОДНО
// значение на ноту (1 событие против 16 с .seg(16)) — это факт о СОБЫТИЯХ.
// Но P1.5 требует «фильтровые нарастания в билде», и в корпусе знаний таких
// измерений не было. Событие — не звук: нужно померить, что срез фильтра
// действительно ползёт вверх по времени.
//
// ЧТО МЕРЯЕТСЯ. Для каждого варианта — спектральный центроид (Гц) в окнах по
// 1/8 и энергия верхней полосы (4–16 кГц):
//   A. статичный фильтр      .lpf(800)                  — эталон «ровно»;
//   B. сигнал без .seg()     .lpf(sine.range(200,4000)) — значение один раз
//                                                               на ноту;
//   C. сигнал с .seg(16)     .lpf(sine.range(200,4000).seg(16)) — непрерывно;
//   D. ризер билда           s("white*8").lpf(sine.range(200,4000).seg(16))
//                                                            — то, что стоит
//                                                              в аранжировке.
//
// МЕТРИКИ. «Открытие фильтра» — рост центроида и рост энергии верхней полосы
// от начала такта к концу. Для варианта B дополнительно считается, сколько
// раз центроид меняется внутри такта: если значение берётся один раз на
// ноту, внутри ноты центроид стоит, а меняется только на атаках.
//
// ЗАПУСК: node scripts/probe-filter-ramp.mjs
// ПИШЕТ:  docs/evidence/music/filter-ramp-<дата>.json

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';
import { decodeWav } from '../src/core/wav.js';
import { powerSpectrum } from '../src/audio/dsp/fft.js';
import { loadStrudel, runStrudel } from '../server/music/strudel-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BPM = 128;
const CPS = BPM / 60 / 4;
const BARS = 4;
const BAR_S = 1 / CPS;
const EIGHTH_S = BAR_S / 8;
const FFT_SIZE = 2048;
const HIGH_FROM_HZ = 4000;

const CASES = [
  {
    label: 'A. статичный фильтр .lpf(800)',
    code: '$T: note("c2").s("sawtooth").lpf(800).gain(0.5)',
    expectation: 'центроид ровный, верхняя полоса не растёт',
  },
  {
    label: 'B. быстрый сигнал без .seg() — sine.range(200,4000)',
    code: '$T: note("c2*4").s("sawtooth").lpf(sine.range(200,4000)).gain(0.5)',
    expectation: 'значение один раз на ноту; при быстром сигнале — колебание среза',
  },
  {
    label: 'C. быстрый сигнал с .seg(16) — sine.range(200,4000).seg(16)',
    code: '$T: note("c2").s("sawtooth").lpf(sine.range(200,4000).seg(16)).gain(0.5)',
    expectation: '16 сегментов, но синус идёт вверх И обратно — не монотонный рамп',
  },
  {
    label: 'D. медленный сигнал — sine.slow(8).range(200,4000).seg(16)',
    code: '$T: note("c2").s("sawtooth").lpf(sine.slow(8).range(200,4000).seg(16)).gain(0.5)',
    expectation: 'медленное колебание: внутри окна выглядит как рамп',
  },
  {
    label: 'E. настоящий рамп — time.range(200,4000)',
    code: '$T: note("c2").s("sawtooth").lpf(time.range(200,4000)).gain(0.5)',
    expectation: 'монотонный подъём среза внутри ноты',
  },
  {
    label: 'F. настоящий рамп по сегментам — time.range(200,4000).seg(16)',
    code: '$T: note("c2").s("sawtooth").lpf(time.range(200,4000).seg(16)).gain(0.5)',
    expectation: 'монотонный подъём среза внутри ноты',
  },
  {
    label: 'G. ризер билда: белый шум + time.range(200,4000)',
    code: '$T: s("white*8").lpf(time.range(200,4000)).gain(0.4)',
    expectation: 'рост верхней полосы от такта к такту',
  },
];

const db = (x) => 20 * Math.log10(x || 1e-12);

/** Спектральный центроид (Гц) и энергия верхней полосы в окне. */
function spectrum(mono, sampleRate, from, to) {
  const frame = new Float64Array(FFT_SIZE);
  const start = Math.max(0, from);
  const usable = Math.max(0, Math.min(to, mono.length) - start);
  for (let i = 0; i < usable; i += 1) frame[i] = mono[start + i];
  const power = powerSpectrum(frame);
  const binHz = sampleRate / FFT_SIZE;
  let weighted = 0;
  let total = 0;
  let high = 0;
  for (let k = 1; k < power.length; k += 1) {
    const hz = k * binHz;
    weighted += hz * power[k];
    total += power[k];
    if (hz >= HIGH_FROM_HZ) high += power[k];
  }
  return {
    centroid_hz: total > 0 ? weighted / total : 0,
    high_db: db(Math.sqrt(high)),
  };
}

const worker = await createRenderWorker();
const runs = [];
try {
  await loadStrudel();
  for (const testCase of CASES) {
    const result = await worker.render({
      code: `setCpm(${BPM}/4)\n${testCase.code}`,
      fromCycle: 0,
      toCycle: BARS,
      cps: CPS,
      wantWav: true,
      wantEvents: true,
    });
    const wav = decodeWav(result.wav);
    const mono = Float64Array.from(wav.channels[0]);
    const sampleRate = wav.sampleRate;

    const bars = [];
    for (let bar = 0; bar < BARS; bar += 1) {
      const from = Math.round(bar * BAR_S * sampleRate);
      const to = Math.round((bar + 1) * BAR_S * sampleRate);
      const eighths = [];
      for (let e = 0; e < 8; e += 1) {
        const ef = from + Math.round(e * EIGHTH_S * sampleRate);
        const et = from + Math.round((e + 1) * EIGHTH_S * sampleRate);
        const s = spectrum(mono, sampleRate, ef, et);
        eighths.push({
          centroid_hz: Math.round(s.centroid_hz),
          high_db: Number(s.high_db.toFixed(2)),
        });
      }
      bars.push({ bar: bar + 1, eighths });
    }

    const first = bars[0].eighths;
    const last = bars[bars.length - 1].eighths;
    const firstCentroid = first[0].centroid_hz;
    const lastCentroid = last[last.length - 1].centroid_hz;
    const firstHigh = first[0].high_db;
    const lastHigh = last[last.length - 1].high_db;

    // Сколько раз центроид меняется внутри первого такта (окна 1/8).
    let changes = 0;
    for (let i = 1; i < first.length; i += 1) {
      if (Math.abs(first[i].centroid_hz - first[i - 1].centroid_hz) > 20) changes += 1;
    }

    // Значения среза по событиям — прямой численный ответ «рамп или нет».
    const arc = await runStrudel(testCase.code, { cycles: 1 });
    const cutoffs = (arc.ok ? arc.parts.T || [] : [])
      .map((hap) => (hap.value && typeof hap.value === 'object' ? hap.value.cutoff : null))
      .filter((value) => typeof value === 'number');
    let turns = 0;
    for (let i = 2; i < cutoffs.length; i += 1) {
      const prev = cutoffs[i - 1] - cutoffs[i - 2];
      const cur = cutoffs[i] - cutoffs[i - 1];
      if (prev !== 0 && cur !== 0 && Math.sign(prev) !== Math.sign(cur)) turns += 1;
    }

    runs.push({
      label: testCase.label,
      expectation: testCase.expectation,
      events: result.events?.length ?? null,
      cutoffs: cutoffs.map((value) => Math.round(value)),
      cutoffTurns: turns,
      bars,
      facts: {
        'центроид, начало → конец первого такта, Гц': firstCentroid + ' → ' + lastCentroid,
        'рост центроида за такт, Гц': lastCentroid - firstCentroid,
        'рост центроида за трек, Гц': lastCentroid - firstCentroid,
        'верхняя полоса 4–16 кГц, начало → конец, дБ': firstHigh + ' → ' + lastHigh,
        'рост верхней полосы за трек, дБ': Number((lastHigh - firstHigh).toFixed(2)),
        'изменений центроида внутри первого такта (>20 Гц)': changes,
      },
    });
  }
} finally {
  await worker.close?.();
}

console.log('=== фильтровые нарастания: центроид и верхняя полоса ===');
for (const run of runs) {
  console.log('');
  console.log(run.label);
  console.log('  ожидание: ' + run.expectation);
  console.log('  такт  ' + run.bars[0].eighths.map((e) => String(e.centroid_hz).padStart(6)).join(''));
  for (const bar of run.bars) {
    console.log(
      String(bar.bar).padStart(5) + '  ' +
      bar.eighths.map((e) => String(e.centroid_hz).padStart(6)).join(''),
    );
  }
  for (const [label, value] of Object.entries(run.facts)) {
    console.log('  ' + label.padEnd(52) + ' ' + value);
  }
  console.log('  ' + 'срез по событиям (Гц)'.padEnd(52) + ' ' + run.cutoffs.slice(0, 10).join(' → '));
  console.log('  ' + 'смен направления среза (монотонность)'.padEnd(52) + ' ' + run.cutoffTurns);
}

const report = {
  probe: 'filter-ramp',
  date: new Date().toISOString().slice(0, 10),
  command: 'node scripts/probe-filter-ramp.mjs',
  method:
    'Рендер 4 тактов при 128 BPM. Окно анализа — 1/8 такта. Спектральный центроид и энергия ' +
    'полосы 4–16 кГц считаются FFT проекта (src/audio/dsp/fft.js) по WAV проекта.',
  bpm: BPM,
  highBandFromHz: HIGH_FROM_HZ,
  runs,
};

const date = new Date().toISOString().slice(0, 10);
const outDir = resolve(ROOT, 'docs/evidence/music');
await mkdir(outDir, { recursive: true });
const outFile = resolve(outDir, `filter-ramp-${date}.json`);
await writeFile(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('');
console.log('Записано: ' + outFile.replace(ROOT + '\\', ''));
