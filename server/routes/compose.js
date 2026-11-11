// POST /api/music/compose — структурная композиция с потоком событий.
//
// Поток (SSE), события:
//   style      — определён стиль трека
//   spec       — спека принята (или собрана запасная)
//   compiled   — код собран компилятором
//   scored     — оценка трека
//   refined    — улучшение спеки (итерации)
//   done       — финальный код
//   error      — не удалось
//
// Режимы:
//   structured (по умолчанию) — LLM выбирает идеи, компилятор пишет код;
//   free — сырая генерация кода, но результат идёт через тот же валидатор.

import { Router } from 'express';
import { z } from 'zod';
import { completeChat } from '../llm/client.js';
import { prompts } from '../prompts.js';
import { staticValidate } from '../../src/core/validator.js';
import { analyzeTrack } from '../music/features.js';
import { scoreTrack } from '../music/score.js';
import { resolveProfile } from '../music/references.js';
import { stripCodeFences } from '../music/extract.js';
import { buildTrack, detectSpecStyle } from '../music/compose/pipeline.js';
import { refineSpec } from '../music/compose/refine.js';
import { scoreWithV2 } from '../music/compose/score-adapter.js';
import { checkSpec } from '../music/spec/check.js';
import { generateCandidateDetails } from '../music/diversity.js';
import { applyMutation, MUTATION_NAMES } from '../music/mutations.js';
import { compile } from '../music/compiler/index.js';

const router = Router();

const composeSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  mode: z.enum(['structured', 'free']).default('structured'),
  style: z.string().max(40).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  refine: z.boolean().default(true),
  iterations: z.number().int().min(1).max(3).default(2),
});

const variantsSchema = z.object({
  spec: z.record(z.string(), z.unknown()),
  count: z.number().int().min(2).max(6).default(4),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
});

const mutateSchema = z.object({
  spec: z.record(z.string(), z.unknown()),
  mutation: z.string().max(40).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
});

/**
 * Оценка кода: скор v1 по своему парсеру + скор v2 по событиям Strudel.
 *
 * v1 нужен всегда (он даёт привычные критерии и замечания), v2 —
 * развитие во времени. Для refine важна сумма: правка спеки должна
 * поднимать общий балл, а не только новые метрики.
 */
async function scoreCode(code, style, fallbackText = '') {
  const profile = resolveProfile(style, fallbackText);
  const analysis = analyzeTrack(code);
  const v1 = scoreTrack(analysis, profile);
  const v2 = await scoreWithV2(code, style, fallbackText);
  const total = v2 ? Math.round((v1.total * 0.6 + v2.total * 0.4) * 10) / 10 : v1.total;
  return {
    total,
    v1,
    v2,
    issues: [...(v1.issues || []), ...(v2?.issues || [])],
  };
}

// SSE-поток: события {type, ...} как data:-пакеты.
router.post('/api/music/compose', async (req, res) => {
  const parsed = composeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const body = parsed.data;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (type, payload = {}) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  const upstream = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) upstream.abort();
  });

  try {
    // --- Свободный режим: код пишет модель, но проверка та же ---
    if (body.mode === 'free') {
      const content = await completeChat({
        messages: [
          { role: 'system', content: prompts.system },
          { role: 'user', content: `Запрос: ${body.prompt}` },
        ],
        temperature: 0.8,
        signal: upstream.signal,
      });
      const code = stripCodeFences(content);
      const check = staticValidate(code);
      if (!check.ok) {
        send('error', { message: `Код не прошёл проверку: ${check.error.message}` });
        res.end();
        return;
      }
      const score = await scoreCode(code, body.style, body.prompt);
      send('scored', { score });
      send('done', { code, score, mode: 'free' });
      res.end();
      return;
    }

    // --- Структурный режим: спека → компиляция → оценка → refine ---
    const style = body.style && body.style !== 'generic' ? body.style : detectSpecStyle(body.prompt);

    const built = await buildTrack({
      prompt: body.prompt,
      style,
      completeChat,
      seed: body.seed,
      signal: upstream.signal,
      onEvent: (event, payload) => send(event, payload),
    });

    let spec = built.spec;
    let code = built.compiled.code;
    let score = await scoreCode(code, style, body.prompt);

    send('scored', { score, spec });

    // Refine правит спеку и перекомпилирует. Оценка идёт по той же
    // функции, что и у первого прохода, — иначе прирост несопоставим.
    if (body.refine) {
      const refined = await refineSpec({
        spec,
        scoreFn: async (candidateCode) => scoreCode(candidateCode, style, body.prompt),
        maxIterations: body.iterations,
        onEvent: (event, payload) => send(event, payload),
      });
      spec = refined.spec;
      code = refined.code;
      score = {
        total: refined.after.total,
        v1: refined.after.v1,
        v2: refined.after.v2,
        issues: refined.after.issues,
      };
      send('refined', {
        steps: refined.steps,
        before: refined.before.total,
        after: refined.after.total,
        improved: refined.improved,
        spec,
      });
    }

    send('done', { code, spec, score, sections: built.compiled.sections, mode: 'structured' });
  } catch (err) {
    if (!upstream.signal.aborted) {
      send('error', { message: err?.message || 'Ошибка композиции' });
    }
  } finally {
    res.end();
  }
});

