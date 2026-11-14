// Измерение канарейк против корпуса — числа для docs/EXPERIMENTS.md.

import { planIR } from '../../src/ir/intent.js';
import { symbolicReport } from '../../src/oracle/report.js';
import { canaryTracks, checkCanaries } from '../../src/oracle/canaries.js';

const PROMPTS = [
  'мрачный трип-хоп про дождь',
  'уютный лоуфай для учёбы',
  'эйфоричный фестиваль',
  'злой быстрый dnb',
  'тревожный эмбиент, пустой космос',
];

const corpus = PROMPTS.map((prompt) => ({
  prompt,
  score: symbolicReport(planIR(prompt, { seed: 42 })).score.total,
}));
const canaries = canaryTracks().map((canary) => ({
  id: canary.id,
  label: canary.label,
  score: symbolicReport(canary.ir).score.total,
}));

const check = checkCanaries(corpus.map((item) => item.score), canaries);

console.log('корпус:', corpus.map((item) => `${item.prompt.slice(0, 18)}=${item.score.toFixed(1)}`).join(' · '));
console.log('медиана корпуса:', check.median.toFixed(2));
console.log('канарейки:');
for (const canary of canaries) console.log(`  ${canary.label.padEnd(38)} ${canary.score.toFixed(1)}`);
console.log('проверка:', check.ok ? 'OK — все ниже медианы' : `ПРОВАЛ: ${JSON.stringify(check.failures)}`);
