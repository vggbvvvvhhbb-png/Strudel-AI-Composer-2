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

const TARGET = 100;

const spec = {
  meta: { style: 'techno', key: 'Cmin', bpm: 120 },
  structure: {
    sections: [
      { name: 'intro', cycles: 8, energy: 0.4, harmony: 'Cm' },
      { name: 'drop', cycles: 8, energy: 0.9, harmony: 'Cm Gm' },
    ],
  },
  parts: {
    roles: Object.fromEntries(Array.from({ length: TARGET }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      const role = i % 4 === 0 ? 'kick' : i % 4 === 1 ? 'bass' : i % 4 === 2 ? 'lead' : 'pad';
      return [`P${n}`, {
        role,
        activeIn: ['intro', 'drop'],
        pattern: role === 'kick' ? 'bd*2' : '0 ~ 2 ~',
        sound: role === 'kick' ? 'bd' : 'sawtooth',
      }];
    })),
  },
};

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
