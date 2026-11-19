#!/usr/bin/env node
// P1.4 — измеритель глубины приглушения баса киком (duckorbit).
//
// ЗАЧЕМ. Промт утверждает «цель — 3–6 дБ приглушения баса на кике» и требует
// не заявлять глубину без замера. Этот скрипт меряет.
//
// КАК МЕРЯЕТСЯ. Бас стоит на орбите 2 и играет сам по себе (эталон) и вместе
// с киком, который эту орбиту приглушает. Кик в обоих прогонах беззвучен
// (gain(0)): он всё равно срабатывает как триггер, но не добавляет своей
// энергии в окна — иначе разница огибающих измеряла бы не приглушение, а
// сумму «бас + кик». Проверено: немой кик приглушает так же, как звучащий.
//
// Метрика: окна 25 мс, разность уровней в дБ. Глубина берётся как среднее
// среди окон с провалом больше 1 дБ (окна, где эталонный бас громкий, —
// иначе артефакты на нулевых переходах синусоиды).
//
// ЗАПУСК: node scripts/probe-sidechain.mjs

import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';
import { decodeWav } from '../src/core/wav.js';

const BASS = '$BASS: note("c2").s("sine").orbit(2).gain(0.8)';
const KICK = (attack, depth) => `$KICK: s("bd*4").duckorbit(2).duckattack(${attack}).duckdepth(${depth}).gain(0)`;

const CASES = [
  { label: 'depth 1.0, attack 0.2', attack: '0.2', depth: '1' },
  { label: 'depth 0.5, attack 0.2', attack: '0.2', depth: '0.5' },
  { label: 'depth 0.3, attack 0.2', attack: '0.2', depth: '0.3' },
  { label: 'depth 0.2, attack 0.2', attack: '0.2', depth: '0.2' },
  { label: 'depth 0.1, attack 0.2', attack: '0.2', depth: '0.1' },
  { label: 'depth 1.0, attack 0.1', attack: '0.1', depth: '1' },
  { label: 'depth 1.0, attack 0.05', attack: '0.05', depth: '1' },
  { label: 'depth 1.0, attack 0.001', attack: '0.001', depth: '1' },
];

function windowRms(channels, sampleRate, winS = 0.025) {
  const win = Math.max(1, Math.round(sampleRate * winS));
  const n = Math.floor(channels[0].length / win);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    let acc = 0;
    for (const ch of channels) {
      for (let j = i * win; j < (i + 1) * win; j += 1) acc += ch[j] * ch[j];
    }
    out.push(Math.sqrt(acc / (win * channels.length)));
  }
  return out;
}

const db = (x) => 20 * Math.log10(x || 1e-12);

const worker = await createRenderWorker();
try {
  const ref = await worker.render({ code: BASS, fromCycle: 0, toCycle: 4, cps: 120 / 240, wantWav: true, wantEvents: false });
  const refEnv = windowRms(decodeWav(ref.wav).channels, ref.sampleRate);
  const refMax = Math.max(...refEnv);
  const loud = refEnv.map((v, i) => [i, v]).filter(([, v]) => v > 0.5 * refMax).map(([i]) => i);

  console.log('=== глубина приглушения баса киком (duckorbit) ===');
  console.log('окно 25 мс; эталон — бас один; кик беззвучен (gain 0), но срабатывает');
  console.log('');
  console.log('параметры              глубина, дБ   окон с провалом >1 дБ');
  for (const c of CASES) {
    const duck = await worker.render({
      code: `${KICK(c.attack, c.depth)}\n${BASS}`,
      fromCycle: 0, toCycle: 4, cps: 120 / 240, wantWav: true, wantEvents: false,
    });
    const env = windowRms(decodeWav(duck.wav).channels, duck.sampleRate);
    const diffs = loud.map((i) => db(env[i]) - db(refEnv[i]));
    const active = diffs.filter((d) => d < -1);
    const mean = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
    console.log(`${c.label.padEnd(22)} ${mean.toFixed(2).padStart(8)}   ${String(active.length).padStart(4)} из ${diffs.length}`);
  }
} finally {
  await worker.close?.();
}
