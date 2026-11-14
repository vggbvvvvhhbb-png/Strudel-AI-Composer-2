// Разведка: как получить шум в Strudel.
//
// Проба S4 показала: `s("noise")` — это НЕ осциллятор, а сэмпл «noise» из
// банка dirt-samples (он там есть), поэтому после hpf(5500) от него почти
// ничего не остаётся. Здесь ищем рабочий способ сгенерировать шум.

import { createRenderWorker } from '../../server/deepdive/render/render-worker.mjs';
import { decodeWav } from '../../src/core/wav.js';

const VARIANTS = [
  ['s("noise")', '$P: s("noise").decay(0.05).sustain(0).gain(0.5)'],
  ['noise()', '$P: noise().decay(0.05).sustain(0).gain(0.5)'],
  ['noise().hpf', '$P: noise().hpf(5500).decay(0.055).sustain(0).gain(0.4)'],
  ['noise().lpf(sine)', '$P: noise().lpf(sine.range(500, 2400)).decay(0.22).sustain(0).gain(0.5)'],
  ['s("sawtooth").fast(4)', '$P: s("sawtooth").fast(4).hpf(4000).decay(0.05).sustain(0).gain(0.4)'],
  ['s("white")', '$P: s("white").decay(0.05).sustain(0).gain(0.5)'],
  ['s("triangle")', '$P: s("triangle").decay(0.05).sustain(0).gain(0.5)'],
  ['s("pink")', '$P: s("pink").decay(0.05).sustain(0).gain(0.5)'],
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
    console.log(`${name.padEnd(22)} RMS=${level.toFixed(5)}  ${level > 0.005 ? 'СЛЫШИМО' : 'тихо/пусто'}`);
  } catch (err) {
    console.log(`${name.padEnd(22)} ОШИБКА: ${String(err.message || err).slice(0, 120)}`);
  }
}
await worker.close();
