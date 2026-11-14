// Разведка: фильтры на шуме (S4) — какой ФНЧ/ВЧ-фильтр оставляет энергию.

import { createRenderWorker } from '../../server/deepdive/render/render-worker.mjs';
import { decodeWav } from '../../src/core/wav.js';
import { measureBands } from '../../src/audio/dsp/bands.js';

const VARIANTS = [
  ['noise() без фильтра', '$P: noise().decay(0.05).sustain(0).gain(0.4)'],
  ['noise().hpf(1000)', '$P: noise().hpf(1000).decay(0.05).sustain(0).gain(0.4)'],
  ['noise().hpf(3000)', '$P: noise().hpf(3000).decay(0.05).sustain(0).gain(0.4)'],
  ['noise().hpf(6000)', '$P: noise().hpf(6000).decay(0.05).sustain(0).gain(0.4)'],
  ['noise().hpf(8000)', '$P: noise().hpf(8000).decay(0.05).sustain(0).gain(0.4)'],
  ['noise().bp(6000)', '$P: noise().bp(6000).decay(0.05).sustain(0).gain(0.4)'],
  ['noise().lpf(8000)', '$P: noise().lpf(8000).decay(0.05).sustain(0).gain(0.4)'],
  ['noise().cutoff(6000)', '$P: noise().cutoff(6000).decay(0.05).sustain(0).gain(0.4)'],
  ['s("white").hpf(6000)', '$P: s("white").hpf(6000).decay(0.05).sustain(0).gain(0.4)'],
  ['noise().fast(8)', '$P: noise().fast(8).decay(0.05).sustain(0).gain(0.4)'],
];

function rms(channels) {
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      sum += channel[i] * channel[i];
      count += 1;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}

const worker = await createRenderWorker();
for (const [name, code] of VARIANTS) {
  try {
    const result = await worker.render({ code, fromCycle: 0, toCycle: 1, cps: 0.5, wantWav: true, wantEvents: false });
    const audio = decodeWav(result.wav);
    const level = rms(audio.channels);
    const bands = measureBands(audio.channels, audio.sampleRate);
    const bandText = Object.entries(bands)
      .filter(([, db]) => Number.isFinite(db) && db > -120)
      .map(([id, db]) => `${id}=${Math.round(db)}`)
      .join(' ');
    console.log(`${name.padEnd(24)} RMS=${level.toFixed(5)}  ${level > 0.005 ? 'СЛЫШИМО' : 'тихо'}  ${bandText}`);
  } catch (err) {
    console.log(`${name.padEnd(24)} ОШИБКА: ${String(err.message || err).slice(0, 120)}`);
  }
}
await worker.close();
