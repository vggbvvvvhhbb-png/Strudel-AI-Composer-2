// API выученной цели (бриф §7.4).
//
//   GET  /api/taste          — текущая модель, вердикт и состояние данных;
//   POST /api/taste/train    — обучить на накопленных парах (одна команда);
//   GET  /api/taste/active   — какие пары судить дальше (активный отбор).
//
// Ответы честные: если меток нет, модель не обучается, и API так и говорит.
// Никаких «нулевая метка = идеальная модель».

import express from 'express';

import { readPairs, readLabels } from '../preference/ledger.js';
import {
  trainAndReport,
  saveModel,
  saveReport,
  loadModel,
  loadReport,
  describeModel,
} from '../taste/service.js';
import { selectNextPairs } from '../../src/taste/active.js';
import { featureVector, TASTE_FEATURE_IDS } from '../../src/taste/features.js';
import { symbolicReport } from '../../src/oracle/report.js';

const router = express.Router();

/**
 * GET /api/taste — состояние выученной цели.
 */
router.get('/', (req, res) => {
  try {
    const model = loadModel();
    const report = loadReport();
    const pairs = readPairs();
    const labels = readLabels();
    const decided = labels.filter(
      (label) => (label.winner === 'A' || label.winner === 'B')
        && label.source === 'explicit',
    ).length;

    res.json({
      ok: true,
      model: describeModel(model),
      admitted: Boolean(report?.decision?.admitted),
      decision: report?.decision ?? null,
      cv: report?.cv ?? null,
      stats: report?.stats ?? null,
      data: {
        pairs: pairs.length,
        labels: labels.length,
        decided,
        prompts: new Set(pairs.map((pair) => pair.prompt)).size,
        needForAdmission: 60,
      },
      featureIds: TASTE_FEATURE_IDS,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/taste/train — обучить и сохранить.
 *
 * Обучение дешёвое (чистый JS, без инфраструктуры), поэтому его можно
 * запускать после каждой порции меток.
 */
router.post('/train', (req, res) => {
  try {
    const pairs = readPairs();
    const labels = readLabels();
    const result = trainAndReport({ pairs, labels });

    if (!result.model) {
      res.json({
        ok: false,
        trained: false,
        reason: 'Не на чем учить: нет ни одной решённой человеческой пары.',
        decision: result.decision,
        stats: result.stats,
      });
      return;
    }

    saveModel(result.model);
    const report = {
      trainedAt: new Date().toISOString(),
      model: result.model,
      cv: result.cv,
      decision: result.decision,
      stats: result.stats,
    };
    saveReport(report);

    res.json({
      ok: true,
      trained: true,
      admitted: result.decision.admitted,
      decision: result.decision,
      cv: result.cv,
      stats: result.stats,
      model: describeModel(result.model),
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/taste/active — какие пары судить дальше.
 *
 * Активный отбор работает только с обученной моделью: без неё «неуверенность»
 * не определена, и очередь остаётся детерминированной (см.
 * server/preference/ledger.js → buildQueue).
 */
router.get('/active', (req, res) => {
  try {
    const model = loadModel();
    const pairs = readPairs();
    if (!model) {
      res.json({
        ok: true,
        available: false,
        reason: 'Модель не обучена — активный отбор недоступен, очередь детерминированная.',
        pairs: [],
      });
      return;
    }

    const candidates = [];
    for (const pair of pairs) {
      if (!pair.a?.ir || !pair.b?.ir) continue;
      try {
        const vectorA = featureVector({ symbolic: symbolicReport(pair.a.ir) }, TASTE_FEATURE_IDS);
        const vectorB = featureVector({ symbolic: symbolicReport(pair.b.ir) }, TASTE_FEATURE_IDS);
        candidates.push({
          pairId: pair.pairId,
          prompt: pair.prompt,
          ids: vectorA.ids,
          xA: vectorA.values,
          xB: vectorB.values,
        });
      } catch {
        // битая пара не должна ронять выбор очереди
      }
    }

    const count = Math.max(1, Math.min(60, Number(req.query.count) || 10));
    const selected = selectNextPairs(candidates, model, {
      count,
      perPromptLimit: Number(req.query.perPrompt) || 2,
      history: readLabels(),
    });

    res.json({
      ok: true,
      available: true,
      count: selected.length,
      pairs: selected.map((pair) => ({
        pairId: pair.pairId,
        prompt: pair.prompt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

export default router;
