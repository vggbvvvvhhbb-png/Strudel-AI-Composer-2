#!/usr/bin/env node
// Разбор кода, который выдаёт компилятор: находит ли анализатор события?

import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { analyzeTrack } from '../../server/music/features.js';

const spec = {
  meta: { style: 'techno', key: 'Cmin', bpm: 120 },
  structure: {
    sections: [
      { name: 'intro', cycles: 8, energy: 0.4, harmony: 'Cm' },
      { name: 'drop', cycles: 8, energy: 0.9, harmony: 'Cm Gm' },
    ],
  },
  parts: {
    roles: {
      kick: { activeIn: ['intro', 'drop'], pattern: 'bd*4', sound: 'bd' },
      bass: { activeIn: ['drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' },
    },
  },
};

const code = compileTrackSpec(spec);
console.log('--- скомпилированный код ---');
console.log(code);
console.log('--- метрики по скомпилированному коду ---');
const analysis = analyzeTrack(code);
console.log(JSON.stringify({
  partCount: analysis.metrics.partCount,
  density: analysis.metrics.density,
  scaleFit: analysis.metrics.scaleFit,
  range: analysis.metrics.range,
  roles: analysis.metrics.roles,
  errors: analysis.errors.slice(0, 3),
}, null, 2));

console.log('--- метрики по простому коду (как в тестах) ---');
const simple = ['setCpm(120/4)', '$KICK: s("bd*4")', '$BASS: n("0 ~ 2 ~")'].join('\n');
const simpleAnalysis = analyzeTrack(simple);
console.log(JSON.stringify({
  partCount: simpleAnalysis.metrics.partCount,
  density: simpleAnalysis.metrics.density,
  scaleFit: simpleAnalysis.metrics.scaleFit,
  range: simpleAnalysis.metrics.range,
  roles: simpleAnalysis.metrics.roles,
  errors: simpleAnalysis.errors.slice(0, 3),
}, null, 2));
