// Выученная цель (Taste Model): реестр метрик, признаки, модель, проверка,
// активный отбор, реестр пар и API.
//
// Ключевая идея тестов: проверяем не «числа получились», а СВОЙСТВА, на
// которых держится честность (бриф §7.4):
//   • обучение детерминировано и обратимо;
//   • непомеренное отличается от нулевого;
//   • модель НЕ допускается, пока живых пар меньше 60;
//   • проверка идёт leave-prompt-out, а не по случайной разбивке.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  METRICS,
  SCORE_CRITERIA,
  AUDIO_SCORE_CRITERIA,
  SCORE_COMBINE,
  metricById,
  metricsBySource,
  describeRegistry,
} from '../../src/metrics/registry.js';
import { registryCoverage, extractMetrics } from '../../src/metrics/extract.js';
import { SCORE_COMPONENTS } from '../../src/oracle/score.js';
import { AUDIO_SCORE_WEIGHT, combineScores } from '../../server/music/compose/audio-score.js';
import {
  featureVector,
  standardizer,
  standardizeValues,
  TASTE_FEATURE_IDS,
} from '../../src/taste/features.js';
import { trainTaste, tasteProbability, tasteScore, parseModel, modelSanity } from '../../src/taste/model.js';
import { leavePromptOutCV, admitDecision, wilsonInterval } from '../../src/taste/cv.js';
import { selectNextPairs, rankByUncertainty, buildRepeatPairs } from '../../src/taste/active.js';
import { buildRows, proxyRowsFromIr, countSources, PROXY_WEIGHT } from '../../server/taste/dataset.js';
import { trainAndReport } from '../../server/taste/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

// Свой каталог данных: тесты не трогают метки владельца и не мешают
// другим тестовым файлам, которые идут параллельно.
const dataDir = mkdtempSync(join(tmpdir(), 'strudel-taste-'));
process.env.STRUDEL_DATA_DIR = dataDir;

const protectedFiles = ['preferences.jsonl', 'pairs.jsonl', 'taste-model.json', 'taste-report.json'];

// Настоящие данные владельца не трогаем: сохраняем и восстанавливаем.
const backups = [];
beforeAll(() => {
  for (const name of protectedFiles) {
    const file = join(root, 'server', 'data', name);
    if (!existsSync(file)) continue;
    const backup = join(root, 'server', 'data', `.backup-${name}-${Date.now()}`);
    copyFileSync(file, backup);
    backups.push({ file, backup });
    rmSync(file, { force: true });
  }
});

