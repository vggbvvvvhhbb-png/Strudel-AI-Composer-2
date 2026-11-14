// Гейт выученной цели (бриф §8: «Gate = исполняемая проверка»).
//
//   node scripts/check-taste.mjs
//
// Гейт проверяет МАШИНЕРИЮ, а не наличие человеческих меток:
//
//   • реестр метрик цел и покрыт извлекаторами;
//   • признаки детерминированы, пропуски — null, а не 0;
//   • обучение детерминировано и обратимо (p(A>B) = 1 − p(B>A));
//   • leave-prompt-out CV работает на данных с известным ответом;
//   • интервал Уилсона считается верно;
//   • допуск не выдаётся, пока живых пар меньше 60;
//   • активный отбор соблюдает страты.
//
// Человеческая часть (100 суждений по §7.2) — отдельная строка отчёта со
// статусом pending: за неё отвечает человек, и подменять её тестом нельзя.
//
// Пишет docs/evidence/taste/gate.json. Код возврата ≠ 0, если механика сломана.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { METRICS, SCORE_CRITERIA, AUDIO_SCORE_CRITERIA, SCORE_COMBINE } from '../src/metrics/registry.js';
import { registryCoverage, extractMetrics } from '../src/metrics/extract.js';
import { featureVector, standardizer, standardizeValues, TASTE_FEATURE_IDS } from '../src/taste/features.js';
import { trainTaste, tasteProbability } from '../src/taste/model.js';
import { leavePromptOutCV, admitDecision, wilsonInterval } from '../src/taste/cv.js';
import { selectNextPairs, rankByUncertainty } from '../src/taste/active.js';
import { readPairs, readLabels } from '../server/preference/ledger.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const evidenceDir = join(root, 'docs', 'evidence', 'taste');

const checks = [];

/**
 * Записывает результат проверки.
 * @param {string} name
 * @param {boolean} passed
 * @param {string} detail
 * @param {object} [numbers]
 */
function check(name, passed, detail, numbers = null) {
  checks.push({ name, passed: Boolean(passed), detail, numbers });
}

// --- 1. реестр метрик ---

const ids = METRICS.map((metric) => metric.id);
const unique = new Set(ids);
check(
  'реестр: id уникальны',
  unique.size === ids.length,
  `уникальных ${unique.size} из ${ids.length}`,
  { total: ids.length, unique: unique.size },
);

const coverage = registryCoverage();
check(
  'реестр: все метрики извлекаемы',
  coverage.uncovered.length === 0,
  coverage.uncovered.length
    ? `без извлекателя: ${coverage.uncovered.join(', ')}`
    : `покрыто ${coverage.extractable} из ${coverage.registered}`,
  coverage,
);

const criteriaSum = SCORE_CRITERIA.reduce((sum, item) => sum + item.weight, 0);
check(
  'реестр: веса критериев символьного скора дают 100',
  criteriaSum === 100,
  `сумма весов = ${criteriaSum}`,
  { sum: criteriaSum },
);

const audioSum = AUDIO_SCORE_CRITERIA.reduce((sum, item) => sum + item.weight, 0);
check(
  'реестр: веса критериев аудио-блока дают 100',
  audioSum === 100,
  `сумма весов = ${audioSum}`,
  { sum: audioSum },
);

const combineSum = SCORE_COMBINE.v1.weight + SCORE_COMBINE.v2.weight;
check(
  'реестр: веса текстовых блоков дают 1',
  Math.abs(combineSum - 1) < 1e-9,
  `v1 + v2 = ${combineSum}`,
  { sum: combineSum },
);

// --- 2. признаки ---

const fakeSymbolic = {
  sections: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  bars: 16,
  metrics: {
    minContrast: 0.3,
    sectionContrasts: [0.3, 0.5],
    energyCorrelation: 0.8,
    energyRange: 0.6,
    energyProfile: [0.2, 0.5, 0.9],
    scaleFit: 0.95,
    harmonicFit: 0.8,
    motifRecurrence: { count: 4, sectionCount: 2, variations: 3, hook: true },
    phraseClosure: { closureRatio: 0.75, openRatio: 0.7, count: 8 },
    bassKickLock: 0.7,
    microtiming: { stdMs: 14, meanMs: -2 },
    variation: { ratio: 0.5 },
    density: 4.2,
    roleBalance: { kick: 0.3, bass: 0.3, chords: 0.2, lead: 0.2 },
    roleCounts: { kick: 16, snare: 8, hats: 32, bass: 16, chords: 8, lead: 8 },
  },
  registers: { bass: { min: 28, max: 40 }, chords: { min: 55, max: 67 } },
  kinetics: { distinctVelocities: 5 },
};

