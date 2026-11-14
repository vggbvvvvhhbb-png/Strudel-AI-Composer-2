// Сборка обучающей выборки: реестр пар + метки → строки для Taste Model.
//
// ГЛАВНОЕ ЗДЕСЬ. Метка в реестре говорит «победил этот трек», а обучение
// требует «победил этот трек В ОТЛИЧИЕ от того, потому что у него вот
// такие признаки». Соединяет их IR пары: он хранится целиком, поэтому
// признаки можно пересчитать в любой момент — и не сломать старые пары
// изменением состава признаков.
//
// Прокси-пары (best-of-N) — честная слабость, а не замена людям: они
// размечены тем же символьным скором, на котором модель обучается, поэтому
// вес у них ≤0.2 и в решение о допуске они не идут вовсе (бриф §7.4).

import { symbolicReport } from '../../src/oracle/report.js';
import { featureVector, TASTE_FEATURE_IDS } from '../../src/taste/features.js';
import { searchBest } from '../../src/oracle/search.js';

/** Вес прокси-пары: бриф разрешает не больше 0.2. */
export const PROXY_WEIGHT = 0.2;

/**
 * Собирает строки обучения из реестра пар и меток.
 *
 * @param {object} input
 * @param {Array<object>} input.pairs реестр пар (server/data/pairs.jsonl)
 * @param {Array<object>} input.labels метки (server/data/preferences.jsonl)
 * @param {Array<string>} [input.featureIds] состав признаков
 * @returns {{rows:Array<object>, stats:object}}
 */
export function buildRows({ pairs = [], labels = [], featureIds = TASTE_FEATURE_IDS } = {}) {
  const byId = new Map(pairs.map((pair) => [pair.pairId, pair]));
  const rows = [];
  const skipped = { pairMissing: 0, noIr: 0, noDecision: 0, broken: 0 };

  for (const label of labels) {
    if (label.winner !== 'A' && label.winner !== 'B') continue;
    if ((label.source ?? 'explicit') !== 'explicit') continue;
    const pair = byId.get(label.pairId);
    if (!pair) {
      skipped.pairMissing += 1;
      continue;
    }
    if (!pair.a?.ir || !pair.b?.ir) {
      skipped.noIr += 1;
      continue;
    }
    try {
      const reportA = symbolicReport(pair.a.ir);
      const reportB = symbolicReport(pair.b.ir);
      const audioA = label.audio?.a ?? null;
      const audioB = label.audio?.b ?? null;
      const vectorA = featureVector({ symbolic: reportA, audio: audioA }, featureIds);
      const vectorB = featureVector({ symbolic: reportB, audio: audioB }, featureIds);

      rows.push({
        pairId: label.pairId,
        prompt: label.prompt ?? pair.prompt ?? '',
        ids: vectorA.ids,
        xA: vectorA.values,
        xB: vectorB.values,
        y: label.winner === 'A' ? 1 : 0,
        weight: 1,
        source: 'explicit',
        scoreA: reportA.score?.total ?? null,
        scoreB: reportB.score?.total ?? null,
        lufsA: audioA?.lufsI ?? null,
        lufsB: audioB?.lufsI ?? null,
        listenMs: label.listenMs ?? null,
      });
    } catch {
      skipped.broken += 1;
    }
  }

  return {
    rows,
    stats: {
      pairs: pairs.length,
      labels: labels.length,
      rows: rows.length,
      prompts: new Set(rows.map((row) => row.prompt)).size,
      skipped,
    },
  };
}

/**
 * Прокси-пары из best-of-N.
 *
 * Логика: берём план, гоняем поиск (N мутаций), оракул ранжирует их по
 * символьному скору. Самая сильная и самая слабая образуют пару, «победитель»
 * — по символьному скору. Такая пара учит модель воспроизводить скор,
 * поэтому её вес мал и она не проходит допуск.
 *
 * @param {object} ir исходный план
 * @param {object} [options]
 * @param {string} [options.prompt] промт (для группировки по промтам в CV)
 * @param {number} [options.seed]
 * @param {number} [options.n] число кандидатов
 * @param {number} [options.weight] вес прокси-пары
 * @param {Array<string>} [options.featureIds]
 * @returns {{rows:Array<object>, stats:object}}
 */
export function proxyRowsFromIr(ir, options = {}) {
  const {
    prompt = 'proxy',
    seed = ir?.seed ?? 0,
    n = 16,
    weight = PROXY_WEIGHT,
    featureIds = TASTE_FEATURE_IDS,
  } = options;

  const result = searchBest(ir, { n, topK: Math.min(8, n), seed });
  const scored = result.all
    .filter((candidate) => candidate.score !== null && candidate.ir)
    .sort((a, b) => b.score - a.score);
  if (scored.length < 2) return { rows: [], stats: { candidates: scored.length, rows: 0 } };

  const best = scored[0];
  const worst = scored[scored.length - 1];
  if (!best.ir || !worst.ir) return { rows: [], stats: { candidates: scored.length, rows: 0 } };

  const reportBest = symbolicReport(best.ir);
  const reportWorst = symbolicReport(worst.ir);
  const vectorBest = featureVector({ symbolic: reportBest }, featureIds);
  const vectorWorst = featureVector({ symbolic: reportWorst }, featureIds);

  return {
    rows: [{
      pairId: `proxy-${seed}-${best.index}-${worst.index}`,
      prompt,
      ids: vectorBest.ids,
      xA: vectorBest.values,
      xB: vectorWorst.values,
      y: 1,
      weight,
      source: 'proxy',
      scoreA: reportBest.score?.total ?? null,
      scoreB: reportWorst.score?.total ?? null,
      lufsA: null,
      lufsB: null,
      listenMs: null,
    }],
    stats: { candidates: scored.length, rows: 1 },
  };
}

/**
 * Считает, сколько в выборке живых и прокси-пар.
 * @param {Array<object>} rows
 * @returns {{human:number, proxy:number, total:number}}
 */
export function countSources(rows) {
  const human = rows.filter((row) => row.source === 'explicit').length;
  const proxy = rows.filter((row) => row.source === 'proxy').length;
  return { human, proxy, total: rows.length };
}
