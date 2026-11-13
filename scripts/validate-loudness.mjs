// Валидация DSP-ядра по эталону.
//
// Два эталона, потому что они разные приборы:
//
//  1. ffmpeg ebur128 (libebur128) — эталон ГРОМКОСТИ. Строгий допуск
//     |ΔLUFS| ≤ 0.3: обе реализации считают LUFS по BS.1770-4 одинаково.
//
//  2. True peak. Здесь ffmpeg НЕ эталон: его фильтр true peak — это не
//     фильтр приложения 2 стандарта, а передискретизация до 192 кГц
//     ресемплером libswresample (f_ebur128.c: swr_convert → out_sample_rate
//     192000). У swresample своя АЧХ, и на широкополосных синтетических
//     сигналах она даёт завышение до +0.7 дБ. Референсом true peak поэтому
//     служит libebur128 — эталон EBU R 128, — чей алгоритм (49 отсчётов,
//     окно Ханнинга, 4×) воспроизведён ниже буквально.
//
// Правило приёмки:
//   |ΔLUFS vs ffmpeg|            ≤ 0.3   (все фикстуры)
//   |ΔdBTP vs libebur128|        ≤ 0.05  (все фикстуры)
//   |ΔdBTP vs ffmpeg|            — показатель, не критерий: расхождение
//                                    объясняется ресемплером ffmpeg.
//
// Запуск: npm run validate:loudness
// Фикстуры детерминированы (mulberry32-шум, без Math.random), поэтому числа
// воспроизводимы от запуска к запуску.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

import { measureLoudness, measurePeakDbfs } from '../src/audio/dsp/loudness.js';
import { measureTruePeak } from '../src/audio/dsp/truepeak.js';
import { libebur128TruePeak } from './libebur128-reference.mjs';

const SR = 48000;
const TOL_LU = 0.3;
const TOL_DBTP = 0.05;

/** WAV во float32 (WAVE_FORMAT_IEEE_FLOAT) — без потерь квантования. */
function encodeFloatWav(channels, sampleRate) {
  const numCh = channels.length;
  const frames = channels[0].length;
  const dataSize = frames * numCh * 4;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(numCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numCh * 4, 28);
  buf.writeUInt16LE(numCh * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  let off = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      buf.writeFloatLE(channels[c][i], off);
      off += 4;
    }
  }
  return buf;
}

/**
 * Белый шум на mulberry32: у обычного LCG низкие разряды коррелированы,
 * и сигнал получается почти треугольным (crest ≈ 4 дБ вместо ≈ 11 дБ) —
 * такой «шум» не проверяет измеритель громкости.
 */
function noise(frames, seed = 0x9e3779b9) {
  let a = seed >>> 0;
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return out;
}

function sine(frames, freq, amp, sampleRate = SR, phase = 0) {
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase);
  }
  return out;
}

const dbToAmp = (db) => Math.pow(10, db / 20);

const FIXTURES = [
  {
    name: 'sine-1k-20dBFS',
    note: 'синус 1 кГц, −20 dBFS, 3 с',
    make: () => {
      const l = sine(SR * 3, 1000, dbToAmp(-20));
      return [l, Float64Array.from(l)];
    },
  },
  {
    name: 'sine-1k-26dBFS',
    note: 'тихий синус — проверка гейта −70 LUFS',
    make: () => {
      const l = sine(SR * 3, 1000, dbToAmp(-26));
      return [l, Float64Array.from(l)];
    },
  },
  {
    name: 'noise-18dBFS',
    note: 'белый шум −18 dBFS, 3 с',
    make: () => {
      const l = noise(SR * 3);
      let peak = 0;
      for (let i = 0; i < l.length; i += 1) peak = Math.max(peak, Math.abs(l[i]));
      const scale = dbToAmp(-18) / peak;
      const scaled = Float64Array.from(l, (v) => v * scale);
      return [scaled, Float64Array.from(scaled)];
    },
  },
  {
    name: 'sweep-100-8k',
    note: 'свип 100 Гц…8 кГц, −12 dBFS',
    make: () => {
      const frames = SR * 3;
      const out = new Float64Array(frames);
      const f0 = 100;
      const f1 = 8000;
      const k = (f1 - f0) / (3 * SR);
      let phase = 0;
      for (let i = 0; i < frames; i += 1) {
        const f = f0 + k * i;
        phase += (2 * Math.PI * f) / SR;
        out[i] = dbToAmp(-12) * Math.sin(phase);
      }
      return [out, Float64Array.from(out)];
    },
  },
  {
    name: 'hf-12k-peak',
    note: '12 кГц −3 dBFS — true peak выше sample peak',
    make: () => {
      const l = sine(SR * 2, 12000, dbToAmp(-3));
      return [l, Float64Array.from(l)];
    },
  },
  {
    name: 'burst-then-quiet',
    note: '0.5 с сигнала + тишина — проверка интегрального гейта',
    make: () => {
      const frames = SR * 3;
      const out = new Float64Array(frames);
      const burst = sine(SR * 0.5, 1000, dbToAmp(-10));
      out.set(burst, 0);
      return [out, Float64Array.from(out)];
    },
  },
];

