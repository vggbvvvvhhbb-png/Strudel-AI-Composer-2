// Маршруты IR-пути: описание → план → код → разбор, правки и поиск.
//
// Это второй путь композиции, параллельному LLM-пути (routes/compose.js).
// Разница принципиальная:
//
//   • LLM-путь: модель пишет Strudel-код, сервер его проверяет и чинит.
//     Код непрозрачен, правка = перегенерация.
//   • IR-путь: модель (или правила) выдаёт ТИПИЗИРОВАННЫЙ план, компилятор
//     детерминированно строит код, «сделай мрачнее» = измеримая правка
//     плана, а не новый текст.
//
// Оракул (символьный разбор) считается на сервере: он не требует звука и
// умеет оценивать сотни кандидатов в секунду.
//
// Серверный инвариант (§2.5 брифа): DSP считает браузер, сервер проверяет
// ТОЛЬКО форму. Здесь считается не звук, а символьная структура — это
// разрешено: аудио-метрики по-прежнему приходят от браузера.

import express from 'express';
import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';
import { safeValidateIR } from '../../src/ir/schema.js';
import { applyTransform, TRANSFORMS } from '../../src/ir/transforms.js';
import { symbolicReport } from '../../src/oracle/report.js';
import { searchBest } from '../../src/oracle/search.js';
import { critique } from '../../src/oracle/critic.js';
import { skillsVersion } from '../skills/loader.js';

const router = express.Router();

/** Ответ с IR, кодом и символьным разбором. */
function pack(ir) {
  const validation = safeValidateIR(ir);
  if (!validation.ok) {
    return {
      ok: false,
      error: 'IR не прошёл проверку схемы',
      issues: validation.error.issues?.slice(0, 5) ?? [],
    };
  }
  const compiled = compileIR(validation.data);
  const report = symbolicReport(validation.data);
  return {
    ok: true,
    ir: validation.data,
    code: compiled.code,
    hash: compiled.hash,
    spec: compiled.spec,
    sections: compiled.sections,
    warnings: compiled.warnings,
    // Версия скил-пака, по которой план принимался: без неё результат
    // невоспроизводим — правила могут поменяться.
    skillsVersion: skillsVersion(),
    report: publicReport(report),
  };
}

/** Отчёт без внутренних полей: наружу уходит измеримое. */
function publicReport(report) {
  return {
    bars: report.bars,
    bpm: report.bpm,
    key: report.key,
    genre: report.genre,
    sections: report.sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      bars: section.bars,
      startBar: section.startBar,
      endBar: section.endBar,
      energy: section.energy,
      events: section.events,
    })),
    metrics: report.metrics,
    score: report.score,
    lint: report.lint,
    lintSummary: report.lintSummary,
    registers: report.registers,
  };
}

/**
 * POST /api/music/ir/plan
 * Описание → IR → код + символьный разбор.
 */
router.post('/plan', (req, res) => {
  const { prompt, seed, genre, bpm } = req.body || {};
  const text = String(prompt || '').trim();
  if (!text) {
    res.status(400).json({ error: 'Нужен текст описания' });
    return;
  }
  try {
    const ir = planIR(text, {
      seed: Number.isFinite(seed) ? seed : undefined,
      genre: genre || undefined,
      bpm: Number.isFinite(bpm) ? bpm : undefined,
    });
    res.json(pack(ir));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/music/ir/transform
 * Правка плана: «сделай мрачнее» и прочие типизированные операции.
 */
router.post('/transform', (req, res) => {
  const { ir, transform, role, amount, steps, mode, sectionId, rhythm, template } = req.body || {};
  if (!ir || typeof ir !== 'object') {
    res.status(400).json({ error: 'Нужен план (ir)' });
    return;
  }
  if (!transform || !TRANSFORMS[transform]) {
    res.status(400).json({
      error: `Неизвестная трансформация: ${transform || '—'}`,
      available: Object.keys(TRANSFORMS),
    });
    return;
  }
  try {
    const args = [];
    if (role !== undefined) args.push(role);
    if (amount !== undefined) args.push(amount);
    if (steps !== undefined) args.push(steps);
    if (mode !== undefined) args.push(mode);
    if (sectionId !== undefined) args.push(sectionId);
    if (rhythm !== undefined) args.push(rhythm);
    if (template !== undefined) args.push(template);
    const next = applyTransform(ir, transform, ...args);
    const packed = pack(next);
    if (!packed.ok) {
      res.status(400).json(packed);
      return;
    }
    // Что именно изменилось — показываем числами, а не словами.
    const before = symbolicReport(ir);
    res.json({
      ...packed,
      delta: {
        scoreBefore: before.score.total,
        scoreAfter: packed.report.score.total,
        bpmBefore: before.bpm,
        bpmAfter: packed.report.bpm,
        modeBefore: before.key,
        modeAfter: packed.report.key,
        lintBefore: before.lintSummary.errors,
        lintAfter: packed.report.lintSummary.errors,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/music/ir/search
 * Best-of-N по мутациям плана, оценка — символьным оракулом.
 */
router.post('/search', (req, res) => {
  const { prompt, ir, seed, n, topK } = req.body || {};
  try {
    const base = ir && typeof ir === 'object'
      ? ir
      : planIR(String(prompt || '').trim(), { seed: Number.isFinite(seed) ? seed : undefined });
    const result = searchBest(base, {
      n: Math.max(1, Math.min(64, Number(n) || 16)),
      topK: Math.max(1, Math.min(8, Number(topK) || 3)),
      seed: Number.isFinite(seed) ? seed : undefined,
    });
    res.json({
      ok: true,
      base: { score: result.base.score },
      evaluated: result.evaluated,
      elapsedMs: result.elapsedMs,
      candidates: result.candidates.map((candidate) => ({
        score: candidate.score,
        mutation: candidate.mutation,
        detail: candidate.detail,
        code: candidate.ir ? compileIR(candidate.ir).code : null,
        ir: candidate.ir,
        report: candidate.report ? publicReport(candidate.report) : null,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/music/ir/critique
 * Критик-цикл: замечания → правки → новый скор, с откатом.
 */
router.post('/critique', (req, res) => {
  const { ir } = req.body || {};
  if (!ir || typeof ir !== 'object') {
    res.status(400).json({ error: 'Нужен план (ir)' });
    return;
  }
  try {
    const result = critique(ir);
    const packed = pack(result.ir);
    if (!packed.ok) {
      res.status(400).json(packed);
      return;
    }
    res.json({
      ...packed,
      steps: result.steps,
      improved: result.improved,
      startScore: result.startScore,
    });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

export default router;
