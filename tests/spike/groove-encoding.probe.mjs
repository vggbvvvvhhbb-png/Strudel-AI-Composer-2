// Спайк: как выразить velocity по шагам и микротайминг в Strudel.
//
// Известно по пробе №1–3:
//   • `.beat("0,7,10",16)` — шаговая сетка 1/16 работает;
//   • `.gain("0.9 0.5")` — строка разбирается mini-парсером и семплится ПО ВРЕМЕНИ,
//     то есть это не «значение на событие», а «значение в такте»;
//   • `.late(ms)` — сдвиг в циклах, работает;
//   • `swingBy(x, n)` — сдвигает каждую вторую 16-ю на x × (длительность пары).
//
// Осталось выяснить: можно ли получить РАЗНУЮ velocity на разных шагах
// и РАЗНЫЙ микротайминг на разных шагах, не размножая партии.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const cases = [
  ['A. gain числом', '$K: s("bd*4").gain(0.8)'],
  ['B. gain строкой на 4 значения', '$K: s("bd*4").gain("1 .75 .5 .25")'],
  ['C. gain строкой на 16 значений', '$K: s("bd*16").gain("1 .5 .75 .5 1 .5 .75 .5 1 .5 .75 .5 1 .5 .75 .5")'],
  ['D. struct с x/~ и gain', '$K: s("bd*4").struct("x ~ x ~").gain("1 .5")'],
  ['E. velocity метод', '$K: s("bd*4").velocity("1 .5 .75 .5")'],
  ['F. late(0.01) сдвиг роли', '$K: s("sd*4").late(0.01)'],
  ['G. late на 4 шагах разного сдвига нельзя — проверяем .off', '$K: s("bd*4").off(0.25, x => x.fast(2))'],
  ['H. swingBy(0.12, 8)', '$K: s("hh*16").swingBy(0.12, 8)'],
  ['I. swingBy + gain', '$K: s("hh*16").swingBy(0.12, 8).gain("1 .5")'],
  ['J. jux/ply для двух голосов', '$K: s("bd*4").ply(2, x => x.fast(2))'],
  ['K. attack/att — артикуляция', '$K: s("bd*4").att(0.01)'],
  ['L. euclid ритм', '$K: s("bd").euclid(3, 8)'],
];

for (const [name, code] of cases) {
  const result = await runStrudel(code, { cycles: 2 });
  console.log(`\n=== ${name}`);
  console.log(`    код: ${code}`);
  if (!result.ok) {
    console.log(`    ОШИБКА: ${result.error}`);
    continue;
  }
  for (const [part, events] of Object.entries(result.parts)) {
    const shown = events.slice(0, 8).map((e) => {
      const t = Number(e.whole?.begin ?? 0);
      const gain = e.value?.gain ?? e.gain ?? '-';
      const vel = e.value?.velocity ?? e.velocity ?? '-';
      return `${t.toFixed(4)}[g=${typeof gain === 'number' ? gain.toFixed(2) : gain} v=${typeof vel === 'number' ? vel.toFixed(2) : vel}]`;
    }).join(' ');
    console.log(`    ${part}: ${events.length} событий → ${shown}`);
  }
}
