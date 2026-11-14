// Спайк S4: синтез недостающей перкуссии прямо в Strudel.
//
// ЗАЧЕМ. Стандартные банки Strudel (tidalcycles/dirt-samples, shabda:piano) не
// содержат бразильской перкуссии (тамборим, агогô, ганза, куика) и не имеют
// «ковбелла» для phonk. Тренировка S4: либо легальный CC0-пак, либо синтез.
// Синтез безопаснее по лицензиям и не требует загрузок — но его надо
// ПРОВЕРИТЬ, а не предположить.
//
// ПРОВЕРКА. Каждый рецепт рендерится настоящим движком (headless Chromium +
// superdough, тот же код, что в студии) и измеряется нашим DSP: громкость,
// пик, спектральный центроид. Рецепт без звука (нулевой RMS) — брак.

import { createRenderWorker } from '../../server/deepdive/render/render-worker.mjs';
import { decodeWav } from '../../src/core/wav.js';
import { measureLoudness } from '../../src/audio/dsp/loudness.js';
import { measureBands } from '../../src/audio/dsp/bands.js';

/**
 * Рецепты синтеза. Только те функции Strudel, что есть в реестре
 * server/music/data/strudel-api.json: s, note, stack, gain, lpf, hpf,
 * decay, sustain, room, distort, speed.
 */
const RECIPES = [
  {
    id: 'tamborim',
    title: 'Тамборим — металлическая дробилка (Brazilian funk)',
    code: '$P: s("sawtooth").note("a4").decay(0.09).sustain(0).lpf(2600).gain(0.7)',
    expect: 'средний тембр, короткий хвост',
  },
  {
    id: 'agogo',
    title: 'Агогô — два звонких тона (Brazilian funk)',
    code: '$P: stack(s("square").note("a4").decay(0.14).sustain(0).gain(0.45), s("square").note("e5").decay(0.14).sustain(0).gain(0.35)).lpf(3000)',
    expect: 'звонкий верхний тембр',
  },
  {
    id: 'ganza',
    title: 'Ганза/шейкер — белый шум с быстрым затуханием',
    code: '$P: s("white").hpf(6000).decay(0.055).sustain(0).gain(0.4)',
    expect: 'только верхние частоты',
  },
  {
    id: 'cuica',
    title: 'Куика — шум с движущимся фильтром',
    code: '$P: s("white").lpf(sine.range(500, 2400)).decay(0.22).sustain(0).gain(0.5)',
    expect: 'средний тембр с «подъёмом»',
  },
  {
    id: 'rumble',
    title: 'Гул/рёв — низкочастотный шум (noise() тёмный)',
    code: '$P: noise().lpf(200).decay(0.4).sustain(0.3).gain(0.6)',
    expect: 'только низ',
  },
  {
    id: 'cowbell',
    title: 'Ковбелл — phonk-мелодия (два квадрата + ФНЧ)',
    code: '$P: stack(s("square").note("f4").decay(0.3).sustain(0).gain(0.4), s("square").note("a4").decay(0.3).sustain(0).gain(0.4)).lpf(2200).gain(0.6)',
    expect: 'металлический «динь» с длинным хвостом',
  },
  {
    id: 'sub808',
    title: '808-суб — фоновая басовая нота',
    code: '$P: s("sawtooth").note("c2").lpf(400).decay(0.5).sustain(0.2).gain(0.8)',
    expect: 'только низ',
  },
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
console.log('=== Синтез перкуссии: рецепты проверены настоящим движком ===\n');

let failed = 0;
for (const recipe of RECIPES) {
  const result = await worker.render({
    code: recipe.code,
    fromCycle: 0,
    toCycle: 1,
    cps: 0.5,
    wantWav: true,
    wantEvents: false,
  });
  const audio = decodeWav(result.wav);
  const level = rms(audio.channels);
  const loud = measureLoudness(audio.channels, audio.sampleRate);
  const bands = measureBands(audio.channels, audio.sampleRate);
  const bandText = Object.entries(bands)
    .filter(([, db]) => Number.isFinite(db))
    .map(([id, db]) => `${id}=${Math.round(db)}`)
    .join(' ');
  const audible = level > 0.001;
  if (!audible) failed += 1;
  console.log(`\n${recipe.id}: ${recipe.title}`);
  console.log(`  код: ${recipe.code}`);
  console.log(`  RMS=${level.toFixed(5)}  LUFS=${loud.lufsI === null ? '—' : loud.lufsI.toFixed(1)}  ${audible ? 'ЗВУК ЕСТЬ' : 'ТИШИНА — БРАК'}`);
  console.log(`  полосы (дБ): ${bandText}`);
  console.log(`  ожидалось: ${recipe.expect}`);
}

await worker.close();
console.log(`\n=== Итог: ${RECIPES.length - failed} из ${RECIPES.length} рецептов дают звук ===`);
if (failed) process.exitCode = 1;
