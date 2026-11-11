// Проба метрик v2: считаем метрики и скор для эталонного трека и для
// adversarial-фикстур. Эталон должен выигрывать у каждой фикстуры.
//
//   node tests/spike/metrics-v2.probe.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from '../../server/music/compiler/index.js';
import { scoreTrackV2 } from '../../server/music/score-v2.js';
import { analyzeProgression } from '../../server/music/metrics/progression.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

// Эталон: трек, собранный компилятором из нормальной спеки.
//
// Партий ровно шесть — профиль стиля требует 4–6, и лишние партии были бы
// штрафом за аранжировку, не связанным с проверяемым дефектом.
const referenceSpec = {
  meta: { style: 'techno', bpm: 132, key: 'f:minor', seed: 42 },
  harmony: { progressionId: 'techno-minor-i-vi-iv-v', barsPerChord: 2 },
  form: [
    { kind: 'intro', bars: 8, energy: 0.25, roles: { hats: { recipe: 'sparse' }, bass: { recipe: 'sparse' } } },
    {
      kind: 'build',
      bars: 8,
      energy: 0.6,
      roles: { kick: { recipe: 'default' }, hats: { recipe: 'default' }, bass: { recipe: 'default' } },
      transition: { into: 'drop', type: 'riser' },
    },
    {
      kind: 'drop',
      bars: 16,
      energy: 1.0,
      roles: {
        kick: { recipe: 'busy' },
        snare: { recipe: 'busy' },
        hats: { recipe: 'busy' },
        bass: { recipe: 'busy' },
        arp: { recipe: 'busy' },
        pad: { recipe: 'sparse' },
      },
    },
    { kind: 'breakdown', bars: 8, energy: 0.3, roles: { hats: { recipe: 'sparse' }, pad: { recipe: 'sparse' } } },
    {
      kind: 'build',
      bars: 8,
      energy: 0.75,
      roles: { kick: { recipe: 'busy' }, hats: { recipe: 'busy' }, bass: { recipe: 'busy' } },
      transition: { into: 'drop', type: 'riser' },
    },
    {
      kind: 'drop',
      bars: 16,
      energy: 1.0,
      roles: {
        kick: { recipe: 'busy' },
        snare: { recipe: 'busy' },
        hats: { recipe: 'busy' },
        bass: { recipe: 'busy' },
        arp: { recipe: 'busy' },
        pad: { recipe: 'sparse' },
      },
    },
    { kind: 'outro', bars: 8, energy: 0.2, roles: { hats: { recipe: 'sparse' }, bass: { recipe: 'sparse' } } },
  ],
  motif: { degrees: [4, 2, 0, 2], rhythm: 'x ~ x x', transforms: ['sequence'] },
};

async function report(label, code, style) {
  const metrics = await analyzeProgression(code, { cycles: 64, style });
  const score = await scoreTrackV2(code, style);
  console.log(`\n=== ${label} ===`);
  console.log(`  баров: ${metrics.bars}, окон: ${metrics.windows.length}`);
  console.log(
    `  энергия: размах ${metrics.energy.dynamicRange.toFixed(3)} ` +
      `(цель ${metrics.energy.target.join('–')}), сходство с формой ${metrics.energy.formSimilarity.toFixed(3)}`,
  );
  console.log(
    `  гармония: смен ${metrics.harmony.changes} (${metrics.harmony.changesPer4Bars.toFixed(2)} на 4 такта), ` +
      `различных ${metrics.harmony.distinct}, длинная полоса ${metrics.harmony.longestRun}`,
  );
  console.log(
    `  новизна: средняя ${metrics.novelty.mean.toFixed(3)}, максимум ${metrics.novelty.max.toFixed(3)}, ` +
      `доля почти-повторов ${(metrics.novelty.nearRepeatShare * 100).toFixed(0)}%`,
  );
  console.log(
    `  вариативность: средняя ${Object.values(metrics.variability.perPart)
      .map((p) => p.uniqueRatio.toFixed(2))
      .join(', ')}`,
  );
  console.log(
    `  разнообразие: партий ${metrics.diversity.parts}, Жаккар ${metrics.diversity.meanJaccard.toFixed(3)}, ` +
      `макс ${metrics.diversity.maxJaccard.toFixed(3)}`,
  );
  console.log(
    `  автоматизация: ${metrics.automation.automated}/${metrics.automation.total} ` +
      `(${(metrics.automation.ratio * 100).toFixed(0)}%)`,
  );
  console.log(`  СКОР v2: ${score.total} (${score.grade}) — форма: ${score.hasForm ? 'есть' : 'нет'}`);
  const newOnes = score.criteria.filter((c) => c.group !== 'v1');
  for (const c of newOnes) {
    console.log(`    ${c.label}: ${c.points}/${c.weight} (${c.status})`);
  }
  for (const issue of score.issues.slice(0, 4)) {
    console.log(`    ! [${issue.group}] ${issue.label}: ${issue.hint}`);
  }
  return { label, score, metrics };
}

const results = [];

results.push(await report('ЭТАЛОН (скомпилированный трек)', compile(referenceSpec).code, 'techno'));

const fixtures = [
  ['(a) один цикл × 16', 'a-repeated-cycle.js', 'techno'],
  ['(b) ноты вне лада', 'b-out-of-scale.js', 'techno'],
  ['(c) 8 партий одним ритмом', 'c-same-rhythm.js', 'techno'],
  ['(d) статичные параметры', 'd-static-params.js', 'techno'],
];

for (const [label, file, style] of fixtures) {
  const code = await readFile(join(root, 'tests/fixtures/cheat', file), 'utf8');
  results.push(await report(label, code, style));
}

console.log('\n=== СВОДКА ===');
const reference = results[0].score.total;
for (const result of results) {
  const diff = Math.round((result.score.total - reference) * 10) / 10;
  const verdict = result === results[0] ? 'эталон' : diff < 0 ? '✓ ниже эталонa' : '✗ НИЖЕ ЭТАЛОНА НЕ ПОЛУЧИЛОСЬ';
  console.log(`  ${result.label}: ${result.score.total} (${verdict}, Δ=${diff})`);
}
