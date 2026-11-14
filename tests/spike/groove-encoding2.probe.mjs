// Проба №2: velocity по шагам, микротайминг по шагам, детерминизм.
//
// Уже измерено (проба №1):
//   • `.beat("0,7,10",16)` → события в шагах 0/7/10 сетки 1/16;
//   • `.gain("a b c")` — значения семплятся ПО ВРЕМЕНИ, а не по событию;
//     поэтому произвольную velocity по шагам так не выразить;
//   • `swingBy(x, n)` сдвигает каждую вторую 16-ю на x × (длительность пары / 2).
//
// Осталось выяснить: как выразить velocity по шагам и разный микротайминг
// по шагам, и — главное — детерминирован ли queryArc.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const BPM = 82;
const MS = `const ms = x => x * (${BPM}/4) / 60000`;

function dump(label, parts, limit = 10) {
  console.log(`  ${label}:`);
  for (const [name, events] of Object.entries(parts)) {
    for (const event of events.slice(0, limit)) {
      const begin = Number(event.whole?.begin ?? 0);
      const value = typeof event.value === 'object' ? JSON.stringify(event.value) : String(event.value);
      console.log(`    t=${begin.toFixed(5)} value=${value}`);
    }
  }
}

async function run(name, code, cycles = 1) {
  const result = await runStrudel(code, { cycles });
  console.log(`\n=== ${name}`);
  if (!result.ok) {
    console.log(`  ОШИБКА: ${result.error}`);
    return null;
  }
  dump('части', result.parts);
  return result;
}

// 1. Константа в коде (компилятор обязан её уметь выдавать).
await run('1. const ms в коде + late(ms(12))', `${MS}\n$K: s("sd").beat("4,12",16).late(ms(12))`);

// 2. late с паттерном — вдруг умеет пошагово.
await run('2. late("<0 0.02>") — пошагово?', '$K: s("bd").beat("0,7,10",16).late("<0 0.02 0>")');

// 3. Velocity через выровненную 16-слотовую сетку чисел.
await run('3. gain(mini("0.9 ~ ... 0.8 ~ ...")) — выровнено по шагам',
  '$K: s("bd").beat("0,7,10",16).gain(mini("0.9 ~ ~ ~ ~ ~ 0.5 ~ ~ ~ ~ 0.8 ~ ~ ~ ~"))');

// 4. Velocity через n() со степенями — числа ли это вообще.
await run('4. gain(n("...")) — числа?', '$K: s("bd").beat("0,7,10",16).gain(n("0 1 2"))');

// 5. Velocity через pure().
await run('5. gain(pure(0.8))', '$K: s("bd").beat("0,7,10",16).gain(pure(0.8))');

// 6. Velocity методом .velocity().
await run('6. .velocity()', '$K: s("bd").beat("0,7,10",16).velocity(0.7)');

// 7. Разный микротайминг по шагам: отдельные паттерны на каждую группу.
await run('7. Разный late на разных шагах (две группы)',
  '$K: s("bd").beat("0,10",16).late(ms(0))\n$S: s("bd").beat("7",16).late(ms(6))');

// 8. Формат .beat: через запятую и через пробел.
await run('8a. .beat("0,7,10",16)', '$K: s("bd").beat("0,7,10",16)');
await run('8b. .beat("0 7 10",16)', '$K: s("bd").beat("0 7 10",16)');

// 9. Детерминизм: одинаковый код дважды — совпадают ли времена?
{
  const code = '$K: s("hh*16").degradeBy(.2).swingBy(.12, 8)';
  const first = await runStrudel(code, { cycles: 4 });
  const second = await runStrudel(code, { cycles: 4 });
  if (first.ok && second.ok) {
    const t1 = first.parts.K.map((e) => Number(e.whole.begin).toFixed(6)).join(',');
    const t2 = second.parts.K.map((e) => Number(e.whole.begin).toFixed(6)).join(',');
    console.log('\n=== 9. Детерминизм degradeBy: два прогона совпали?');
    console.log(`  прогон 1: ${t1.slice(0, 80)}`);
    console.log(`  прогон 2: ${t2.slice(0, 80)}`);
    console.log(`  СОВПАДАЮТ: ${t1 === t2 ? 'ДА' : 'НЕТ'}`);
  }
}

// 10. Детерминизм без случайности.
{
  const code = '$K: s("bd").beat("0,4,8,12",16).swingBy(.12, 8)';
  const a = await runStrudel(code, { cycles: 4 });
  const b = await runStrudel(code, { cycles: 4 });
  console.log('\n=== 10. Детерминизм без случайности');
  if (a.ok && b.ok) {
    const t1 = a.parts.K.map((e) => Number(e.whole.begin).toFixed(6)).join(',');
    const t2 = b.parts.K.map((e) => Number(e.whole.begin).toFixed(6)).join(',');
    console.log(`  СОВПАДАЮТ: ${t1 === t2 ? 'ДА' : 'НЕТ'}`);
  }
}
