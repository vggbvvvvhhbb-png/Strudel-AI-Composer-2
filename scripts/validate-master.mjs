// Золотой тест мастер-цепочки: наш выход против ffmpeg (libebur128).
//
// Требование фазы 2: «golden-тесты DSP против ffmpeg (≤0.3 LU / ≤0.3 dBTP)».
// Проверяем ровно то, что делает студия в проде: сигнал проходит мастер-цепочку
// блоками по 128 отсчётов (как в worklet), метры снимаются тем же потоковым
// измерителем, что и в реалтайме, а эталон — ffmpeg по получившемуся WAV.
//
// Запуск: npm run validate:master

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

import { MasterChain } from '../src/audio/dsp/master.js';
import { LoudnessMeter } from '../src/audio/dsp/loudness-stream.js';
import { measureTruePeak } from '../src/audio/dsp/truepeak.js';
import { libebur128TruePeak } from './libebur128-reference.mjs';

const SR = 48000;
const TOL_LU = 0.3;
const TOL_DBTP = 0.05;
const BLOCK = 128;

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

function sine(frames, freq, amp, sampleRate = SR) {
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

const dbToAmp = (db) => Math.pow(10, db / 20);

const FIXTURES = [
  {
    name: 'sine-1k-0dBFS',
    note: 'синус 1 кГц 0 dBFS — лимитер прижимает к потолку',
    make: () => {
      const l = sine(SR * 3, 1000, 1);
      return [l, Float64Array.from(l)];
    },
  },
  {
    name: 'sine-1k-6dBFS',
    note: 'синус −6 dBFS — компрессор работает, лимитер почти нет',
    make: () => {
      const l = sine(SR * 3, 1000, dbToAmp(-6));
      return [l, Float64Array.from(l)];
    },
  },
  {
    name: 'noise-3dBFS',
    note: 'шум −3 dBFS — широкая динамика, лимитер работает постоянно',
    make: () => {
      const l = noise(SR * 3);
      let peak = 0;
      for (let i = 0; i < l.length; i += 1) peak = Math.max(peak, Math.abs(l[i]));
      const scaled = Float64Array.from(l, (v) => (v * dbToAmp(-3)) / peak);
      return [scaled, Float64Array.from(scaled)];
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
    name: 'loud-then-quiet',
    note: '1 с громко + тишина — проверка гейтов и задержки цепочки',
    make: () => {
      const frames = SR * 3;
      const out = new Float64Array(frames);
      out.set(sine(SR, 1000, dbToAmp(-2)), 0);
      return [out, Float64Array.from(out)];
    },
  },
];

/** Прогон через мастер-цепочку блоками по 128 + потоковые метры (как в worklet). */
function processMaster(channels, sampleRate) {
  const chain = new MasterChain(sampleRate, { ceilingDb: -1, lookaheadMs: 5 });
  const meter = new LoudnessMeter(sampleRate);
  const frames = channels[0].length;
  const outL = new Float64Array(frames);
  const outR = new Float64Array(frames);

  const bl = new Float64Array(BLOCK);
  const br = new Float64Array(BLOCK);
  const rl = new Float64Array(BLOCK);
  const rr = new Float64Array(BLOCK);

  for (let start = 0; start < frames; start += BLOCK) {
    const end = Math.min(start + BLOCK, frames);
    const n = end - start;
    bl.fill(0);
    br.fill(0);
    bl.set(channels[0].subarray(start, end));
    br.set(channels[1].subarray(start, end));
    chain.process(bl, br, rl, rr);
    outL.set(rl.subarray(0, n), start);
    outR.set(rr.subarray(0, n), start);
    meter.process(rl.subarray(0, n), rr.subarray(0, n));
  }
  return { channels: [outL, outR], meters: meter.snapshot() };
}

/**
 * Разбор вывода `ffmpeg -af ebur128=peak=true`.
 *
 * True peak берём из блока Summary («True peak: Peak: …») — это максимум по
 * файлу. Покадровые поля FTPK/TPK — пары «текущее/максимум», и в них легко
 * спутать местами: для файла с коротким переходным в начале FTPK в последнем
 * кадре показывает не пик файла, а уровень в конце. Summary — единственное
 * поле, которое означает «максимум по файлу».
 */
function parseEbur128(text) {
  const summary = text.includes('Summary:') ? text.slice(text.indexOf('Summary:')) : '';
  const frames = text.split('\n').filter((l) => l.includes('FTPK:'));
  const lastFrame = frames.length ? frames[frames.length - 1] : '';
  const integrated = (summary.match(/^\s*I:\s*(-?[\d.]+)\s*LUFS/m) || [])[1];
  const summaryTruePeak = (summary.match(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+)/) || [])[1];
  const ftpk = (lastFrame.match(/FTPK:\s*(-?[\d.]+)/) || [])[1];
  return {
    integrated: integrated !== undefined ? Number(integrated) : null,
    truePeak: summaryTruePeak !== undefined ? Number(summaryTruePeak) : ftpk !== undefined ? Number(ftpk) : null,
  };
}

function runFfmpeg(file) {
  const res = spawnSync(
    ffmpegPath,
    ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  return parseEbur128(`${res.stdout || ''}\n${res.stderr || ''}`);
}

const dir = mkdtempSync(join(tmpdir(), 'master-'));
const rows = [];
let failures = 0;

try {
  for (const fixture of FIXTURES) {
    const input = fixture.make();
    const { channels, meters } = processMaster(input, SR);
    const file = join(dir, `${fixture.name}.wav`);
    writeFileSync(file, encodeFloatWav(channels, SR));

    const ref = runFfmpeg(file);
    const tp = measureTruePeak(channels, SR);

    // Эталон true peak — libebur128 (референс EBU R 128).
    let refTp = 0;
    for (const ch of channels) refTp = Math.max(refTp, libebur128TruePeak(ch));
    const refTpDb = refTp > 0 ? 20 * Math.log10(refTp) : -Infinity;

    const dLu = ref.integrated !== null && meters.lufsI !== null ? meters.lufsI - ref.integrated : null;
    const dTp = refTpDb !== -Infinity ? tp.truePeakDb - refTpDb : null;
    const dTpFfmpeg = ref.truePeak !== null ? tp.truePeakDb - ref.truePeak : null;
    const okLu = dLu !== null && Math.abs(dLu) <= TOL_LU;
    const okTp = dTp !== null && Math.abs(dTp) <= TOL_DBTP;
    if (!okLu || !okTp) failures += 1;

    rows.push({
      name: fixture.name,
      note: fixture.note,
      refLufs: ref.integrated,
      ourLufs: meters.lufsI,
      dLu,
      refTruePeak: refTpDb,
      ourTruePeak: tp.truePeakDb,
      dTp,
      ffmpegTruePeak: ref.truePeak,
      dTpFfmpeg,
      ok: okLu && okTp,
    });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const fixed = (v, digits = 2) => (v === null || v === undefined ? '—' : v.toFixed(digits));
console.log('Мастер-цепочка → WAV → эталон.');
console.log('Громкость — эталон ffmpeg ebur128; true peak — эталон libebur128 (EBU R 128).');
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

if (failures > 0) {
  console.error(`\nПровалено фикстур: ${failures}. Реализация не принимается.`);
  process.exit(1);
}
console.log('\nВсе фикстуры в коридоре.');
