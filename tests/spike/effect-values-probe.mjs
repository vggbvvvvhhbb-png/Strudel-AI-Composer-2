// Проба фазы 4: значения параметров эффектов лежат в событии (D-008).
// Отсюда взято решение считать автоматизацию по hap.value, а не по тексту кода.
import { runStrudel } from '../../server/music/strudel-runtime.mjs';
import { compile } from '../../server/music/compiler/index.js';

const keysOf = (haps) => {
  const set = new Set();
  for (const h of haps) for (const k of Object.keys(h.value || {})) set.add(k);
  return [...set];
};

const variation = (haps, key) => {
  const vals = new Set();
  for (const h of haps) if (h.value && key in h.value) vals.add(JSON.stringify(h.value[key]));
  return vals.size;
};

console.log('=== отдельные эффекты ===');
for (const code of [
  '$X: s("bd*4").delay(0.3)',
  '$X: s("bd*4").room(0.5)',
  '$X: s("bd*4").pan(0.2)',
  '$X: s("bd*4").speed(2)',
  '$X: n("c4 e4 g4").scale("c:minor").gain(0.4)',
  '$X: n("0 2 4").scale("c:minor").lpf(saw.slow(4).range(300,7000))',
]) {
  const res = await runStrudel(code, { cycles: 4 });
  const haps = res.parts.X || [];
  console.log(`${code}`);
  console.log(`  keys=${JSON.stringify(keysOf(haps))} value=${JSON.stringify(haps[0]?.value)}`);
}

console.log('\n=== скомпилированный трек: ключи и вариативность ===');
const SPEC = {
  meta: { style: 'techno', bpm: 128, key: 'Cmin' },
  structure: { sections: [
    { name: 'intro', cycles: 8, energy: 0.3, harmony: 'Cm Ab Fm Gm' },
    { name: 'build', cycles: 16, energy: 0.65, harmony: 'Fm Cm Ab Gm', parameters: { cutoff: [300, 7000] } },
    { name: 'drop', cycles: 16, energy: 1, harmony: 'Cm Ab Fm Gm', parameters: { gain: [0.5, 1] } },
    { name: 'outro', cycles: 8, energy: 0.2, harmony: 'Cm Ab Fm Gm' },
  ] },
  parts: { roles: {
    kick: { activeIn: ['intro', 'build', 'drop', 'outro'], pattern: 'bd*4', sound: 's' },
    bass: { activeIn: ['intro', 'build', 'drop'], pattern: '0 ~ 2 4', sound: 'sawtooth' },
    hats: { activeIn: ['build', 'drop'], pattern: 'hh*8', sound: 's' },
  } },
};
const { code } = compile(SPEC);
const res = await runStrudel(code, { cycles: 48 });
for (const [name, haps] of Object.entries(res.parts)) {
  const keys = keysOf(haps);
  const vars = Object.fromEntries(keys.map((k) => [k, variation(haps, k)]));
  console.log(`${name}: haps=${haps.length} keys=${JSON.stringify(keys)} distinct=${JSON.stringify(vars)}`);
  // Покажем 2 значения gain/cutoff из хвоста (бар 14-15 = build tail)
  const tail = haps.filter((h) => h.whole.begin >= 14 && h.whole.begin < 16).slice(0, 3);
  console.log('   tail:', JSON.stringify(tail.map((h) => h.value)));
}

console.log('\n=== мини-нотация: имена нот ===');
{
  const r = await runStrudel('$X: n("c4 e4 g4")', { cycles: 2 });
  console.log(JSON.stringify(r.parts.X?.[0]?.value));
}
{
  const r = await runStrudel('$X: n("<c4 db4>")', { cycles: 2 });
  console.log(JSON.stringify(r.parts.X?.[0]?.value));
}
