// Маршруты скил-паков и LLM-планировщика.
//
//   GET  /api/skills            — реестр карт + версия пака;
//   GET  /api/skills/:id        — карта целиком (frontmatter + тело);
//   POST /api/skills/compile    — учебник под запрос (что уйдёт в промт);
//   POST /api/skills/plan       — LLM-планировщик: описание → IR.
//
// Последний маршрут — тот самый спринт S3.2: модель отвечает типизированным
// планом, компилятор строит код, а «сделай мрачнее» остаётся правкой плана.

import express from 'express';

import { listSkills, skillIndex, getSkill, allSkills, skillsVersion } from '../skills/loader.js';
import { compileSkills, resolveGenre } from '../skills/compile.js';
import { planWithLLM, plannerCacheStats, clearPlannerCache } from '../ir/planner.js';
import { compileIR } from '../../src/ir/compiler.js';
import { safeValidateIR } from '../../src/ir/schema.js';
import { symbolicReport } from '../../src/oracle/report.js';

const router = express.Router();

/** Публичный вид карты: без тела, чтобы не лить в браузер километры текста. */
function cardSummary(card) {
  return {
    id: card.frontmatter.id,
    kind: card.frontmatter.kind,
    version: card.frontmatter.version,
    tags: card.frontmatter.tags,
    refs: card.frontmatter.refs,
    paramRanges: card.frontmatter.paramRanges,
    compactTokens: Math.ceil(card.compact.length / 4),
    examples: card.examples.length,
  };
}

/**
 * GET /api/skills — реестр карт и версия пака.
 */
router.get('/', (req, res) => {
  res.json({
    ok: true,
    skillsVersion: skillsVersion(),
    count: listSkills().length,
    cards: allSkills().map(cardSummary),
    index: skillIndex(),
  });
});

/**
 * GET /api/skills/:id — карта целиком.
 */
router.get('/:id', (req, res) => {
  const card = getSkill(req.params.id);
  if (!card) {
    res.status(404).json({ error: `Карта «${req.params.id}» не найдена` });
    return;
  }
  res.json({
    ok: true,
    ...cardSummary(card),
    frontmatter: card.frontmatter,
    compact: card.compact,
    recipe: card.recipe,
    sections: card.sections,
    examples: card.examples,
  });
});

/**
 * POST /api/skills/compile — собрать учебник под запрос.
 * То, что реально уходит в системный промт планировщика.
 */
router.post('/compile', (req, res) => {
  const { prompt, mood, genre, valence, arousal } = req.body || {};
  const text = String(prompt || '').trim();
  if (!text) {
    res.status(400).json({ error: 'Нужен текст описания' });
    return;
  }
  try {
    const book = compileSkills({ prompt: text, mood: mood || null, genre: genre || null, valence, arousal });
    res.json({
      ok: true,
      skillsVersion: book.skillsVersion,
      tokens: book.tokens,
      used: book.used,
      truncated: book.truncated,
      genre: resolveGenre({ prompt: text, mood: mood || null, genre: genre || null }),
      text: book.text,
    });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/skills/plan — LLM-планировщик: описание → IR → код + разбор.
 *
 * Тело: { prompt, seed?, genre?, bpm?, maxCalls?, withCode? }
 * Ответ: IR, скомпилированный код, символьный отчёт и метаданные вызовов.
 */
router.post('/plan', async (req, res) => {
  const { prompt, seed, genre, bpm, maxCalls, withCode } = req.body || {};
  const text = String(prompt || '').trim();
  if (!text) {
    res.status(400).json({ error: 'Нужен текст описания' });
    return;
  }
  try {
    const result = await planWithLLM({
      prompt: text,
      seed: Number.isFinite(seed) ? seed : undefined,
      genre: genre || null,
      bpm: Number.isFinite(bpm) ? bpm : null,
      maxCalls: Number.isFinite(maxCalls) ? Math.min(3, Math.max(1, maxCalls)) : undefined,
    });
    const validation = safeValidateIR(result.ir);
    if (!validation.ok) {
      res.status(400).json({
        error: 'IR не прошёл проверку схемы',
        issues: validation.error.issues?.slice(0, 5) ?? [],
      });
      return;
    }
    const compiled = compileIR(validation.data);
    const report = symbolicReport(validation.data);
    res.json({
      ok: true,
      source: result.source,
      calls: result.calls,
      repaired: result.repaired,
      cached: result.cached ?? false,
      reason: result.reason ?? null,
      issues: result.issues ?? [],
      skillsVersion: result.skillsVersion,
      bookTokens: result.bookTokens,
      ir: validation.data,
      code: withCode === false ? null : compiled.code,
      hash: compiled.hash,
      report: {
        score: report.score,
        lintSummary: report.lintSummary,
        sections: report.sections.map((section) => ({
          id: section.id, kind: section.kind, bars: section.bars,
          startBar: section.startBar, endBar: section.endBar, energy: section.energy,
        })),
        bpm: report.bpm,
        key: report.key,
        genre: report.genre,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/skills/cache/clear — сброс кэша планировщика.
 * Нужен, когда карты поправили вручную и результат надо пересчитать.
 */
router.post('/cache/clear', (req, res) => {
  clearPlannerCache();
  res.json({ ok: true, cache: plannerCacheStats() });
});

export default router;
