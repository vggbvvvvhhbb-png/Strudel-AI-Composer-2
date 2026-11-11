// Проба для метрик v2: что реально лежит в событиях Strudel.
//
//   node tests/spike/metrics-probe.mjs
//
// Вопросы:
//   1. Даёт ли транспилятор AST (а не только output)?
//   2. Что в hap.value у разных партий?
//   3. Видно ли в hap.value значение параметра (lpf, room)?
//   4. Меняется ли gain от события к событию при автоматизации?

import { loadStrudel, runStrudel } from '../../server/music/strudel-runtime.mjs';

const api = await loadStrudel();

console.log('--- 1. транспилятор: что возвращает ---');
const sample = `
setCpm(120/4)
const key = "f:minor"
const BASS_0 = n("<0 5 3 4>").scale(key).slow(2).ply(2).s("sawtooth").lpf(600)
$KICK: s("bd*4").gain(0.9)._scope()
$BASS: arrange([8, BASS_0]).gain(0.7)._pianoroll()
`;
try {
  const result = api.transpiler(sample);
  console.log('  ключи результата:', Object.keys(result));
  for (const [key, value] of Object.entries(result)) {
    const kind = Array.isArray(value) ? `массив(${value.length})` : typeof value;
    console.log(`    ${key}: ${kind}`);
  }
  if (result.ast) {
    console.log('  AST доступен, тип узла:', result.ast.type);
  }
  console.log('  output (первые 300 символов):');
  console.log(String(result.output).split('\n').slice(0, 12).map((l) => `    ${l}`).join('\n'));
} catch (err) {
  console.log('  ошибка:', err.message);
}

console.log('\n--- 2. hap.value у разных партий ---');
const run = await runStrudel(sample, { cycles: 4 });
console.log('  ok:', run.ok, 'партий:', run.order.join(', '));
for (const name of run.order) {
  const haps = run.parts[name];
  console.log(`  $${name}: ${haps.length} событий`);
  for (const hap of haps.slice(0, 3)) {
    console.log(`    begin=${hap.whole?.begin} dur=${hap.whole?.end - hap.whole?.begin} value=${JSON.stringify(hap.value)}`);
  }
}

console.log('\n--- 3. видно ли значение lpf/room в hap.value? ---');
const withFx = await runStrudel(`
setCpm(120/4)
const key = "f:minor"
$MEL: n("<0 2 4>").scale(key).s("sawtooth").lpf(600).room(0.5).gain(0.7)._pianoroll()
`, { cycles: 2 });
const melHap = withFx.parts.MEL?.[0];
console.log('  value:', JSON.stringify(melHap?.value));
console.log('  полный hap:', JSON.stringify(melHap));

console.log('\n--- 4. автоматизация: gain меняется от события к событию? ---');
const auto = await runStrudel(`
setCpm(120/4)
const key = "f:minor"
$SWEEP: n("<0 2 4>").scale(key).s("sawtooth").gain(sine.slow(4).range(0.2, 0.9))._pianoroll()
$STATIC: n("<0 2 4>").scale(key).s("sawtooth").gain(0.5)._pianoroll()
`, { cycles: 8 });
for (const name of ['SWEEP', 'STATIC']) {
  const gains = (auto.parts[name] || []).map((h) => h.value?.gain).filter((g) => g !== undefined);
  const unique = [...new Set(gains.map((g) => Math.round(g * 1000) / 1000))];
  console.log(`  $${name}: значений gain ${gains.length}, уникальных ${unique.length}`);
  console.log(`    первые: ${gains.slice(0, 8).map((g) => Math.round(g * 100) / 100).join(', ')}`);
}

console.log('\n--- 5. чечедующийся паттерн в параметре ---');
const alt = await runStrudel(`
setCpm(120/4)
$ALT: s("bd*4").gain("<0.3 0.9>")._scope()
`, { cycles: 4 });
const altGains = (alt.parts.ALT || []).map((h) => h.value?.gain).filter((g) => g !== undefined);
console.log('  gain:', altGains.map((g) => Math.round(g * 100) / 100).join(', '));
console.log('  уникальных:', [...new Set(altGains)].length);

console.log('\n--- 6. pitch class: как достать высоту ---');
const pitches = await runStrudel(`
setCpm(120/4)
const key = "f:minor"
$NOTE: n("0 2 4").scale(key)._pianoroll()
`, { cycles: 2 });
console.log('  значения:', JSON.stringify((pitches.parts.NOTE || []).slice(0, 4).map((h) => h.value)));
