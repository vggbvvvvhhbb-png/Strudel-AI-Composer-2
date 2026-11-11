// Проба пайплайна compose: модель отвечает заранее prepared-ответом,
// поэтому проверяется вся цепочка без обращения к сети.
//
//   node tests/spike/compose-pipeline.probe.mjs

import { buildTrack, detectSpecStyle, extractJson, fallbackSpec } from '../../server/music/compose/pipeline.js';
import { collectRemarks, applyRemark } from '../../server/music/compose/remarks.js';
import { refineSpec } from '../../server/music/compose/refine.js';
import { checkSpec } from '../../server/music/spec/check.js';
import { compile } from '../../server/music/compiler/index.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const events = [];

// Модель-заглушка: сначала отдаёт невалидную спеку, потом — валидную.
let call = 0;
const completeChat = async () => {
  call += 1;
  if (call === 1) {
    return JSON.stringify({
      meta: { style: 'techno', bpm: 200, key: 'не-ключ' }, // bpm вне диапазона, ключ мусор
      harmony: { degrees: [0, 5, 2, 6] },
      form: [{ kind: 'intro', bars: 8, energy: 0.5, roles: { kick: { recipe: 'default' } } }],
    });
  }
  return JSON.stringify({
    meta: { style: 'techno', bpm: 132, key: 'f:minor', seed: 42 },
    harmony: { progressionId: 'techno-minor-i-vi-iv-v', barsPerChord: 2 },
    form: [
      { kind: 'intro', bars: 8, energy: 0.25, roles: { hats: { recipe: 'sparse' }, bass: { recipe: 'sparse' } } },
      { kind: 'build', bars: 8, energy: 0.6, roles: { kick: { recipe: 'default' }, hats: { recipe: 'default' }, bass: { recipe: 'default' } }, transition: { into: 'drop', type: 'riser' } },
      { kind: 'drop', bars: 16, energy: 1.0, roles: { kick: { recipe: 'busy' }, snare: { recipe: 'busy' }, hats: { recipe: 'busy' }, bass: { recipe: 'busy' }, arp: { recipe: 'busy' } } },
      { kind: 'outro', bars: 8, energy: 0.2, roles: { hats: { recipe: 'sparse' }, texture: { recipe: 'sparse' } } },
    ],
    motif: { degrees: [4, 2, 0, 2], rhythm: 'x ~ x x' },
    reasoning: 'Плотный техно с дропом на 16 тактов.',
  });
};

console.log('--- 1. определение стиля ---');
for (const text of ['спокойный lo-fi с пианино', 'жёсткий техно 132', 'drum and bass нейро', 'кинематографичный эмбиент']) {
  console.log(`  "${text}" → ${detectSpecStyle(text)}`);
}

console.log('--- 2. разбор JSON из ответа модели ---');
console.log('  чистый JSON:', JSON.stringify(extractJson('{"a":1}')));
console.log('  в обёртке:', JSON.stringify(extractJson('```json\n{"a":2}\n```')));
console.log('  с текстом вокруг:', JSON.stringify(extractJson('Вот план: {"a":3} готово')));
console.log('  мусор:', JSON.stringify(extractJson('не json вовсе')));

console.log('--- 3. пайплайн: невалидная спека → retry → валидная ---');
const built = await buildTrack({
  prompt: 'жёсткий техно с дропом',
  style: 'techno',
  completeChat,
  seed: 42,
  onEvent: (event, payload) => events.push({ event, payload }),
});
console.log(`  попыток модели: ${built.attempts}, запасной план: ${built.usedFallback}`);
console.log(`  события: ${events.map((e) => e.event).join(' → ')}`);
console.log(`  секций: ${built.compiled.sections.length}, строк кода: ${built.compiled.code.split('\n').length}`);
console.log(`  части: ${built.compiled.parts.map((p) => p.label).join(', ')}`);

console.log('--- 4. скомпилированный код исполняется? ---');
const run = await runStrudel(built.compiled.code, { cycles: 32 });
console.log(`  ok=${run.ok} партий=${run.order.length} ошибка=${run.error || 'нет'}`);
for (const name of run.order) {
  console.log(`    $${name}: событий ${run.parts[name].length}`);
}

console.log('--- 5. запасная спека валидна? ---');
const fb = fallbackSpec('techno', 7);
const fbCheck = checkSpec(fb);
console.log(`  ok=${fbCheck.ok} ошибки=${fbCheck.errors.join('; ') || 'нет'}`);
const fbCode = compile(fb).code;
const fbRun = await runStrudel(fbCode, { cycles: 32 });
console.log(`  исполняется: ok=${fbRun.ok} партий=${fbRun.order.length}`);

console.log('--- 6. замечания к спеке ---');
const flatSpec = {
  meta: { style: 'techno', bpm: 132, key: 'f:minor' },
  harmony: { progressionId: 'techno-minor-i-vi-iv-v', barsPerChord: 2 },
  form: [
    { kind: 'intro', bars: 8, energy: 0.5, roles: { kick: { recipe: 'default' } } },
    { kind: 'drop', bars: 8, energy: 0.5, roles: { kick: { recipe: 'default' } } },
  ],
};
const remarks = collectRemarks(flatSpec);
console.log(`  замечаний: ${remarks.length}`);
for (const r of remarks) console.log(`    [${r.kind}] ${r.label}: ${r.hint}`);

console.log('--- 7. применение замечания ---');
const patched = applyRemark(flatSpec, remarks.find((r) => r.kind === 'flat-energy'));
console.log(`  энергии после правки: ${patched.form.map((s) => s.energy).join(', ')}`);
console.log(`  валидна: ${checkSpec(patched).ok}`);

console.log('--- 8. refine-цикл по спеке ---');
const refine = await refineSpec({
  spec: flatSpec,
  scoreFn: (code) => ({ total: code.length, issues: [] }),
  maxIterations: 2,
});
console.log(`  шагов: ${refine.steps.length}, улучшено: ${refine.improved}`);
for (const s of refine.steps) console.log(`    ${s.applied ? '✓' : '·'} ${s.reason || s.remark?.label} (${s.score})`);
