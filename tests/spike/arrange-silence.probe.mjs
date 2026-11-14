// Локализация: почему роль с `arrange([8, silence], ...)` молчит.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const BPM = 80;
const cases = [
  ['A. одиночная роль без arrange', `
const ms = x => x * (${BPM}/4) / 60000
$K: s("bd").beat("10",16).gain(0.7).late(ms(-4))`],
  ['B. arrange с silence в начале', `
const ms = x => x * (${BPM}/4) / 60000
const KICK_1 = s("bd").beat("10",16).gain(0.7).late(ms(-4))
$K: arrange([8, silence], [12, KICK_1])`],
  ['C. arrange без silence', `
const ms = x => x * (${BPM}/4) / 60000
const KICK_1 = s("bd").beat("10",16).gain(0.7).late(ms(-4))
$K: arrange([12, KICK_1])`],
  ['D. arrange: silence в начале, КОНСТАНТА строкой', `
const KICK_1 = s("bd").beat("10",16).gain(0.7)
$K: arrange([8, silence], [12, KICK_1])`],
  ['E. поздний сдвиг (отрицательный late)', `
const ms = x => x * (${BPM}/4) / 60000
$K: s("bd").beat("10",16).late(ms(-4))`],
  ['F. поздний сдвиг (положительный late)', `
const ms = x => x * (${BPM}/4) / 60000
$K: s("bd").beat("10",16).late(ms(4))`],
  ['G. две роли: одна с silence, другая нет', `
const A_0 = s("bd").beat("10",16).gain(0.7)
$A: arrange([8, silence], [12, A_0])
const B_0 = s("sd").beat("4",16).gain(0.7)
$B: arrange([12, B_0])`],
  ['H. silence как отдельная константа', `
const A_0 = s("bd").beat("10",16).gain(0.7)
$A: arrange([8, silence], [12, A_0])`],
];

for (const [name, code] of cases) {
  const result = await runStrudel(code, { cycles: 16 });
  console.log(`\n=== ${name}`);
  if (!result.ok) {
    console.log(`  ОШИБКА: ${result.error}`);
    continue;
  }
  for (const [part, events] of Object.entries(result.parts)) {
    console.log(`  ${part}: ${events.length} событий → ` +
      events.slice(0, 4).map((e) => Number(e.whole.begin).toFixed(4)).join(' '));
  }
  if (!Object.keys(result.parts).length) console.log('  партий нет');
}
