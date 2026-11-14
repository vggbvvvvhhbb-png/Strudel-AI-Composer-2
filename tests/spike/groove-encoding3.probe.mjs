// Проба №3: velocity внутри mini-нотации и выразительность ролей.
//
// Из пробы №2: `.gain("...")` семплится по времени, `late` с паттерном пошагово
// не работает, `const ms = ...` в коде допустим, queryArc детерминирован.
//
// Вопросы:
//   1. Есть ли velocity прямо в mini-нотации (`bd@0.9`)?
//   2. Работает ли `.beat()` для нотных ролей (бас), а не только сэмплов?
//   3. Что даёт `weight()`?
//   4. Можно ли получить число-паттерн для gain из строки без ведущей точки?

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

async function run(name, code, cycles = 1) {
  const result = await runStrudel(code, { cycles });
  console.log(`\n=== ${name}`);
  if (!result.ok) {
    console.log(`  ОШИБКА: ${result.error}`);
    return;
  }
  for (const [part, events] of Object.entries(result.parts)) {
    for (const event of events.slice(0, 6)) {
      const begin = Number(event.whole?.begin ?? 0);
      const value = typeof event.value === 'object' ? JSON.stringify(event.value) : String(event.value);
      console.log(`  ${part}: t=${begin.toFixed(5)} value=${value}`);
    }
  }
}

// 1. Velocity в mini-нотации.
await run('1a. s("bd@0.9 ~ ~ ~ bd@0.5 ~ ~ ~")', '$K: s("bd@0.9 ~ ~ ~ bd@0.5 ~ ~ ~")');
await run('1b. s("bd@3 ~ ~ ~ bd@1 ~ ~ ~")', '$K: s("bd@3 ~ ~ ~ bd@1 ~ ~ ~")');
await run('1c. n("0@0.9 2@0.5")', '$K: n("0@0.9 2@0.5")');

// 2. .beat() на нотной роли.
await run('2. note("c2").beat("0,7,10",16)', '$B: note("c2").beat("0,7,10",16)');

// 3. weight().
await run('3. s("bd").weight(0.5)', '$K: s("bd").weight(0.5)');

// 4. Числа в mini без ведущей точки и с ней — как gain.
await run('4a. gain("0.9 0.5")', '$K: s("bd").beat("0,7",16).gain("0.9 0.5")');
await run('4b. gain(".9 .5")', '$K: s("bd").beat("0,7",16).gain(".9 .5")');

// 5. Структура из 16 слотов с весами — самый вероятный кандидат на velocity.
await run('5. s("bd@0.9 ~ ~ ~ ~ ~ ~ ~ bd@0.5 ~ ~ ~ ~ ~ ~ ~")', '$K: s("bd@0.9 ~ ~ ~ ~ ~ ~ ~ bd@0.5 ~ ~ ~ ~ ~ ~ ~")');

// 6. Несколько партий с метками — различаются ли они в реестре.
await run('6. Две метки', '$KICK: s("bd*4")\n$SNARE: s("sd*2")');

// 7. Секции: arrange с метками.
await run('7. arrange по секциям', '$K: arrange("[4, s(\\"bd*4\\")]","[4, s(\\"bd*2\\")]")');
