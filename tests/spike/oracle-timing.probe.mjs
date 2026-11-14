// Спайк: сколько стоит символьный оракул.
//
// Вопрос: можно ли прогонять сотни кандидатов в секунду (бриф §6:
// «≤50 мс на 32 такта, ≥200 кандидатов/с»).
//
// Три пути:
//   1. queryArc по скомпилированному коду (Strudel, без звука) — точность
//      максимальная, но цена неизвестна;
//   2. вычисление событий прямо из IR (без движка) — мгновенно, но нужно
//      доказать, что совпадает с движком;
//   3. чтение уже построенных событий из IR без компиляции.
//
// Меряем: время первого вызова (со загрузкой движка), время повторных.

import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const PROMPT = 'мрачный трип-хоп про дождь';
const ir = planIR(PROMPT, { seed: 42 });
const compiled = compileIR(ir);
const bars = ir.sections.reduce((sum, s) => sum + s.bars, 0);

console.log(`трек: ${bars} тактов, ролей: ${compiled.roles.length}`);

// --- 1. queryArc через движок ---
for (const cycles of [32, 64]) {
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    const t0 = performance.now();
    const result = await runStrudel(compiled.code, { cycles });
    const dt = performance.now() - t0;
    samples.push(dt);
    if (i === 0) {
      const events = Object.values(result.parts).reduce((sum, p) => sum + p.length, 0);
      console.log(`\nqueryArc ${cycles} тактов: событий ${events}, ok=${result.ok}`);
    }
  }
  const warm = samples.slice(1);
  const mean = warm.reduce((a, b) => a + b, 0) / warm.length;
  console.log(`  первый вызов ${samples[0].toFixed(1)} мс · тёплые среднее ${mean.toFixed(1)} мс · ` +
    `мин ${Math.min(...warm).toFixed(1)} мс · кандидатов/с ${(1000 / mean).toFixed(1)}`);
}

// --- 2. Компиляция сама по себе ---
const compileSamples = [];
for (let i = 0; i < 50; i += 1) {
  const t0 = performance.now();
  compileIR(ir);
  compileSamples.push(performance.now() - t0);
}
const compileMean = compileSamples.reduce((a, b) => a + b, 0) / compileSamples.length;
console.log(`\ncompileIR: ${compileMean.toFixed(3)} мс · кандидатов/с ${(1000 / compileMean).toFixed(0)}`);

// --- 3. Полный конвейер: план → компиляция → события ---
const pipelineSamples = [];
for (let i = 0; i < 10; i += 1) {
  const t0 = performance.now();
  const candidate = planIR(PROMPT, { seed: 1000 + i });
  const code = compileIR(candidate).code;
  await runStrudel(code, { cycles: 32 });
  pipelineSamples.push(performance.now() - t0);
}
const pipelineMean = pipelineSamples.slice(1).reduce((a, b) => a + b, 0) / (pipelineSamples.length - 1);
console.log(`полный конвейер (план→код→события, 32 такта): ${pipelineMean.toFixed(1)} мс · ` +
  `кандидатов/с ${(1000 / pipelineMean).toFixed(1)}`);
