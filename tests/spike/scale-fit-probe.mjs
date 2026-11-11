// Диагностика: почему трек вне лада набирает высокий балл.
//
//   node tests/spike/scale-fit-probe.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeTrackFromEvents } from '../../server/music/metrics/events.js';
import { scoreTrack } from '../../server/music/score.js';
import { resolveProfile } from '../../server/music/references.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const code = await readFile(join(root, 'tests/fixtures/cheat/b-out-of-scale.js'), 'utf8');
const analysis = await analyzeTrackFromEvents(code, { cycles: 8 });
const profile = resolveProfile('techno');
const score = scoreTrack(analysis, profile);

console.log('key:', JSON.stringify(analysis.key));
console.log('detectedKey:', analysis.detectedKey);
console.log('scaleFit:', analysis.metrics.scaleFit);
console.log('outsideScale:', JSON.stringify(analysis.outsideScale));
console.log('noteCount:', analysis.metrics.noteCount);
console.log('parts:', analysis.parts.map((p) => `${p.label}:${p.role}:${p.noteCount}`).join(', '));
console.log('');
console.log('критерии:');
for (const c of score.criteria) {
  console.log(`  ${c.label}: значение ${c.value} · цель ${c.targetText} · балл ${c.points}/${c.weight} (${c.status})`);
}
console.log('');
console.log('итого:', score.total, score.grade);
