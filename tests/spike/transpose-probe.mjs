// Проба: как транспонировать партию в Strudel.
//
//   node tests/spike/transpose-probe.mjs
//
// Вопросы:
//   1. Работает ли `.transpose(-24)` после `.scale(key)`?
//   2. Меняется ли фактическая высота?
//   3. Работает ли `.transpose()` до `.scale(key)`?

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

async function show(label, code) {
  const run = await runStrudel(code, { cycles: 2 });
  const part = run.order[0];
  const notes = (run.parts[part] || []).map((h) => h.value?.note).filter(Boolean);
  console.log(`  ${label}: ${notes.slice(0, 4).join(', ')} (${notes.length} нот)`);
}

console.log('--- 1. transpose после scale ---');
await show('scale + transpose(-24)', `
const key = "f:minor"
$BASS: n("<0 5>").scale(key).transpose(-24).s("sawtooth")._pianoroll()
`);

console.log('--- 2. без транспозиции (для сравнения) ---');
await show('только scale', `
const key = "f:minor"
$BASS: n("<0 5>").scale(key).s("sawtooth")._pianoroll()
`);

console.log('--- 3. transpose до scale ---');
await show('transpose(-24) + scale', `
const key = "f:minor"
$BASS: n("<0 5>").transpose(-24).scale(key).s("sawtooth")._pianoroll()
`);

console.log('--- 4. transpose(+12) для арпеджио ---');
await show('scale + transpose(+12)', `
const key = "f:minor"
$ARP: n("0 2 4").scale(key).transpose(12).s("square")._pianoroll()
`);

console.log('--- 5. add() и transpose вместе ---');
await show('add + scale + transpose', `
const key = "f:minor"
$ARP: n("0 2 4").fast(2).add(n("<0 5 3 4>").slow(2)).scale(key).transpose(12).s("square")._pianoroll()
`);

console.log('--- 6. транспозиция с .slow() ---');
await show('scale + slow(2) + transpose(-24)', `
const key = "f:minor"
$BASS: n("<0 5 3 4>").scale(key).slow(2).transpose(-24).s("sawtooth")._pianoroll()
`);
