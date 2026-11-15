#!/usr/bin/env node
// Скор трека из 100 дорожек: было и стало (C3).
//
// Проверяем, что перебазировка критериев «партии» и «плотность» действительно
// снимает штраф за масштаб, а не просто меняет цифры.
//
// ЗАПУСК: node tests/spike/score-100.probe.mjs

import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { analyzeTrack } from '../../server/music/features.js';
import { scoreTrack, CRITERIA, densityTarget, ROLE_FUNCTIONS } from '../../server/music/score.js';
import { PROFILES } from '../../server/music/references.js';
import { specFromPlan } from '../../src/music/expand.js';

const TARGET = 100;

// Тот же путь, что и в демо: план -> экспансия -> спека.
const plan = {
  style: 'techno',
  key: 'Cmin',
  bpm: 120,
  sections: [
    { name: 'intro', bars: 8, energy: 0.4, harmony: 'Cm' },
    { name: 'drop', bars: 8, energy: 0.9, harmony: 'Cm Gm' },
  ],
  groups: [
    { group: 'strings', role: 'violin', count: 24 },
    { group: 'strings', role: 'cello', count: 12 },
    { group: 'brass', role: 'horn', count: 12 },
    { group: 'woodwinds', role: 'flute', count: 12 },
    { group: 'keys', role: 'piano', count: 8 },
    { group: 'choir', role: 'choir_soprano', count: 8 },
    { group: 'pads', role: 'pad', count: 8 },
    { group: 'bass', role: 'bass', count: 4 },
    { group: 'perc', role: 'perc', count: 6 },
    { group: 'drums', role: 'kick', count: 2 },
    { group: 'drums', role: 'hats', count: 2 },
    { group: 'lead', role: 'lead', count: 2 },
  ],
};

const { spec: rawSpec } = specFromPlan(plan);
const spec = rawSpec;
if (Object.keys(spec.parts.roles).length !== TARGET) {
  console.log(`Внимание: дорожек ${Object.keys(spec.parts.roles).length}, а не ${TARGET}`);
}

const code = compileTrackSpec(spec);
const analysis = analyzeTrack(code);
const profile = PROFILES.techno;
const score = scoreTrack(analysis, profile);

console.log(`Партий: ${analysis.metrics.partCount}, атак на такт: ${analysis.metrics.density}, роли: ${[...new Set(analysis.metrics.roles)].join(', ')}`);
console.log(`Плотность: цель по профилю ${profile.density.join('–')}, цель с учётом ${analysis.metrics.partCount} дорожек ${densityTarget(profile, analysis.metrics.partCount).join('–')}`);
console.log(`Итог: ${score.total} (${score.grade})\n`);

for (const item of score.criteria) {
  console.log(`  ${item.label.padEnd(22)} ${String(item.value).padStart(8)}  балл ${item.score}  из ${item.weight}  ${item.targetText}`);
}

// Как было до перебазировки: «партии» — строгий диапазон, плотность —
// фиксированный диапазон профиля.
const before = CRITERIA.map((criterion) => {
  const value = criterion.value(analysis.metrics);
  if (value === null || !Number.isFinite(value)) return null;
  if (criterion.id === 'arrangement') {
    const [min, max] = profile.parts;
    const span = Math.max(1, max - min);
    const dist = value < min ? min - value : value - max;
    return Math.max(0, 1 - dist / span);
  }
  if (criterion.id === 'density') {
    const [min, max] = profile.density;
    const span = Math.max(1, max - min);
    const dist = value < min ? min - value : value - max;
    return Math.max(0, 1 - dist / span);
  }
  return null;
}).filter((v) => v !== null);

const arrangementBefore = before[0];
const densityBefore = before[1];
console.log(`\nБыло: партии ${arrangementBefore.toFixed(3)} (0 из 10), плотность ${densityBefore.toFixed(3)} (0 из 12)`);
console.log(`Стало: партии ${score.criteria.find((c) => c.id === 'arrangement').score} (${score.criteria.find((c) => c.id === 'arrangement').points} из 10), плотность ${score.criteria.find((c) => c.id === 'density').score} (${score.criteria.find((c) => c.id === 'density').points} из 12)`);
console.log(`Функции ролей: ${[...new Set(analysis.metrics.roles.map((r) => ROLE_FUNCTIONS[r] || r))].join(', ')}`);
