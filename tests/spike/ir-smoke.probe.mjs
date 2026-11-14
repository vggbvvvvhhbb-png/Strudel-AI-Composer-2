// Сквозная проверка IR: текст → план → код → события движка.
//
// Проверяем не «красиво ли выглядит код», а главное: компиляция даёт код,
// который ДВИЖОК исполняет, и в котором роли играют ожидаемое.

import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const PROMPTS = [
  'мрачный трип-хоп про дождь',
  'уютный лоуфай для учёбы',
  'эйфоричный фестиваль',
  'злой быстрый dnb',
  'тревожный эмбиент, пустой космос',
];

for (const prompt of PROMPTS) {
  console.log(`\n${'='.repeat(72)}\nЗАПРОС: ${prompt}`);
  const ir = planIR(prompt, { seed: 42 });
  console.log(`жанр=${ir.meta.genre} bpm=${ir.meta.bpm} key=${ir.meta.key.tonic}:${ir.meta.key.mode} ` +
    `mood=${ir.meta.mood.label} groove=${ir.groove.template} секций=${ir.sections.length} ` +
    `баров=${ir.sections.reduce((s, x) => s + x.bars, 0)}`);

  const compiled = compileIR(ir);
  if (compiled.warnings.length) console.log(`предупреждения: ${compiled.warnings.join('; ')}`);

  const result = await runStrudel(compiled.code, { cycles: 64 });
  if (!result.ok) {
    console.log(`ОШИБКА ИСПОЛНЕНИЯ: ${result.error}`);
    console.log(compiled.code);
    continue;
  }
  const bars = ir.sections.reduce((s, x) => s + x.bars, 0);
  console.log(`  тактов: ${bars} · ролей: ${Object.keys(result.parts).length}`);
  for (const [part, events] of Object.entries(result.parts)) {
    const notes = events.filter((e) => e.value?.note).map((e) => e.value.note);
    const samples = events.filter((e) => e.value?.s).map((e) => e.value.s);
    const first = events.slice(0, 4).map((e) => Number(e.whole.begin).toFixed(3)).join(' ');
    console.log(`  ${part.padEnd(8)} событий=${String(events.length).padStart(4)} ` +
      `первые=${first} ${notes.length ? `ноты=${[...new Set(notes)].slice(0, 4).join(',')}` : ''} ` +
      `${samples.length ? `сэмплы=${[...new Set(samples)].slice(0, 3).join(',')}` : ''}`);
  }
  if (PROMPTS[0] === prompt) {
    console.log('\n--- КОД (первый промт) ---\n');
    console.log(compiled.code);
  }
}
