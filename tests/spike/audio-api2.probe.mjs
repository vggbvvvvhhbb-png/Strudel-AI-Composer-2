// Проба №2: сигнатуры эффектов и форма REPL.
// Запуск: node tests/spike/audio-api2.probe.mjs

import { writeFileSync } from 'node:fs';
import { loadStrudel } from '../../server/music/strudel-runtime.mjs';

const out = [];
const log = (...a) => out.push(a.join(' '));

const api = await loadStrudel();
const proto = api.Pattern?.prototype ?? {};

const show = (name) => {
  const fn = proto[name];
  log(`\n--- ${name} ---`);
  log(typeof fn === 'function' ? String(fn).replace(/\s+/g, ' ').slice(0, 400) : 'НЕТ');
};

log('== 1. Сигнатуры эффектов ==');
for (const name of ['compressor', 'compressorAttack', 'compressorRatio', 'compressorKnee', 'compressorRelease',
  'duck', 'duckorbit', 'duckattack', 'duckdepth', 'duckons', 'duckonset',
  'orbit', 'gain', 'postgain', 'pan', 'room', 'delay']) show(name);

log('\n== 2. Значения событий с разными параметрами ==');
const dump = (label, p) => {
  try {
    const haps = p.queryArc(0, 1);
    log(label, '→', haps.length, 'событий:', JSON.stringify(haps[0]?.value ?? null, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  } catch (err) {
    log(label, '→ ОШИБКА:', String(err?.message || err));
  }
};
dump('compressor(-20)', api.s('bd').compressor(-20));
dump('compressor(-20, 3)', api.s('bd').compressor(-20, 3));
dump('compressor(-20, 3, 0.05, 0.3, 6)', api.s('bd').compressor(-20, 3, 0.05, 0.3, 6));
// compressorThreshold/compressorRatio — не методы паттерна, а глобальные дефолты.
dump('global compressorThreshold(-18) via pattern', api.s('bd').compressor(-20));
for (const name of ['compressorThreshold', 'compressorRatio', 'compressorAttack', 'compressorRelease', 'compressorKnee']) {
  log(`global ${name}: ${typeof api[name] === 'function' ? 'есть' : 'НЕТ'}`);
}
dump('duckorbit(2).duckattack(0.2).duckdepth(1)', api.s('bd').duckorbit(2).duckattack(0.2).duckdepth(1));
dump('duck(1, 0.5, 0.2, 1)', api.s('bd').duck(1, 0.5, 0.2, 1));

log('\n== 3. Форма REPL (webaudioRepl) ==');
try {
  const repl = api.webaudioRepl({});
  log('ключи REPL:', Object.keys(repl).join(', '));
  log('scheduler:', repl.scheduler ? Object.keys(repl.scheduler).join(', ') : 'ОТСУТСТВУЕТ');
  log('scheduler.now:', typeof repl.scheduler?.now);
  log('evaluate:', typeof repl.evaluate);
  log('state:', repl.state ? Object.keys(repl.state).join(', ') : '—');
} catch (err) {
  log('ОШИБКА:', String(err?.message || err));
}

log('\n== 4. Что ещё экспортируется рядом с аудио-шиной ==');
const audioish = Object.keys(api).filter((k) => /audio|output|context|orbit|dough|master|sink|record/i.test(k));
log(audioish.join(', '));

log('\n== 5. Упоминания destination в бандле (риск подмены) ==');
log('см. отдельный grep по dist/index.mjs');

const text = out.join('\n');
process.stdout.write(text + '\n');
writeFileSync(new URL('./audio-api2.out.txt', import.meta.url), text + '\n');
