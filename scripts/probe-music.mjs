// Быстрая проверка ядра разбора на пресетах: node scripts/probe-music.mjs
import { analyzeTrack } from '../server/music/features.js';
import { scoreTrack } from '../server/music/score.js';
import { resolveProfile } from '../server/music/references.js';
import { PRESETS } from '../src/presets/index.js';

for (const preset of PRESETS) {
  const analysis = analyzeTrack(preset.code);
  const profile = resolveProfile(preset.id, `${preset.name} ${preset.tags.join(' ')}`);
  const score = scoreTrack(analysis, profile);
  console.log(`\n=== ${preset.name} → профиль ${profile.id} → ${score.total} (${score.grade})`);
  console.log(
    `bpm=${analysis.bpm} key=${analysis.key?.name} parts=${analysis.metrics.partCount} ` +
      `density=${analysis.metrics.density} offbeat=${analysis.metrics.offbeat.toFixed(2)} ` +
      `scaleFit=${analysis.metrics.scaleFit} range=${analysis.metrics.range} ` +
      `sep=${analysis.metrics.separation} motion=${analysis.metrics.motion} ` +
      `space=${analysis.metrics.space.toFixed(2)} variety=${analysis.metrics.rhythmVariety.toFixed(2)}`,
  );
  for (const c of score.criteria) {
    console.log(`   ${c.label.padEnd(26)} ${String(c.value).padStart(7)} | цель ${c.targetText.padEnd(30)} | ${c.score.toFixed(2)} (${c.points} из ${c.weight})`);
  }
  if (analysis.errors.length) console.log('   ОШИБКИ РАЗБОРА:', analysis.errors);
}
