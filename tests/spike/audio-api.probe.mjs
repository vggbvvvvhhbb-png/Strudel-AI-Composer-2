// Проба аудио-API Strudel: какие ручки есть для мастер-цепочки, темпа и эффектов.
// Запуск: node tests/spike/audio-api.probe.mjs
//
// Это фаза 0 (H1/H2/H5/H6/H12): проверяем не по рисерчу, а по фактическим
// экспортам и сигнатурам зафиксированной версии @strudel/web.

import { writeFileSync } from 'node:fs';
import { loadStrudel } from '../../server/music/strudel-runtime.mjs';

const out = [];
const log = (...a) => out.push(a.join(' '));

const api = await loadStrudel();

log('== версии ==');
log('@strudel/web exports:', Object.keys(api).length);

log('\n== 1. Руччки для мастер-цепочки (H1) ==');
const AUDIO_HANDLES = [
  'webaudioOutput',
  'webaudioRepl',
  'connectToDestination',
  'getAudioContext',
  'getAudioContextCurrentTime',
  'setAudioContext',
  'setDefaultAudioContext',
  'setSuperdoughAudioController',
  'superdough',
  'superdoughTrigger',
  'dough',
  'doughTrigger',
  'initAudioOnFirstClick',
  'initStrudel',
  'evaluate',
  'hush',
  'registerSounds',
  'samples',
  'setMaxPolyphony',
];
for (const name of AUDIO_HANDLES) {
  const fn = api[name];
  if (typeof fn === 'function') {
    log(`${name}: ${fn.length} арг(ов)`);
    log(`    ${String(fn).replace(/\s+/g, ' ').slice(0, 220)}`);
  } else {
    log(`${name}: ОТСУТСТВУЕТ (${typeof fn})`);
  }
}

log('\n== 2. Методы паттерна: эффекты и параметры ==');
const proto = api.Pattern?.prototype ?? {};
const wanted = [
  'duck', 'duckorbit', 'duckattack', 'duckdepth', 'duckons', 'duckonset',
  'compressor', 'compressorAttack', 'compressorRatio', 'compressorKnee', 'compressorRelease',
  'orbit', 'gain', 'postgain', 'pan', 'lpf', 'hpf', 'room', 'delay',
];
for (const name of wanted) {
  log(`${name}: ${typeof proto[name] === 'function' ? 'есть' : 'НЕТ'}`);
}

log('\n== 3. Дакинг: поведение на уровне паттерна (H2) ==');
try {
  const p = api.s('bd').duckorbit(1).duckattack(0.2).duckdepth(1);
  const haps = p.queryArc(0, 2);
  log('s("bd").duckorbit(1)... queryArc(0,2):', haps.length, 'событий');
  if (haps[0]) log('  значения события:', JSON.stringify(haps[0].value, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
} catch (err) {
  log('ОШИБКА:', String(err?.message || err));
}

log('\n== 4. Компрессор: параметры по умолчанию (H6) ==');
try {
  const p = api.s('bd').compressor(-20, 3);
  const haps = p.queryArc(0, 1);
  log('s("bd").compressor(-20,3):', haps.length, 'событий');
  if (haps[0]) log('  значения события:', JSON.stringify(haps[0].value, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
} catch (err) {
  log('ОШИБКА:', String(err?.message || err));
}

log('\n== 5. Глобальные дефолты эффектов (H6) ==');
for (const fn of ['setDefault', 'getDefault', 'resetDefaults', 'setDefaultValue', 'getDefaultValue']) {
  log(`${fn}: ${typeof api[fn] === 'function' ? 'есть' : 'НЕТ'}`);
}
try {
  log('defaults(compressorThreshold):', JSON.stringify(api.getDefault?.('compressorThreshold')));
  log('defaults(compressorRatio):', JSON.stringify(api.getDefault?.('compressorRatio')));
} catch (err) {
  log('ОШИБКА:', String(err?.message || err));
}

log('\n== 6. Планировщик / позиция (H5) ==');
for (const fn of ['createScheduler', 'scheduler', 'getTime', 'now', 'getAudioContextCurrentTime']) {
  log(`${fn}: ${typeof api[fn] === 'function' ? 'есть' : 'НЕТ'}`);
}

const text = out.join('\n');
process.stdout.write(text + '\n');
writeFileSync(new URL('./audio-api.out.txt', import.meta.url), text + '\n');