/**
 * POST /api/music/compose/variants — варианты на уровне спеки.
 *
 * Различие с /api/music/variants (текстовые углы) принципиальное: здесь
 * берётся одна спека и из неё строятся структурно разные варианты —
 * смена формы, прогрессии, ролей, энергии, мотива. Запрет повторов
 * обеспечивается минимальным расстоянием между спеками.
 */
router.post('/api/music/compose/variants', async (req, res) => {
  const parsed = variantsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const { spec: rawSpec, count, seed } = parsed.data;

  const check = checkSpec(rawSpec);
  if (!check.ok) {
    res.status(400).json({ error: `Спека не прошла проверку: ${check.errors.join('; ')}` });
    return;
  }
  const spec = check.spec;
  const style = spec.meta.style;

  try {
    const candidates = generateCandidateDetails(spec, {
      count,
      seed: seed ?? spec.meta.seed ?? 0,
    });

    const variants = [];
    for (const candidate of candidates) {
      const compiled = compile(candidate.spec);
      const score = await scoreCode(compiled.code, style, '');
      variants.push({
        angle: candidate.angle,
        mutation: candidate.mutation,
        distance: candidate.distance,
        fingerprint: candidate.fingerprint,
        code: compiled.code,
        spec: candidate.spec,
        sections: compiled.sections,
        score,
      });
    }

    // Лучший — по совокупному баллу; при равенстве — по расстоянию
    // (чем дальше от исходной, тем интереснее).
    variants.sort((a, b) => (b.score.total - a.score.total) || (b.distance - a.distance));
    variants.forEach((variant, index) => {
      variant.rank = index + 1;
    });

    res.json({
      variants,
      original: { code: compile(spec).code, spec },
      mutations: MUTATION_NAMES,
    });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'Не удалось построить варианты' });
  }
});

/**
 * POST /api/music/compose/mutate — одна детерминированная мутация спеки.
 *
 * Кнопка «🎲 ещё вариант»: ни одной модели, только преобразование спеки.
 */
router.post('/api/music/compose/mutate', async (req, res) => {
  const parsed = mutateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const { spec: rawSpec, mutation, seed } = parsed.data;

  const check = checkSpec(rawSpec);
  if (!check.ok) {
    res.status(400).json({ error: `Спека не прошла проверку: ${check.errors.join('; ')}` });
    return;
  }
  const spec = check.spec;

  try {
    const name = mutation && MUTATION_NAMES.includes(mutation)
      ? mutation
      : MUTATION_NAMES[Math.abs(seed ?? 0) % MUTATION_NAMES.length];
    const mutated = applyMutation(name, spec, seed ?? 0);
    const mutatedCheck = checkSpec(mutated);
    if (!mutatedCheck.ok) {
      res.status(422).json({ error: `Мутация «${name}» дала невалидную спеку: ${mutatedCheck.errors.join('; ')}` });
      return;
    }
    const compiled = compile(mutatedCheck.spec);
    const score = await scoreCode(compiled.code, spec.meta.style, '');
    res.json({
      mutation: name,
      spec: mutatedCheck.spec,
      code: compiled.code,
      sections: compiled.sections,
      score,
    });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'Не удалось применить мутацию' });
  }
});

export default router;