const vector = featureVector({ symbolic: fakeSymbolic }, TASTE_FEATURE_IDS);
const vectorAgain = featureVector({ symbolic: fakeSymbolic }, TASTE_FEATURE_IDS);
check(
  'признаки: детерминированы',
  JSON.stringify(vector.values) === JSON.stringify(vectorAgain.values),
  'два вызова дали одинаковый вектор',
);

check(
  'признаки: длина совпадает с составом',
  vector.values.length === TASTE_FEATURE_IDS.length,
  `${vector.values.length} из ${TASTE_FEATURE_IDS.length}`,
  { length: vector.values.length, expected: TASTE_FEATURE_IDS.length },
);

const emptyVector = featureVector({}, TASTE_FEATURE_IDS);
const allNull = emptyVector.values.every((value) => value === null);
check(
  'признаки: непомеренное — null, а не 0',
  allNull,
  allNull ? 'все пропуски помечены null' : 'найден ноль вместо пропуска',
  { missing: emptyVector.missing.length },
);

const stats = standardizer([vector.values, emptyVector.values]);
const standardized = standardizeValues(vector.values, stats);
check(
  'признаки: пропуск после стандартизации даёт 0, а не NaN',
  standardized.every((value) => Number.isFinite(value)),
  'все значения конечны',
);

const extracted = extractMetrics(fakeSymbolic, ['symbolic.form.sections', 'symbolic.form.minContrast']);
check(
  'признаки: экстрактор отдаёт числа по id реестра',
  extracted.values['symbolic.form.sections'] === 3
    && Math.abs(extracted.values['symbolic.form.minContrast'] - 0.3) < 1e-9,
  `секций ${extracted.values['symbolic.form.sections']}, контраст ${extracted.values['symbolic.form.minContrast']}`,
);

// --- 3. модель ---

function syntheticRows(count = 40) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const prompt = `промт-${index % 8}`;
    const positive = index % 2 === 0;
    const xA = new Array(TASTE_FEATURE_IDS.length).fill(0);
    const xB = new Array(TASTE_FEATURE_IDS.length).fill(0);
    xA[0] = positive ? 1 : -1;
    xB[0] = positive ? -1 : 1;
    rows.push({ pairId: `p${index}`, prompt, ids: TASTE_FEATURE_IDS, xA, xB, y: positive ? 1 : 0, weight: 1, source: 'explicit' });
  }
  return rows;
}

const rows = syntheticRows();
const modelA = trainTaste(rows);
const modelB = trainTaste(rows);
check(
  'модель: обучение детерминировано',
  JSON.stringify(modelA.weights) === JSON.stringify(modelB.weights),
  'две тренировки дали одинаковые веса',
  { weights: modelA?.weights.length ?? 0 },
);

const pAB = tasteProbability(modelA, rows[0].xA, rows[0].xB);
const pBA = tasteProbability(modelA, rows[0].xB, rows[0].xA);
check(
  'модель: вероятность обратима',
  Math.abs(pAB + pBA - 1) < 1e-9 && pAB >= 0 && pAB <= 1,
  `p(A>B)=${pAB.toFixed(4)}, p(B>A)=${pBA.toFixed(4)}`,
  { pAB: Number(pAB.toFixed(4)), pBA: Number(pBA.toFixed(4)) },
);

check(
  'модель: выучила различающий признак',
  modelA.trainAccuracy >= 0.9,
  `точность на тренировке ${modelA.trainAccuracy}`,
  { trainAccuracy: modelA.trainAccuracy },
);

// --- 4. кросс-валидация ---

const cv = leavePromptOutCV(rows);
check(
  'CV: leave-prompt-out на данных с известным ответом',
  cv.accuracy !== null && cv.accuracy >= 0.9,
  `CV-accuracy ${cv.accuracy} (CI ${cv.ci.lower}…${cv.ci.upper})`,
  { accuracy: cv.accuracy, ci: cv.ci, folds: cv.folds.length },
);