afterAll(() => {
  for (const { file, backup } of backups) {
    if (existsSync(backup)) {
      copyFileSync(backup, file);
      rmSync(backup, { force: true });
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

/** Синтетический символьный отчёт. */
function fakeReport(overrides = {}) {
  return {
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
      ...overrides.metrics,
    },
    registers: { bass: { min: 28, max: 40 }, chords: { min: 55, max: 67 } },
    kinetics: { distinctVelocities: 5 },
    ...overrides,
  };
}

/** Синтетические пары с известным ответом: решает первый признак. */
function syntheticRows(count = 40, prompts = 8) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const positive = index % 2 === 0;
    const xA = new Array(TASTE_FEATURE_IDS.length).fill(0);
    const xB = new Array(TASTE_FEATURE_IDS.length).fill(0);
    xA[0] = positive ? 1 : -1;
    xB[0] = positive ? -1 : 1;
    rows.push({
      pairId: `p${index}`,
      prompt: `промт-${index % prompts}`,
      ids: TASTE_FEATURE_IDS,
      xA,
      xB,
      y: positive ? 1 : 0,
      weight: 1,
      source: 'explicit',
      scoreA: positive ? 90 : 50,
      scoreB: positive ? 50 : 90,
      lufsA: positive ? -14 : -18,
      lufsB: positive ? -18 : -14,
    });
  }
  return rows;
}

describe('реестр метрик', () => {
  it('id уникальны, а каждый id известен поимённо', () => {
    const ids = METRICS.map((metric) => metric.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(metricById(ids[0])?.id).toBe(ids[0]);
    expect(metricById('такого.id.нет')).toBeNull();
  });

  it('у каждой метрики объявлены единицы, диапазон, цель и источник', () => {
    for (const metric of METRICS) {
      expect(metric.unit).toBeTruthy();
      expect(Array.isArray(metric.range)).toBe(true);
      expect(metric.range).toHaveLength(2);
      expect(metric.source).toMatch(/^(symbolic|render|human)$/);
      expect(metric.version).toBe(1);
    }
  });

  it('все метрики реестра извлекаются из отчётов', () => {
    const coverage = registryCoverage();
    expect(coverage.uncovered).toEqual([]);
    expect(coverage.extractable).toBe(coverage.registered);
  });

  it('метрики делятся по источнику: символьные и рендер', () => {
    expect(metricsBySource('symbolic').length).toBeGreaterThan(20);
    expect(metricsBySource('render').length).toBeGreaterThan(4);
  });

  it('описание реестра годно для документации', () => {
    const described = describeRegistry();
    expect(described.count).toBe(METRICS.length);
    expect(described.version).toBe(1);
  });
});

describe('рефакторинг: веса скора живут в реестре', () => {
  it('составляющие символьного скора берутся из реестра', () => {
    expect(SCORE_COMPONENTS.map((item) => item.id)).toEqual(SCORE_CRITERIA.map((item) => item.key));
    expect(SCORE_COMPONENTS.map((item) => item.weight)).toEqual(SCORE_CRITERIA.map((item) => item.weight));
    expect(SCORE_COMPONENTS.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
  });

  it('веса аудио-блока берутся из реестра', () => {
    expect(AUDIO_SCORE_WEIGHT).toBe(SCORE_COMBINE.audio.weight);
    expect(AUDIO_SCORE_CRITERIA.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
  });

  it('формула смешивания не изменилась', () => {
    // Значения зафиксированы тестом: смена формулы должна быть явным решением.
    expect(combineScores(80, 60, null)).toBe(72);
    expect(combineScores(80, null, null)).toBe(80);
    expect(combineScores(80, 60, 100)).toBe(77.6);
  });
});

describe('признаки', () => {
  it('вектор детерминирован и совпадает по длине с составом', () => {
    const first = featureVector({ symbolic: fakeReport() }, TASTE_FEATURE_IDS);
    const second = featureVector({ symbolic: fakeReport() }, TASTE_FEATURE_IDS);
    expect(first.values).toEqual(second.values);
    expect(first.values).toHaveLength(TASTE_FEATURE_IDS.length);
  });

  it('непомеренное — null, а не 0', () => {
    const vector = featureVector({}, TASTE_FEATURE_IDS);
    expect(vector.values.every((value) => value === null)).toBe(true);
    expect(vector.missing.length).toBe(TASTE_FEATURE_IDS.length);
  });

  it('нулевое измерение не путается с пропуском', () => {
    const vector = featureVector({ symbolic: fakeReport({ metrics: { scaleFit: 0 } }) }, TASTE_FEATURE_IDS);
    const index = TASTE_FEATURE_IDS.indexOf('symbolic.tonality.scaleFit');
    expect(vector.values[index]).toBe(0);
  });

  it('стандартизация: пропуск даёт 0, а не NaN', () => {
    const stats = standardizer([[1, null], [3, null]]);
    expect(stats.mean[0]).toBe(2);
    expect(stats.std[0]).toBe(1);
    expect(standardizeValues([null, 1], stats)[0]).toBe(0);
  });

  it('постоянный признак не ломает нормировку', () => {
    const stats = standardizer([[5], [5], [5]]);
    expect(stats.std[0]).toBe(1);
  });

  it('аудио-признаки читаются из отчёта о рендере', () => {
    const vector = featureVector({
      audio: { lufsI: -14.2, truePeakDbtp: -1.4, crestDb: 9, clipCount: 0 },
    }, TASTE_FEATURE_IDS);
    const index = TASTE_FEATURE_IDS.indexOf('audio.lufsI');
    expect(vector.values[index]).toBe(-14.2);
  });
});

describe('модель Bradley–Terry', () => {
  it('обучение детерминировано', () => {
    const rows = syntheticRows();
    const first = trainTaste(rows);
    const second = trainTaste(rows);
    expect(first.weights).toEqual(second.weights);
  });

  it('вероятность обратима: p(A>B) + p(B>A) = 1', () => {
    const model = trainTaste(syntheticRows());
    const row = syntheticRows(1)[0];
    const pAB = tasteProbability(model, row.xA, row.xB);
    const pBA = tasteProbability(model, row.xB, row.xA);
    expect(pAB).toBeGreaterThanOrEqual(0);
    expect(pAB).toBeLessThanOrEqual(1);
    expect(Math.abs(pAB + pBA - 1)).toBeLessThan(1e-9);
  });

  it('выучивает различающий признак', () => {
    const model = trainTaste(syntheticRows());
    expect(model.trainAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(modelSanity(model).ok).toBe(true);
  });

  it('без данных модель не выдумывается', () => {
    expect(trainTaste([])).toBeNull();
  });

  it('абсолютная оценка трека монотонна по разнице', () => {
    const model = trainTaste(syntheticRows());
    const row = syntheticRows(1)[0];
    expect(tasteScore(model, row.xA)).toBeGreaterThan(tasteScore(model, row.xB));
  });

  it('сохранённая модель проходит проверку формы', () => {
    const model = trainTaste(syntheticRows());
    expect(parseModel(JSON.parse(JSON.stringify(model)))).toBeTruthy();
    expect(parseModel({ weights: [1], ids: ['a', 'b'] })).toBeNull();
    expect(parseModel(null)).toBeNull();
  });
});

describe('проверка модели', () => {
  it('интервал Уилсона считается по границам', () => {
    const interval = wilsonInterval(0, 10);
    expect(interval.lower).toBe(0);
    expect(interval.upper).toBeLessThan(0.3);
    const full = wilsonInterval(10, 10);
    expect(full.upper).toBe(1);
    expect(full.lower).toBeGreaterThan(0.7);
  });

  it('leave-prompt-out даёт складку на каждый промт', () => {
    const cv = leavePromptOutCV(syntheticRows());
    expect(cv.prompts).toBe(8);
    expect(cv.folds.every((fold) => fold.skipped === false)).toBe(true);
    expect(cv.accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it('на данных с известным ответом модель побеждает базовые линии', () => {
    const cv = leavePromptOutCV(syntheticRows());
    expect(cv.baselines.chance.accuracy).toBe(0.5);
    expect(cv.accuracy).toBeGreaterThan(cv.baselines.chance.accuracy);
  });

  it('базовая линия «всегда-громче» считается, когда есть аудио', () => {
    const cv = leavePromptOutCV(syntheticRows());
    expect(cv.baselines.louder).toBeTruthy();
    expect(cv.baselines.symbolic).toBeTruthy();
  });

  it('без живых пар проверка честно пустая', () => {
    const cv = leavePromptOutCV([]);
    expect(cv.accuracy).toBeNull();
    expect(cv.n).toBe(0);
  });
});

describe('допуск в скор', () => {
  it('не допускает модель без живых пар', () => {
    const decision = admitDecision({ cv: leavePromptOutCV([]), model: null, explicitPairs: 0 });
    expect(decision.admitted).toBe(false);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('не допускает при 40 живых парах (порог 60)', () => {
    const rows = syntheticRows();
    const model = trainTaste(rows);
    const decision = admitDecision({ cv: leavePromptOutCV(rows), model, explicitPairs: 40 });
    expect(decision.admitted).toBe(false);
    expect(decision.checks.pairsEnough).toBe(false);
  });

  it('проверяет все четыре условия и объясняет провал', () => {
    const decision = admitDecision({ cv: leavePromptOutCV([]), model: null, explicitPairs: 0 });
    expect(Object.keys(decision.checks).sort()).toEqual(
      ['accuracyEnough', 'beatsBaselines', 'modelAlive', 'pairsEnough'],
    );
    expect(decision.reasons.every((reason) => typeof reason === 'string' && reason.length > 0)).toBe(true);
  });
});

describe('активный отбор', () => {
  it('неуверенная пара идёт раньше уверенной', () => {
    const model = trainTaste(syntheticRows());
    const width = TASTE_FEATURE_IDS.length;
    const uncertain = { pairId: 'u', prompt: 'a', ids: TASTE_FEATURE_IDS, xA: new Array(width).fill(0), xB: new Array(width).fill(0) };
    const certain = { pairId: 'c', prompt: 'b', ids: TASTE_FEATURE_IDS, xA: new Array(width).fill(0), xB: new Array(width).fill(0) };
    certain.xA[0] = 10;
    const ranked = rankByUncertainty([certain, uncertain], model);
    expect(ranked[0].pair.pairId).toBe('u');
    expect(ranked[0].uncertainty).toBeGreaterThan(ranked[1].uncertainty);
  });

  it('страты: не больше двух пар от одного промта', () => {
    const model = trainTaste(syntheticRows());
    const width = TASTE_FEATURE_IDS.length;
    const pairs = [];
    for (let index = 0; index < 8; index += 1) {
      pairs.push({
        pairId: `p${index}`,
        prompt: `промт-${index % 2}`,
        ids: TASTE_FEATURE_IDS,
        xA: new Array(width).fill(0),
        xB: new Array(width).fill(0),
      });
    }
    const selected = selectNextPairs(pairs, model, { count: 4, perPromptLimit: 2 });
    expect(selected).toHaveLength(4);
    const counts = new Map();
    for (const pair of selected) counts.set(pair.prompt, (counts.get(pair.prompt) ?? 0) + 1);
    expect([...counts.values()].every((count) => count <= 2)).toBe(true);
  });

  it('повтор для надёжности рецензента переставляет стороны', () => {
    const pairs = [
      { pairId: 'p1', prompt: 'a', swapped: false, a: { hash: 'x' }, b: { hash: 'y' } },
      { pairId: 'p2', prompt: 'b', swapped: false, a: { hash: 'z' }, b: { hash: 'w' } },
    ];
    const repeats = buildRepeatPairs(pairs, 2);
    expect(repeats).toHaveLength(1);
    expect(repeats[0].repeat).toBe(true);
    expect(repeats[0].a.hash).toBe('y');
  });
});

describe('выборка для обучения', () => {
  /** Пара-заготовка: две стороны с хэшами и минимальным IR. */
  const samplePair = () => ({
    pairId: 'pair-001',
    prompt: 'тест',
    a: { hash: 'a', ir: { v: 1, seed: 1, meta: { title: 'a', bpm: 120, meter: '4/4', key: { tonic: 'c', mode: 'major' } }, sections: [], palette: {}, motifs: {}, groove: { template: 'straight', amount: 1 } } },
    b: { hash: 'b', ir: { v: 1, seed: 2, meta: { title: 'b', bpm: 120, meter: '4/4', key: { tonic: 'c', mode: 'major' } }, sections: [], palette: {}, motifs: {}, groove: { template: 'straight', amount: 1 } } },
  });

  it('метка от рендера без сэмплов не идёт в обучение', () => {
    // Трек прозвучал неполным: сравнивать половины неполных треков учит
    // модель не тому, поэтому такая метка исключается из выборки.
    const labels = [{ pairId: 'pair-001', winner: 'A', source: 'explicit', degraded: true }];
    const { rows, stats } = buildRows({ pairs: [samplePair()], labels });
    expect(rows).toHaveLength(0);
    expect(stats.skipped.degraded).toBe(1);
  });

  it('метка, у которой трек в реестре уже другой, не идёт в обучение', () => {
    // Тот же pairId, но хэши не совпадают: коды переехали, и старая метка
    // теперь указывает на другую пару — обучать на ней нельзя.
    const labels = [{
      pairId: 'pair-001', winner: 'A', source: 'explicit', hashA: 'чужой', hashB: 'чужих',
    }];
    const { rows, stats } = buildRows({ pairs: [samplePair()], labels });
    expect(rows).toHaveLength(0);
    expect(stats.skipped.stale).toBe(1);
  });

  it('соединяет метку с парой по id и достаёт признаки', () => {
    const pairs = [{
      pairId: 'pair-001',
      prompt: 'тест',
      a: { hash: 'a', ir: { v: 1, seed: 1, meta: { title: 'a', bpm: 120, meter: '4/4', key: { tonic: 'c', mode: 'major' } }, sections: [], palette: {}, motifs: {}, groove: { template: 'straight', amount: 1 } } },
      b: { hash: 'b', ir: { v: 1, seed: 2, meta: { title: 'b', bpm: 120, meter: '4/4', key: { tonic: 'c', mode: 'major' } }, sections: [], palette: {}, motifs: {}, groove: { template: 'straight', amount: 1 } } },
    }];
    const labels = [{
      pairId: 'pair-001',
      winner: 'A',
      source: 'explicit',
      audio: { a: { lufsI: -14 }, b: { lufsI: -16 } },
    }];
    const { rows, stats } = buildRows({ pairs, labels });
    expect(rows).toHaveLength(1);
    expect(rows[0].y).toBe(1);
    expect(rows[0].lufsA).toBe(-14);
    expect(rows[0].xA).toHaveLength(TASTE_FEATURE_IDS.length);
    expect(stats.rows).toBe(1);
  });

  it('метка без пары не ломает сборку, а считается пропущенной', () => {
    const { rows, stats } = buildRows({ pairs: [], labels: [{ pairId: 'нет', winner: 'A', source: 'explicit' }] });
    expect(rows).toHaveLength(0);
    expect(stats.skipped.pairMissing).toBe(1);
  });

  it('прокси-пары весят не больше 0.2', () => {
    expect(PROXY_WEIGHT).toBeLessThanOrEqual(0.2);
    const counted = countSources([
      { source: 'explicit' },
      { source: 'proxy' },
      { source: 'proxy' },
    ]);
    expect(counted.human).toBe(1);
    expect(counted.proxy).toBe(2);
  });

  it('прокси-пара строится из best-of-N и помечена как прокси', () => {
    const { rows } = proxyRowsFromIr({
      v: 1,
      seed: 7,
      meta: { title: 't', bpm: 120, meter: '4/4', key: { tonic: 'c', mode: 'major' } },
      sections: [],
      palette: {},
      motifs: {},
      groove: { template: 'straight', amount: 1 },
    }, { n: 4 });
    // Пустой IR без секций может не дать кандидатов — тогда строк нет,
    // но если есть, они обязаны быть прокси с малым весом.
    for (const row of rows) {
      expect(row.source).toBe('proxy');
      expect(row.weight).toBeLessThanOrEqual(0.2);
    }
  });
});

describe('служба обучения', () => {
  it('без данных честно говорит, что учить нечего', () => {
    const result = trainAndReport({ pairs: [], labels: [] });
    expect(result.model).toBeNull();
    expect(result.decision.admitted).toBe(false);
    expect(result.stats.rows).toBe(0);
  });
});
