// Спайк: два оставшихся случая — arrange и gain+velocity.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const CASES = [
  ['арка: arrange', '$K: arrange([2, s("bd").beat("0,4,8,12",16)], [2, silence])'],
  ['громкость: gain + velocity', '$K: s("bd").beat("0,4",16).gain(0.5).velocity(0.8)'],
  ['группа: два gain подряд', '$K: s("bd").beat("0",16).gain(0.8).gain(0.5)'],
];

for (const [name, code] of CASES) {
  console.log(`\n=== ${name}`);
  try {
    const result = await runStrudel(code, { cycles: 4 });
    if (!result.ok) {
      console.log(`  ОШИБКА: ${result.error}`);
      continue;
    }
    for (const [part, events] of Object.entries(result.parts)) {
      console.log(`  ${part}: ${events.length} событий`);
      for (const e of events.slice(0, 6)) {
        const begin = Number(e.whole?.begin ?? 0);
        const end = Number(e.whole?.end ?? 0);
        const v = e.value || {};
        const notes = Array.isArray(v.note) ? v.note : (v.note ? [v.note] : []);
        console.log(`    t=${begin.toFixed(4)} dur=${(end - begin).toFixed(4)} ` +
          `${notes.length ? `notes=[${notes.join(' ')}] ` : ''}` +
          `${v.s ? `s=${v.s} ` : ''}${v.gain !== undefined ? `gain=${v.gain} ` : ''}` +
          `${v.velocity !== undefined ? `vel=${v.velocity}` : ''}`);
      }
    }
  } catch (err) {
    console.log(`  ИСКЛЮЧЕНИЕ: ${err?.message || err}`);
  }
}
