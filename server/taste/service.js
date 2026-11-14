// Служба выученной цели: обучение, проверка, решение о допуске.
//
// Правило, которое здесь главное: модель сохраняется ВСЕГДА (чтобы её можно
// было посмотреть глазами и сравнить), но ДОПУСКАЕТСЯ в Score только после
// leave-prompt-out CV. Пока допуска нет, символьный скор остаётся целью
// оптимизации «как есть» — с честной пометкой «не проверено на людях».
//
// Никакой новой инфраструктуры: файлы в server/data, отчёт в docs/evidence.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { trainTaste, modelSanity, topFeatures, parseModel } from '../../src/taste/model.js';
import { leavePromptOutCV, admitDecision } from '../../src/taste/cv.js';
import { TASTE_FEATURE_IDS } from '../../src/taste/features.js';
import { buildRows } from './dataset.js';
import { dataDir } from '../preference/ledger.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const modelFile = () => join(dataDir(), 'taste-model.json');
const reportFile = () => join(dataDir(), 'taste-report.json');

/**
 * Обучает модель и выносит вердикт.
 *
 * @param {object} input
 * @param {Array<object>} input.pairs реестр пар
 * @param {Array<object>} input.labels метки
 * @param {Array<object>} [input.proxyRows] прокси-пары от best-of-N
 * @param {object} [input.options] параметры обучения (epochs, lr, lambda)
 * @returns {object} {model, cv, decision, stats}
 */
export function trainAndReport({ pairs = [], labels = [], proxyRows = [], options = {} } = {}) {
  const human = buildRows({ pairs, labels, featureIds: TASTE_FEATURE_IDS });
  const rows = [...human.rows, ...proxyRows];

  const model = trainTaste(rows, options);
  const cv = leavePromptOutCV(rows, options);
  const decision = admitDecision({
    cv,
    model,
    explicitPairs: human.rows.length,
  });

  return {
    model,
    cv,
    decision,
    stats: {
      ...human.stats,
      proxyRows: proxyRows.length,
      totalRows: rows.length,
      featureCount: TASTE_FEATURE_IDS.length,
    },
  };
}

/**
 * Сохраняет модель на диск.
 * @param {object} model
 */
export function saveModel(model) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(modelFile(), `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  return modelFile();
}

/**
 * Читает сохранённую модель.
 * @returns {object|null}
 */
export function loadModel() {
  if (!existsSync(modelFile())) return null;
  try {
    return parseModel(JSON.parse(readFileSync(modelFile(), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Путь к файлу модели (для отчётов и гейтов).
 */
export function modelPath() {
  return modelFile();
}

/**
 * Сохраняет полный отчёт обучения (модель + CV + вердикт).
 * @param {object} report
 */
export function saveReport(report) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(reportFile(), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportFile();
}

/**
 * Читает последний отчёт обучения.
 * @returns {object|null}
 */
export function loadReport() {
  if (!existsSync(reportFile())) return null;
  try {
    return JSON.parse(readFileSync(reportFile(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Путь к файлу отчёта.
 */
export function reportPath() {
  return reportFile();
}

/**
 * Человекочитаемая сводка по модели: что модель вообще значит.
 *
 * @param {object|null} model
 * @returns {object}
 */
export function describeModel(model) {
  if (!model) {
    return {
      trained: false,
      note: 'Модель не обучена: нет ни одной человеческой пары.',
    };
  }
  const sanity = modelSanity(model);
  return {
    trained: true,
    n: model.n,
    nHuman: model.nHuman,
    nProxy: model.nProxy,
    featureCount: model.ids?.length ?? 0,
    loss: model.loss,
    trainAccuracy: model.trainAccuracy,
    sanity,
    top: topFeatures(model, 12),
  };
}
