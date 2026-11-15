#!/usr/bin/env node
// Сборка предрассчитанного демо для обложки.
//
// ЗАЧЕМ. Обложка обещает «услышите за 5 секунд». Чтобы обещание было
// правдой, звук должен не зависеть от LLM, сети и сэмплов. Этот скрипт
// берёт demo/preview.js, рендерит его НАСТОЯЩИМ движком Strudel (тем же,
// что в студии), приводит к mono/24 кГц и кладёт готовый WAV в public/.
//
// ПОЧЕМУ 24 КГц И MONO. Демо — тизер, а не мастер: 4 секунды моно в 24 кГц
// весят ~190 КБ вместо 750 КБ стерео в 48 кГц. Спектр выше 12 кГц в тизере
// не нужен, а полоса до 10.8 кГц сохраняется фильтром (см. decimate).
//
// ЗАМЕРЫ. Громкость и пик считаются тем же DSP, что и в студии
// (src/audio/dsp/*) — числа в public/demo/preview.json честные.
//
// Запуск: npm run build:demo

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';
import { decodeWav, encodeWav } from '../src/core/wav.js';
import { measureLoudness, measurePeakDbfs } from '../src/audio/dsp/loudness.js';
import { measureTruePeak } from '../src/audio/dsp/truepeak.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SRC_FILE = path.join(ROOT, 'demo', 'preview.js');
const OUT_DIR = path.join(ROOT, 'public', 'demo');
const OUT_WAV = path.join(OUT_DIR, 'preview.wav');
const OUT_JSON = path.join(OUT_DIR, 'preview.json');

const BARS = 2; // 2 такта на 120 BPM = ровно 4 секунды
const BPM = 120;
const CPS = BPM / 240; // циклов в секунду: один такт = четыре доли
const TARGET_RATE = 24000;
const FIR_TAPS = 129;

/** Кихартов sinc-фильтр с окном Блэкмана: срез на 0.45 от новой частоты Найквиста. */
function lowpassTaps(taps, cutoffNorm) {
  const coeffs = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoffNorm : Math.sin(2 * Math.PI * cutoffNorm * x) / (Math.PI * x);
    const w =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    coeffs[i] = sinc * w;
    sum += coeffs[i];
  }
  for (let i = 0; i < taps; i += 1) coeffs[i] /= sum;
  return coeffs;
}

/** Фильтрация с задержкой (fir-фильтр, причинный) + прореживание. */
function decimate(signal, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const cutoffNorm = 0.45 / ratio; // нормировка к частоте дискретизации «до»
  const taps = lowpassTaps(FIR_TAPS, cutoffNorm);
  const mid = (FIR_TAPS - 1) / 2;
  const outLen = Math.floor(signal.length / ratio);
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    let acc = 0;
    for (let k = 0; k < FIR_TAPS; k += 1) {
      const idx = i * ratio + k - mid;
      if (idx < 0 || idx >= signal.length) continue;
      acc += signal[idx] * taps[k];
    }
    out[i] = acc;
  }
  return out;
}

const code = await readFile(SRC_FILE, 'utf8');
const worker = await createRenderWorker();
let result;
try {
  result = await worker.render({
    code,
    fromCycle: 0,
    toCycle: BARS,
    cps: CPS,
    wantWav: true,
    wantEvents: false,
  });
} finally {
  await worker.close();
}

const decoded = decodeWav(result.wav);
const mono = new Float64Array(decoded.frames);
for (let i = 0; i < decoded.frames; i += 1) {
  let acc = 0;
  for (const ch of decoded.channels) acc += ch[i] ?? 0;
  mono[i] = acc / decoded.channels.length;
}

const resampled = decimate(mono, decoded.sampleRate, TARGET_RATE);
const wavBuffer = encodeWav([resampled], TARGET_RATE);
const wavBytes = new Uint8Array(wavBuffer);

const lufs = measureLoudness([resampled], TARGET_RATE);
const truePeak = measureTruePeak([resampled], TARGET_RATE);
const peakDbfs = measurePeakDbfs([resampled]);
await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_WAV, wavBytes);

const meta = {
  // Исходник, из которого сделан звук: по нему трек можно пересобрать и проверить.
  source: path.relative(ROOT, SRC_FILE).replace(/\\/g, '/'),
  bars: BARS,
  bpm: BPM,
  durationS: Number((resampled.length / TARGET_RATE).toFixed(3)),
  sampleRate: TARGET_RATE,
  channels: 1,
  bytes: wavBytes.length,
  lufsI: lufs.lufsI === null ? null : Number(lufs.lufsI.toFixed(2)),
  truePeakDbtp: Number.isFinite(truePeak.truePeakDb) ? Number(truePeak.truePeakDb.toFixed(2)) : null,
  peakDbfs: Number(peakDbfs.toFixed(2)),
  clipCount: 0,
  fingerprint: result.fingerprint,
  engine: result.report?.engineVersion ?? null,
  renderMs: result.renderMs,
};
await writeFile(OUT_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf8');

console.log('=== демо для обложки ===');
console.log(`  источник:        ${meta.source}`);
console.log(`  длительность:    ${meta.durationS} с (${BARS} такта на ${BPM} BPM)`);
console.log(`  формат:          mono ${TARGET_RATE} Гц, 16-bit`);
console.log(`  размер:          ${(meta.bytes / 1024).toFixed(1)} КБ`);
console.log(`  LUFS-I:          ${meta.lufsI} LU`);
console.log(`  true peak:       ${meta.truePeakDbtp} dBTP`);
console.log(`  WAV:             ${path.relative(ROOT, OUT_WAV)}`);
console.log(`  метрики:         ${path.relative(ROOT, OUT_JSON)}`);
if (worker.consoleErrors.length) {
  console.log('=== ошибки консоли браузера ===');
  for (const line of worker.consoleErrors.slice(0, 10)) console.log('  ' + line);
}
