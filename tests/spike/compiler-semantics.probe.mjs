// Спайк: семантика gain/velocity, бас из корней, мотивы.
//
// Открытые вопросы:
//   1. `.gain(a).gain(b)` — умножается или второй перезаписывает?
//   2. Можно ли совмещать `.gain()` (громкость) и `.velocity()` (динамика)?
//   3. Бас: `"<Dm9 Gm7>".rootNotes(2).note().struct(...)` — как звучит?
//   4. Мотив: `n("<4 ~ 2 ~>")` провалился (одно событие) — работает ли
//      плоская последовательность `n("4 ~ 2 ~ 5 ~")`?
//   5. Не ломает ли `dict('ireal')` простые трезвучия?

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const cases = [
  ['1a. gain(0.8).gain(0.5)', '$K: s("bd*4").gain(0.8).gain(0.5)'],
  ['1b. gain(0.8).velocity(0.5)', '$K: s("bd*4").gain(0.8).velocity(0.5)'],
  ['1c. velocity(0.5).gain(0.8)', '$K: s("bd*4").velocity(0.5).gain(0.8)'],
  ['2. Бас: корни + struct', '$B: "<Dm9 Gm7>".rootNotes(2).note().struct("x ~ x ~ x ~ x ~")'],
  ['3. Бас: два аккорда по 2 такта', '$B: "<Dm9 Dm9 Gm7 Gm7>".rootNotes(2).note().struct("x ~ x ~ x ~ x ~")'],
  ['4a. Мотив плоский: n("4 ~ 2 ~ 5 ~")', '$L: n("4 ~ 2 ~ 5 ~").scale("D:minor")'],
  ['4b. Мотив в угловых скобках: n("<4 ~ 2 ~>")', '$L: n("<4 ~ 2 ~>").scale("D:minor")'],
  ['4c. Мотив с n() и пустыми слотами', '$L: n("4 ~ ~ ~ 2 ~ ~ ~").scale("D:minor")'],
  ['5a. dict(ireal) на трезвучии Dm', '$C: chord("Dm").dict("ireal").voicing().anchor("c4")'],
  ['5b. dict(ireal) на Dm9', '$C: chord("Dm9").dict("ireal").voicing().anchor("c4")'],
  ['6. Бас с оффбит-ритмом', '$B: "<Dm9 Gm7>".rootNotes(2).note().struct("~ x ~ x ~ x ~ x")'],
  ['7. Пэд: chord + attack/release', '$P: chord("Dm9").voicing().anchor("c4").s("triangle").attack(2.5).release(5)'],
];

for (const [name, code] of cases) {
  const result = await runStrudel(code, { cycles: 4 });
  console.log(`\n=== ${name}`);
  if (!result.ok) {
    console.log(`  ОШИБКА: ${result.error}`);
    continue;
  }
  for (const [part, events] of Object.entries(result.parts)) {
    const shown = events.slice(0, 8).map((e) => {
      const t = Number(e.whole?.begin ?? 0);
      const v = e.value ?? {};
      const bits = [v.s ?? v.note ?? v.chord ?? ''];
      if (v.gain !== undefined) bits.push(`g=${v.gain}`);
      if (v.velocity !== undefined) bits.push(`v=${v.velocity}`);
      return `${t.toFixed(4)}[${bits.join(' ')}]`;
    }).join(' ');
    console.log(`  ${part} (${events.length}): ${shown}`);
  }
}