/**
 * Разбор вывода `ffmpeg -af ebur128=peak=true -f null -`.
 *
 * Важно: покадровый лог начинается с «I: -70.0 LUFS» (интегральная громкость
 * ещё не посчитана), поэтому сводные значения берём из блока Summary.
 *
 * True peak берём тоже из Summary («True peak: Peak: …»): покадровые поля
 * FTPK/TPK — пары «текущее/максимум», и для файла с переходным в начале
 * последний кадр показывает не пик файла, а уровень в конце. Summary — поле,
 * которое означает максимум по файлу.
 */
function parseEbur128(text) {
  const summary = text.includes('Summary:') ? text.slice(text.indexOf('Summary:')) : '';
  const frames = text.split('\n').filter((l) => l.includes('FTPK:'));
  const lastFrame = frames.length ? frames[frames.length - 1] : '';

  const integrated = (summary.match(/^\s*I:\s*(-?[\d.]+)\s*LUFS/m) || [])[1];
  const lra = (summary.match(/^\s*LRA:\s*(-?[\d.]+)\s*LU/m) || [])[1];
  const summaryTruePeak = (summary.match(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+)/) || [])[1];
  const ftpk = (lastFrame.match(/FTPK:\s*(-?[\d.]+)/) || [])[1];
  const tpk = (lastFrame.match(/TPK:\s*(-?[\d.]+)/) || [])[1];

  return {
    integrated: integrated !== undefined ? Number(integrated) : null,
    lra: lra !== undefined ? Number(lra) : null,
    truePeak: summaryTruePeak !== undefined ? Number(summaryTruePeak) : ftpk !== undefined ? Number(ftpk) : null,
    peak: tpk !== undefined ? Number(tpk) : null,
  };
}

function runFfmpeg(file) {
  // Сводка ebur128 уходит в stderr — читаем оба потока.
  const res = spawnSync(
    ffmpegPath,
    ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  return parseEbur128(text);
}

const dir = mkdtempSync(join(tmpdir(), 'loudness-'));
const rows = [];
let failures = 0;

try {
  for (const fixture of FIXTURES) {
    const channels = fixture.make();
    const file = join(dir, `${fixture.name}.wav`);
    writeFileSync(file, encodeFloatWav(channels, SR));

    const ref = runFfmpeg(file);
    const ours = measureLoudness(channels, SR);
    const tp = measureTruePeak(channels, SR);

    // Эталон true peak — libebur128 (референс EBU R 128).
    let refTp = 0;
    for (const ch of channels) refTp = Math.max(refTp, libebur128TruePeak(ch));
    const refTpDb = refTp > 0 ? 20 * Math.log10(refTp) : -Infinity;

    const dLu = ref.integrated !== null && ours.lufsI !== null ? ours.lufsI - ref.integrated : null;
    const dTp = refTpDb !== -Infinity ? tp.truePeakDb - refTpDb : null;
    const dTpFfmpeg = ref.truePeak !== null ? tp.truePeakDb - ref.truePeak : null;
    const okLu = dLu !== null && Math.abs(dLu) <= TOL_LU;
    const okTp = dTp !== null && Math.abs(dTp) <= TOL_DBTP;
    if (!okLu || !okTp) failures += 1;

    rows.push({
      name: fixture.name,
      note: fixture.note,
      refLufs: ref.integrated,
      ourLufs: ours.lufsI,
      dLu,
      refTruePeak: refTpDb,
      ourTruePeak: tp.truePeakDb,
      dTp,
      ffmpegTruePeak: ref.truePeak,
      dTpFfmpeg,
      ourPeak: measurePeakDbfs(channels),
      ok: okLu && okTp,
    });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const fixed = (v, digits = 2) => (v === null || v === undefined ? '—' : v.toFixed(digits));
console.log('Фикстуры: 48 кГц, стерео.');
console.log(`Громкость — эталон ffmpeg ebur128; true peak — эталон libebur128 (EBU R 128).`);
console.log(`Допуск: |ΔLUFS| ≤ ${TOL_LU}, |ΔdBTP| ≤ ${TOL_DBTP}\n`);
console.log(
  ['фикстура', 'LUFS ref', 'LUFS наш', 'ΔLU', 'dBTP ref', 'dBTP наш', 'ΔdBTP', 'ffmpeg dBTP', 'Δ vs ffmpeg', 'итог']
    .map((h, i) => h.padEnd([20, 9, 9, 7, 9, 10, 8, 12, 13, 6][i]))
    .join(''),
);
for (const r of rows) {
  console.log(
    [
      r.name.padEnd(20),
      fixed(r.refLufs).padEnd(9),
      fixed(r.ourLufs).padEnd(9),
      fixed(r.dLu).padEnd(7),
      fixed(r.refTruePeak).padEnd(9),
      fixed(r.ourTruePeak).padEnd(10),
      fixed(r.dTp).padEnd(8),
      fixed(r.ffmpegTruePeak).padEnd(12),
      fixed(r.dTpFfmpeg).padEnd(13),
      r.ok ? 'OK' : 'FAIL',
    ].join(''),
  );
}

console.log(
  '\nРасхождение с ffmpeg по true peak — не ошибка: ffmpeg меряет true peak\n' +
    'ресемплером libswresample (до 192 кГц), а не фильтром приложения 2 стандарта.\n' +
    'На широкополосных синтетических фикстурах это до +0.7 дБ; на полосовом\n' +
    'материале (синус, свип) — в пределах 0.2 дБ.',
);

if (failures > 0) {
  console.error(`\nПровалено фикстур: ${failures}. Реализация не принимается.`);
  process.exit(1);
}
console.log('\nВсе фикстуры в коридоре.');
