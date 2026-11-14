// Спайк: точная семантика событий Strudel для ролей IR.
//
// Оракул должен воспроизводить события движка без обращения к нему (чтобы
// искать сотни кандидатов в секунду). Значит, нужно точно знать:
//   • сколько событий даёт каждый тип партии;
//   • где стоят атаки (доли/такты);
//   • какие высоты и сколько их в событии;
//   • как `late()` сдвигает атаку.
//
// Здесь снимается эталон — движок говорит сам.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const CASES = [
  ['ударные: beat("0,7,10",16)', '$K: s("bd").beat("0,7,10",16).gain(0.9)'],
  ['ударные со сдвигом late(6ms)', '$K: s("bd").beat("0,7,10",16).gain(0.9).late(0.001)'],
  ['бас: корни + struct', '$B: "<Dm9 Gm7>".rootNotes(2).note().struct("x ~ ~ x ~ ~ ~ ~").s("sine")'],
  ['аккорды: chord + voicing', '$C: chord("<Dm9 Dm9 Gm7 Gm7>").dict("ireal").voicing().anchor("c4").s("piano")'],
  ['пэд: chord + attack/release', '$P: chord("<Dm9 Dm9>").dict("ireal").voicing().anchor("c3").s("triangle").attack(2.5).release(5)'],
  ['лид: мини-строка', '$L: n("5 ~ 5 ~ 5 ~ 1 ~ 5 ~ ~ ~ ~ ~ ~ ~").scale("d:minor").s("triangle")'],
  ['арп: fast(2)', '$A: n("0 2 4 7 4 2").scale("d:minor").fast(2).s("triangle")'],
  ['шум: brown без паттерна', '$X: s("brown").lpf(700)'],
  ['шум: pink в 16-х', '$X: s("pink").fast(4)'],
  ['группа ударных: stack', '$K: stack(s("bd").beat("0",16).gain(0.8), s("bd").beat("7",16).gain(0.6).late(0.001))'],
  ['арка: arrange', '$K: arrange([2, s("bd").beat("0,4,8,12",16)], [2, silence])'],
  ['громкость: gain + velocity', '$K: s("bd").beat("0,4",16).gain(0.5).velocity(0.8)'],
];

const CYCLES = 4;

for (const [name, code] of CASES) {
  const result = await runStrudel(code, { cycles: CYCLES });
  console.log(`\n=== ${name}`);
  if (!result.ok) {
    console.log(`  ОШИБКА: ${result.error}`);
    continue;
  }
  for (const [part, events] of Object.entries(result.parts)) {
    console.log(`  ${part}: ${events.length} событий на ${CYCLES} такта`);
    for (const e of events.slice(0, 6)) {
      const begin = Number(e.whole?.begin ?? 0);
      const end = Number(e.whole?.end ?? 0);
      const v = e.value || {};
      const notes = Array.isArray(v.note) ? v.note : (v.note ? [v.note] : []);
      const bits = [
        `t=${begin.toFixed(4)}`,
        `dur=${(end - begin).toFixed(4)}`,
        notes.length ? `notes=[${notes.join(' ')}]` : '',
        v.s ? `s=${v.s}` : '',
        v.gain !== undefined ? `gain=${v.gain}` : '',
        v.velocity !== undefined ? `vel=${v.velocity}` : '',
      ].filter(Boolean);
      console.log(`    ${bits.join(' ')}`);
    }
  }
}
