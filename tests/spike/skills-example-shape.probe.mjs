// Проба: сколько событий даёт n()/note()/s() за 2 цикла.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const voices = [
  ['n("0 2 4")', `$: n("0 2 4")`],
  ['n("<0 2 4>")', `$: n("<0 2 4>")`],
  ['n("0 2 4").scale("D:minor")', `$: n("0 2 4").scale("D:minor")`],
  ['note("c3 e3 g3")', `$: note("c3 e3 g3")`],
  ['s("bd*2")', `$: s("bd*2")`],
  ['n("0 2 4") cycles=1', `$: n("0 2 4")`],
];

for (const [label, voice] of voices) {
  for (const cycles of [1, 2, 4]) {
    const out = await runStrudel(voice, { cycles });
    const events = Object.values(out.parts).flat();
    const begins = events.map((e) => e.whole?.begin);
    console.log(`${label.padEnd(28)} cycles=${cycles} events=${String(events.length).padStart(3)} begins=${JSON.stringify(begins.slice(0, 8))}`);
  }
}
