// Генерация собственного демо-трека для вертикального среза.
//
// ЗАЧЕМ. Для проверки режима «Разбор» нужен трек, который можно загрузить
// на прод без вопросов о лицензиях. Этот файл сгенерирован нами же из
// Strudel-кода: он однозначно легальный, его можно публиковать.
//
// Трек намеренно НЕ тривиальный: сетка 1/16, снейр со сдвигом (свинг),
// бас по нотам, аккорды — чтобы транспайлеру было что измерять.

import { writeFile } from 'node:fs/promises';
import { createRenderWorker } from '../../server/deepdive/render/render-worker.mjs';

const BPM = 92;
const CPS = BPM / 240; // циклы в секунду
const BARS = 24;

const code = `
setCpm(${BPM}/4)
const ms = x => x * (${BPM}/4) / 60000

const KICK = s("bd").beat("0,6,10",16).gain(0.95)
const SNARE = s("sd").beat("4,12",16).gain(0.72)
const HATS = s("hh").beat("0,2,4,6,8,10,12,14",16).gain(0.45)
const BASS = note("c2 c2 eb2 g1 ~ ~ f2 ~ ~ ab1 ~ ~ bb1 ~ ~").s("sawtooth").lpf(700).decay(0.4).sustain(0.1)
const CHORDS = note("[c3,eb3,g3] ~ ~ ~ [ab2,bb2,d3] ~ ~ ~ [eb3,g3,bb3] ~ ~ ~ [f3,a3,c4] ~ ~ ~").s("sawtooth").lpf(1400).decay(0.6).sustain(0.2)
const SWING = s("hh").beat("2,6,10,14",16).gain(0.3).late(ms(14))

$KICK: arrange([8, KICK], [8, KICK], [8, KICK])._scope()
$SNARE: arrange([8, SNARE], [8, SNARE], [8, SNARE])._scope()
$HATS: arrange([8, HATS], [8, HATS], [8, HATS])._scope()
$SWING: arrange([8, SWING], [8, SWING], [8, SWING])._scope()
$BASS: arrange([8, BASS], [8, BASS], [8, BASS])._pianoroll()
$CHORDS: arrange([8, CHORDS], [8, CHORDS], [8, CHORDS])._pianoroll()
`;

const worker = await createRenderWorker();
const result = await worker.render({
  code,
  fromCycle: 0,
  toCycle: BARS,
  cps: CPS,
  sampleRate: 44100,
  wantWav: true,
  wantEvents: false,
});
await worker.close();

const out = process.argv[2] || '.scratch/demo-track.wav';
await writeFile(out, result.wav);
console.log(`готово: ${out}, ${result.durationS.toFixed(1)} с, ${(result.wav.length / 1024 / 1024).toFixed(2)} МБ, рендер ${result.renderMs} мс`);
