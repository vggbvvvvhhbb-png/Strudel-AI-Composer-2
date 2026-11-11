// Воспроизводимая проверка выводов фазы 0.
//
// Это черновая проба, на которой выводы docs/SPIKE.md были получены.
// Автоматизированная проверка — tests/unit/spike-strudel.test.js.
// Запуск: node tests/spike/probe.mjs
//
// Вывод пишется в tests/spike/probe.out.txt, чтобы не терять его в шуме
// стектрейсов бандла.

import { writeFileSync } from 'node:fs';
import { loadStrudel, runStrudel } from '../../server/music/strudel-runtime.mjs';

const out = [];
const log = (...a) => out.push(a.join(' '));
const N = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x));

const api = await loadStrudel();

log('== 1. API и события ==');
log('exports:', Object.keys(api).length);
log('mini("bd sd hh") 4 cycles:', api.mini('bd sd hh').queryArc(0, 4).length);
log('n("0 5 2 6").scale("c:minor"):', N(api.n('0 5 2 6').scale('c:minor').queryArc(0, 1).map((h) => h.value.note)));

log('\n== 2. БЕЗ setStringParser строка не разбирается ==');
api.setStringParser(null);
log('n("0 5 2 6") без парсера:', api.n('0 5 2 6').queryArc(0, 1).length, 'событие');
api.setStringParser(api.mini);
log('n("0 5 2 6") с парсером:', api.n('0 5 2 6').queryArc(0, 1).length, 'событий');

log('\n== 3. Лады: полные имена ==');
for (const name of ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'pentatonic']) {
  log(`c:${name}`.padEnd(18), N(api.n('0 1 2 3 4 5 6').scale(`c:${name}`).queryArc(0, 1).map((h) => h.value.note)));
}
for (const name of ['maj', 'min', 'harmonicminor']) {
  log(`c:${name}`.padEnd(18), api.n('0 2 4').scale(`c:${name}`).queryArc(0, 1).length, 'событий (пусто = не работает)');
}

log('\n== 4. Гармония: chord vs степени ==');
log('chord("Am").voicing():', N(api.chord('Am').voicing().queryArc(0, 1).map((h) => h.value.note)));
log('chord("A:min").voicing():', api.chord('A:min').voicing().queryArc(0, 1).length, 'событий (пусто = не работает)');
log('n("0 2 4").scale("c:minor"):', N(api.n('0 2 4').scale('c:minor').queryArc(0, 1).map((h) => h.value.note)));

log('\n== 5. arrange и silence ==');
const haps = api.arrange([4, api.silence], [4, api.mini('bd')]).queryArc(0, 8);
log('arrange([4,silence],[4,bd]) begins:', N(haps.map((h) => Number(h.whole.begin))));

log('\n== 6. /2 против .slow(2) ==');
log('n("<0 5 2 6>/2"):', api.n('<0 5 2 6>/2').scale('c:minor').queryArc(0, 8).length, 'событий (дубликаты)');
log('n("<0 5 2 6>").slow(2):', N(api.n('<0 5 2 6>').scale('c:minor').slow(2).queryArc(0, 8).map((h) => [h.value.note, Number(h.whole.begin), Number(h.whole.end)])));

log('\n== 7. Автоматизация через сигналы ==');
log('gain(sine.slow(4).range(0.2,0.8)):', N(api.n('0 2 4').scale('c:minor').gain(api.sine.slow(4).range(0.2, 0.8)).queryArc(0, 2).map((h) => h.value.gain.toFixed(3))));
log('голый сигнал:', N(api.sine.slow(4).range(0.2, 0.8).queryArc(0, 4).map((h) => h.value)));

log('\n== 8. Партии $NAME: ==');
const res = await runStrudel(`setCpm(124/4)
const key = "c:minor"
const bassA = n("<0 5 2 6>/2").scale(key).s("sawtooth")
$BASS: arrange([8, silence], [16, bassA]).gain(0.8)._pianoroll()
$DRUMS: s("bd*4, hh*8").every(4, x => x.rev())._scope()
`, { cycles: 24 });
log('ok:', res.ok, 'error:', res.error);
log('партии:', N(Object.entries(res.parts).map(([k, v]) => `${k}=${v.length}`)));

log('\n== 9. Производительность ==');
let t0 = Date.now();
await runStrudel('$X: s("bd")', { cycles: 4 });
log('первый прогон (с загрузкой):', Date.now() - t0, 'мс');
t0 = Date.now();
const long = await runStrudel(`const key = "c:minor"
const bassA = n("<0 5 2 6>/2").scale(key).s("sawtooth")
$KICK: s("bd*4")
$HAT: s("hh*8")
$BASS: arrange([8, silence], [16, bassA], [16, bassA]).gain(0.8)
$PAD: n("<0 2 4>").scale(key).s("sine").slow(4)
$LEAD: n("<0 2 4 6>").scale(key).s("square")
`, { cycles: 64 });
log('64 такта, 6 партий:', Date.now() - t0, 'мс, ok:', long.ok);

log('\n== 10. Расхождение с собственным парсером ==');
const { parseMini } = await import('../../server/music/mini.js');
for (const src of ['bd*4, hh*8', '<0 5 2 6>/2']) {
  log(src.padEnd(18), 'наш парсер:', parseMini(src, { cycles: 2 }).events.length, 'событий за 2 такта');
}

writeFileSync('tests/spike/probe.out.txt', out.join('\n'), 'utf8');
console.log(out.join('\n'));
