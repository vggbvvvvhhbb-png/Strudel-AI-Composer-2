// Спайк: финальная проверка схемы кодирования грува.
//
// Схема: одна роль = stack() из групп. Группа = (шаги, velocity, сдвиг мс).
//   s("<sample>").beat("<steps>",16).gain(<v>).late(<циклы>)
// Свинг — модификатор роли целиком: .swingBy(2s−1, n).

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const cases = [
  [
    'A. stack двух групп кика (velocity и шаги разные)',
    '$K: stack(s("bd").beat("0",16).gain(.95), s("bd").beat("7,10",16).gain(.6))',
  ],
  [
    'B. stack + свинг роли',
    '$H: stack(s("hh").beat("0,2,4,6,8,10,12,14",16).gain(.6)).swingBy(.12, 8)',
  ],
  [
    'C. stack + сдвиг мс (late)',
    '$S: stack(s("sd").beat("4",16).gain(.85).late(0.0041), s("sd").beat("12",16).gain(.8).late(0.0041))',
  ],
  [
    'D. Группа со СВОИМ сдвигом на шаг (пьяный грув)',
    '$K: stack(s("bd").beat("0",16).gain(.95).late(0), s("bd").beat("7",16).gain(.8).late(0.0041), s("bd").beat("10",16).gain(.7).late(-0.0027))',
  ],
  [
    'E. Константы и arrange по секциям',
    'const KICK_0 = stack(s("bd").beat("0",16).gain(.9))\nconst KICK_1 = stack(s("bd").beat("0,7,10",16).gain(.9))\n$K: arrange([4, KICK_0], [4, KICK_1])',
  ],
  [
    'F. Бас из корней аккорда + note',
    'const BASS_0 = "<Dm9 Gm7>".rootNotes(2).note().s("sawtooth").lpf(400)\n$B: arrange([4, BASS_0])',
  ],
  [
    'G. Аккорды с войсингом в константе',
    'const CH_0 = chord("<Dm9 Gm7>").dict("ireal").voicing().anchor("c4").s("gm_electric_piano_1").lpf(1800)\n$C: arrange([4, CH_0])',
  ],
  [
    'H. Лид: степени лада в константе',
    'const L_0 = n("<4 ~ 2 ~ 5 ~ 3 ~>").scale("D:minor").s("gm_vibraphone").degradeBy(.3)\n$L: arrange([4, L_0])',
  ],
  [
    'I. Пэды с lpF-рампой через sine (сигнал)',
    'const P_0 = chord("<Dm9 Gm7>").voicing().lpf(sine.range(600, 3500).slow(8)).seg(16)\n$P: arrange([8, P_0])',
  ],
  [
    'J. Сайдчейн: duckorbit/duckdepth на роли',
    '$B: stack(s("bd").beat("0,7,10",16).gain(.9)).duckorbit(2).duckdepth(.6).duckattack(.15)',
  ],
];

for (const [name, code] of cases) {
  const result = await runStrudel(code, { cycles: 4 });
  console.log(`\n=== ${name}`);
  if (!result.ok) {
    console.log(`  ОШИБКА: ${result.error}`);
    continue;
  }
  for (const [part, events] of Object.entries(result.parts)) {
    const shown = events.slice(0, 10).map((e) => {
      const t = Number(e.whole?.begin ?? 0);
      const gain = e.value?.gain ?? e.gain ?? '-';
      const value = e.value?.note ?? e.value?.s ?? e.value?.chord ?? '';
      return `${t.toFixed(4)}:${value}${typeof gain === 'number' ? ` g=${gain.toFixed(2)}` : ''}`;
    }).join('  ');
    console.log(`  ${part} (${events.length}): ${shown}`);
  }
}
