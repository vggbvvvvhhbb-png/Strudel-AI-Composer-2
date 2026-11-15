// Вспомогательный осмотр: печатает скомпилированный код экспансии (для отладки).
import { specFromPlan } from '../src/music/expand.js';
import { compileTrackSpec } from '../server/music/compiler/index.js';
import { validateTrackSpec } from '../src/schemas/track-spec.schema.js';

const plan = {
  style: 'cinematic', key: 'Cmin', bpm: 90,
  sections: [
    { name: 'intro', bars: 8, energy: 0.3, harmony: 'Cm' },
    { name: 'drop', bars: 16, energy: 0.9, harmony: 'Cm' },
  ],
  groups: [
    { group: 'strings', role: 'violin', count: 3 },
    { group: 'keys', role: 'piano', count: 2 },
    { group: 'choir', role: 'choir_soprano', count: 2 },
  ],
};

const { spec: raw } = specFromPlan(plan);
const spec = validateTrackSpec(raw);
const code = compileTrackSpec(spec);
console.log(code.split('\n').slice(0, 24).map((line, i) => `${i + 1}: ${line}`).join('\n'));
