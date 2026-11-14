// Диагностика планировщика: какой промпт даёт невалидный IR.

import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';

const PROMPTS = [
  'мрачный трип-хоп про дождь',
  'уютный лоуфай для учёбы',
  'эйфоричный фестиваль',
  'злой быстрый dnb',
  'тревожный эмбиент, пустой космос',
  'нежная колыбельная',
  'меланхолия осеннего города',
  'ностальгическая кассета из 90-х',
  'светлый синтипоп для вечеринки',
  'агрессивный фонк',
];

for (const prompt of PROMPTS) {
  try {
    const ir = planIR(prompt, { seed: 1 });
    const compiled = compileIR(ir);
    console.log(`OK   ${prompt.padEnd(38)} жанр=${ir.meta.genre} bpm=${ir.meta.bpm} ` +
      `key=${ir.meta.key.tonic}:${ir.meta.key.mode} mood=${ir.meta.mood.label} ` +
      `ролей=${compiled.roles.length} секций=${compiled.sections.length}`);
    if (compiled.warnings.length) console.log(`     предупреждения: ${compiled.warnings.join('; ')}`);
  } catch (err) {
    console.log(`FAIL ${prompt}`);
    console.log(String(err?.message || err).slice(0, 1200));
  }
}
