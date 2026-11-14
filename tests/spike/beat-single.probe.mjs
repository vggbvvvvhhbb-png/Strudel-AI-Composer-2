// Спайк: одиночный шаг в .beat и «плотность» шаблона.
//
// Из пробы IR: роль с ОДНИМ шагом (`beat("10",16)`) не дала ни одного
// события. Проверяем, как .beat понимает список из одного элемента.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const cases = [
  ['одиночный шаг "10"', '$K: s("bd").beat("10",16)'],
  ['два шага "10,12"', '$K: s("bd").beat("10,12",16)'],
  ['одиночный шаг "0"', '$K: s("bd").beat("0",16)'],
  ['"0,0" — дубликат шага', '$K: s("bd").beat("0,0",16)'],
  ['шаг через пробел', '$K: s("bd").beat("10 12",16)'],
  ['"10,12" + late', '$K: s("bd").beat("10,12",16).late(0.004)'],
];

for (const [name, code] of cases) {
  const result = await runStrudel(code, { cycles: 4 });
  console.log(`\n=== ${name}: ${code}`);
  if (!result.ok) {
    console.log(`  ОШИБКА: ${result.error}`);
    continue;
  }
  const events = result.parts.K || [];
  console.log(`  событий: ${events.length} → ` +
    events.slice(0, 6).map((e) => Number(e.whole.begin).toFixed(4)).join(' '));
}
