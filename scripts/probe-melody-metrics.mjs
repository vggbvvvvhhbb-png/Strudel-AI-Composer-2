// L1-метрики мелодии на демо-опере (фаза D).
//
// Печатает, что именно анализатор видит в треке из 66 дорожек: связность
// темы, развитие по секциям, каденционную ясность и контурную энтропию —
// плюс то же самое для «до» (статичные шаблоны), чтобы разница была
// измерением, а не обещанием.

import { specFromPlan } from '../src/music/expand.js';
import { compileTrackSpec } from '../server/music/compiler/index.js';
import { validateTrackSpec } from '../src/schemas/track-spec.schema.js';
import { analyzeTrack } from '../server/music/features.js';

const bars = Number(process.argv[2] ?? 32);

const plan = {
  style: 'cinematic',
  key: 'Cmin',
  bpm: 90,
  sections: [
    { name: 'intro', bars: Math.round(bars * 0.25), energy: 0.35, harmony: 'Cm' },
    { name: 'verse', bars: Math.round(bars * 0.25), energy: 0.55, harmony: 'Cm Ab' },
    { name: 'drop', bars: Math.round(bars * 0.5), energy: 0.9, harmony: 'Cm Gm Ab Bb' },
  ],
  groups: [
    { group: 'strings', role: 'violin', count: 10 },
    { group: 'strings', role: 'viola', count: 4 },
    { group: 'strings', role: 'cello', count: 4 },
    { group: 'brass', role: 'horn', count: 4 },
    { group: 'brass', role: 'trumpet', count: 2 },
    { group: 'woodwinds', role: 'flute', count: 4 },
    { group: 'woodwinds', role: 'clarinet', count: 2 },
    { group: 'keys', role: 'piano', count: 4 },
    { group: 'keys', role: 'harp', count: 2 },
    { group: 'choir', role: 'choir_soprano', count: 4 },
    { group: 'choir', role: 'choir_bass', count: 2 },
    { group: 'choir', role: 'choir_alto', count: 4 },
    { group: 'pads', role: 'pad', count: 4 },
    { group: 'bass', role: 'bass', count: 2 },
    { group: 'perc', role: 'perc', count: 8 },
    { group: 'drums', role: 'kick', count: 1 },
    { group: 'drums', role: 'hats', count: 1 },
    { group: 'lead', role: 'lead', count: 2 },
    { group: 'fx', role: 'fx', count: 2 },
  ],
};

const { spec: rawSpec, report } = specFromPlan(plan);
const spec = validateTrackSpec(rawSpec);
const code = compileTrackSpec(spec);
const analysis = analyzeTrack(code);

const m = analysis.metrics;
const melody = analysis.melody;

console.log('=== L1 мелодии: демо-опера ===');
console.log(`Дорожек: ${report.voices}, атак на такт: ${report.totalAttacksPerBar}`);
console.log(`Тема: контур ${report.theme.contour}, ритм ${report.theme.rhythm}, ступени ${report.theme.degrees.join(' ')}`);
console.log(`Связность темы:        ${melody.motifCoherence === null ? 'нет данных' : melody.motifCoherence.toFixed(3)}`);
console.log(`Развитие по секциям:   ${melody.motifDevelopment === null ? 'нет данных' : melody.motifDevelopment.toFixed(3)}`);
console.log(`Каденционная ясность:  ${melody.cadenceClarity === null ? 'нет данных' : melody.cadenceClarity.toFixed(3)} (полное разрешение: ${melody.resolution === null ? 'нет данных' : melody.resolution.toFixed(3)})`);
console.log(`Контурная энтропия:    ${melody.contourEntropy === null ? 'нет данных' : melody.contourEntropy.toFixed(3)}`);
console.log(`Диапазон мелодии:      ${melody.melodyRange === null ? 'нет данных' : `${melody.melodyRange} полутонов`}`);
console.log(`Доля пауз (space):     ${m.space.toFixed(3)}`);
console.log(`Движение мелодии:      ${m.motion} разных интервалов`);
console.log(`Плотность:             ${m.density} атак на такт, ${m.partCount} партий`);
console.log(`Разделение регистров:  ${m.separation === null ? 'нет данных' : m.separation.toFixed(1)} полутонов`);
console.log(`Диапазон трека:        ${m.range} полутонов`);
console.log(`Ошибки разбора:        ${analysis.errors.length}`);

console.log('\n--- по партиям (первые 12) ---');
console.table(melody.parts.slice(0, 12).map((item) => ({
  роль: item.role,
  секций: item.sections,
  связность: item.coherence === null ? '—' : item.coherence.toFixed(2),
  развитие: item.development === null ? '—' : item.development.toFixed(2),
})));