check(
  'CV: folds по промтам',
  cv.folds.length === 8 && cv.folds.every((fold) => fold.skipped === false),
  `сложено ${cv.folds.length} складок, пропущено ${cv.folds.filter((f) => f.skipped).length}`,
  { folds: cv.folds.length },
);

const wilson = wilsonInterval(0, 10);
check(
  'CV: интервал Уилсона считается верно',
  wilson.upper < 0.3 && wilson.lower === 0,
  `0 из 10 → [${wilson.lower.toFixed(4)}, ${wilson.upper.toFixed(4)}]`,
  { lower: Number(wilson.lower.toFixed(4)), upper: Number(wilson.upper.toFixed(4)) },
);

// --- 5. допуск ---

const emptyDecision = admitDecision({ cv: leavePromptOutCV([]), model: null, explicitPairs: 0 });
check(
  'допуск: без живых пар модель не допускается',
  emptyDecision.admitted === false && emptyDecision.reasons.length > 0,
  emptyDecision.reasons.join('; '),
  emptyDecision.checks,
);

const smallDecision = admitDecision({ cv, model: modelA, explicitPairs: 40 });
check(
  'допуск: при 40 живых парах не допускается (порог 60)',
  smallDecision.admitted === false,
  smallDecision.reasons.join('; '),
  smallDecision.checks,
);

// --- 6. активный отбор ---

const uncertain = { pairId: 'u', prompt: 'промт-1', ids: TASTE_FEATURE_IDS, xA: new Array(TASTE_FEATURE_IDS.length).fill(0), xB: new Array(TASTE_FEATURE_IDS.length).fill(0) };
const certain = { pairId: 'c', prompt: 'промт-2', ids: TASTE_FEATURE_IDS, xA: new Array(TASTE_FEATURE_IDS.length).fill(0), xB: new Array(TASTE_FEATURE_IDS.length).fill(0) };
certain.xA[0] = 10;

const ranked = rankByUncertainty([certain, uncertain], modelA);
check(
  'активный отбор: неуверенная пара выше уверенной',
  ranked[0].pair.pairId === 'u',
  `первой идёт «${ranked[0].pair.pairId}» (неуверенность ${ranked[0].uncertainty})`,
  { order: ranked.map((entry) => entry.pair.pairId) },
);

const many = [];
for (let index = 0; index < 8; index += 1) {
  const pair = { ...uncertain, pairId: `p${index}`, prompt: `промт-${index % 2}` };
  many.push(pair);
}
const selected = selectNextPairs(many, modelA, { count: 4, perPromptLimit: 2 });
const perPrompt = new Map();
for (const pair of selected) perPrompt.set(pair.prompt, (perPrompt.get(pair.prompt) ?? 0) + 1);
const strataOk = [...perPrompt.values()].every((count) => count <= 2);
check(
  'активный отбор: страты по промту соблюдены',
  strataOk && selected.length === 4,
  `выбрано ${selected.length}, распределение ${JSON.stringify([...perPrompt.entries()])}`,
  { selected: selected.length },
);

// --- 7. данные владельца ---

const pairs = readPairs();
const labels = readLabels();
const decided = labels.filter(
  (label) => (label.winner === 'A' || label.winner === 'B')
    && (label.source ?? 'explicit') === 'explicit',
).length;

const failed = checks.filter((item) => !item.passed);
const report = {
  checkedAt: new Date().toISOString(),
  machinery: {
    pass: failed.length === 0,
    checks: checks.length,
    failed: failed.length,
  },
  humanGate: {
    // §7.2: приёмка проекта — ≥100 суждений, ≥50 промтов, ≥2 рецензента.
    status: decided >= 100 ? 'met' : 'pending',
    decided,
    required: 100,
    note: 'Метки ставит человек; тест их не заменяет.',
  },
  tasteAdmission: {
    // §7.4: модель допускается при ≥60 человеческих парах.
    decided,
    required: 60,
    status: decided >= 60 ? 'possible' : 'pending',
  },
  checks,
};

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, 'gate.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

for (const item of checks) {
  console.log(`${item.passed ? '✓' : '✗'} ${item.name} — ${item.detail}`);
}
console.log('');
console.log(`механика: ${report.machinery.pass ? 'зелёная' : 'КРАСНАЯ'} (${checks.length} проверок)`);
console.log(`живых пар: ${decided} (для допуска модели нужно 60, для приёмки проекта — 100)`);
console.log('Записано: docs/evidence/taste/gate.json');

if (!report.machinery.pass) process.exit(1);
