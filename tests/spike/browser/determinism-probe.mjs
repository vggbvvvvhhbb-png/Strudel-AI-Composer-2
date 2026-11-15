#!/usr/bin/env node
// Проба детерминизма рендера: где именно WAV расходится между прогонами.
//
// ЗАЧЕМ. Гейт B требует, чтобы локальный рендер совпадал с серверным
// «бит-в-бит». Проверка показала: для чистых осцилляторов и чистых сэмплов
// рендер побитово детерминирован, а для СМЕСИ расходится на 1 LSB 16-битного
// звука (≈3.05e-5) в единицах на миллион. Это в пределах допуска проекта
// (docs/BRIEF.md:73, maxAbsDiff ≤ 1e-4), но «бит-в-бит» — неправда, и
// причину надо знать, а не угадывать.
//
// ЗАПУСК: node tests/spike/browser/determinism-probe.mjs
//
// ЭТО НЕ ТЕСТ. Это измерение: сценарий печатает числа, а решение о допуске
// принимается в D-решении и в гейте B (scripts/gate-b.mjs).

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRenderWorker } from '../../../server/deepdive/render/render-worker.mjs';

const PATTERNS = {
  'осциллятор (как в спайке)': 'setCpm(120/4)\n$BASS: n("0 ~ 2 4").scale("c:minor").s("sawtooth")',
  'сэмпл': 'setCpm(120/4)\n$KICK: s("bd*4")',
  'осциллятор + сэмпл': 'setCpm(120/4)\n$KICK: s("bd*4")._scope()\n$BASS: n("0 ~ 2 4").scale("c:minor").s("sawtooth")._pianoroll()',
};

/**
 * PCM из WAV (16 бит) — сравнивать надо звук, а не заголовок файла.
 * @param {Buffer} wav
 * @returns {Buffer}
 */
function pcmOf(wav) {
  let offset = 12;
  while (offset < wav.length - 8) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  return wav.subarray(44);
}

/**
 * @param {Buffer} a
 * @param {Buffer} b
 */
function compare(a, b) {
  const pa = pcmOf(a);
  const pb = pcmOf(b);
  if (pa.length !== pb.length) return { error: `разная длина: ${pa.length}/${pb.length}` };
  let max = 0;
  let diff = 0;
  let firstIndex = null;
  for (let i = 0; i < pa.length; i += 1) {
    const d = Math.abs(pa[i] - pb[i]);
    if (d > 0) {
      diff += 1;
      if (firstIndex === null) firstIndex = i;
    }
    if (d > max) max = d;
  }
  return {
    maxAbsDiff: max,
    maxAbsDiffNormalized: max / 32768,
    diffSamples: diff,
    total: pa.length,
    relative: diff / pa.length,
    firstIndex,
  };
}

const worker = await createRenderWorker();
console.log(`Проба детерминизма рендера, ${process.platform}, ${process.arch}\n`);
for (const [name, code] of Object.entries(PATTERNS)) {
  const a = await worker.render({ code, fromCycle: 0, toCycle: 8 });
  const b = await worker.render({ code, fromCycle: 0, toCycle: 8 });
  const shaA = createHash('sha256').update(a.wav).digest('hex');
  const shaB = createHash('sha256').update(b.wav).digest('hex');
  const diff = compare(a.wav, b.wav);
  console.log(`${name}`);
  console.log(`  файлы идентичны: ${shaA === shaB}`);
  console.log(`  звук: ${JSON.stringify(diff)}`);
  console.log('');
}
await worker.close();
console.log('Допуск проекта: maxAbsDiff ≤ 1e-4 в нормализованном виде (docs/BRIEF.md:73).');
