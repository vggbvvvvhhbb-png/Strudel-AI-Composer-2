// API обратной связи по музыке: разбор, улучшение по разбору, варианты A/B.
//
// Здесь замыкается цикл «модель сгенерировала → мы измерили → модель
// переписала под заданный референс». Модель не «слышит» результат — вместо
// этого получает объективные измерения и конкретные замечания.

import { Router } from 'express';
import { z } from 'zod';
import { completeChat } from '../llm/client.js';
import { prompts } from '../prompts.js';
import { staticValidate } from '../../src/core/validator.js';
import { analyzeTrack } from '../music/features.js';
import { scoreTrack, formatReport } from '../music/score.js';
import { resolveProfile, PROFILES } from '../music/references.js';
import { stripCodeFences } from '../music/extract.js';

const router = Router();

const analyzeSchema = z.object({
  code: z.string().min(1).max(20000),
  style: z.string().max(40).optional(),
});

const refineSchema = z.object({
  code: z.string().min(1).max(20000),
  style: z.string().max(40).optional(),
  iterations: z.number().int().min(1).max(3).default(2),
});

const variantsSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  count: z.number().int().min(2).max(4).default(3),
  style: z.string().max(40).optional(),
  currentCode: z.string().max(20000).optional(),
});

// Углы, под которыми генерируются варианты: они заставляют модель искать
// разные решения, а не три раза повторять одно и то же.
const ANGLES = [
  'Сделай акцент на груве: чёткие доли, синопсии, плотные ударные.',
  'Сделай акцент на мелодии: выразительная линия с движением, просторные паузы.',
  'Сделай акцент на басе: качающийся бас, остальные партии не спорят с ним по регистру.',
  'Сделай акцент на атмосфере: пады, воздух, мало атак, но широко по диапазону.',
  'Сделай акцент на ритмическом разнообразии: у каждой партии свой рисунок.',
];

// Разбор кода по референсу стиля.
function analyse(code, styleId, fallbackText = '') {
  const profile = resolveProfile(styleId, fallbackText);
  const analysis = analyzeTrack(code);
  const score = scoreTrack(analysis, profile);
  return { analysis, score, profile };
}

// Публичное описание разбора для интерфейса: метрики + критерии + замечания.
function analysisPayload(code, styleId, fallbackText = '') {
  const { analysis, score, profile } = analyse(code, styleId, fallbackText);
  return {
    analysis: {
      bpm: analysis.bpm,
      key: analysis.key,
      detectedKey: analysis.detectedKey,
      outsideScale: analysis.outsideScale,
      parts: analysis.parts,
      metrics: analysis.metrics,
      errors: analysis.errors,
    },
    score,
    profile: { id: profile.id, name: profile.name, nameRu: profile.nameRu },
    report: formatReport(analysis, score, profile),
  };
}

// POST /api/music/analyze — разбор без обращения к модели.
router.post('/api/music/analyze', (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const { code, style } = parsed.data;
  res.json(analysisPayload(code, style));
});

// POST /api/music/refine — переписывание кода под замечания разбора.
router.post('/api/music/refine', async (req, res) => {
  const parsed = refineSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const { code: startCode, style, iterations } = parsed.data;

  try {
    let current = startCode;
    const before = analysisPayload(current, style);
    const steps = [];

    for (let i = 0; i < iterations; i++) {
      const { analysis, score, profile } = analyse(current, style);
      if (!score.issues.length) {
        steps.push({ iteration: i + 1, applied: false, reason: 'Замечаний нет', score: score.total });
        break;
      }
      const report = formatReport(analysis, score, profile);
      const content = await completeChat({
        messages: [
          { role: 'system', content: prompts.critic },
          {
            role: 'user',
            content: `Текущий код:\n\n${current}\n\n${report}\n\nИсправь замечания и верни полный обновлённый код.`,
          },
        ],
        temperature: 0.5,
      });
      const candidate = stripCodeFences(content);
      const check = staticValidate(candidate);
      if (!check.ok) {
        steps.push({
          iteration: i + 1,
          applied: false,
          reason: `Новый код не прошёл проверку: ${check.error.message}`,
          score: score.total,
        });
        break;
      }
      const next = analysisPayload(candidate, style);
      const gained = next.score.total - score.total;
      if (gained <= 0.5) {
        steps.push({
          iteration: i + 1,
          applied: false,
          reason: `Правка не улучшила разбор (${score.total} → ${next.score.total})`,
          score: score.total,
          candidate,
        });
        break;
      }
      steps.push({
        iteration: i + 1,
        applied: true,
        score: next.score.total,
        gain: Math.round(gained * 10) / 10,
        fixed: score.issues.filter((issue) => !next.score.issues.some((n) => n.id === issue.id)).map((issue) => issue.label),
      });
      current = candidate;
    }

    const after = analysisPayload(current, style);
    res.json({ code: current, before, after, steps, improved: after.score.total > before.score.total });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'Не удалось улучшить трек' });
  }
});

// POST /api/music/variants — best-of-N: несколько вариантов с оценкой каждого.
router.post('/api/music/variants', async (req, res) => {
  const parsed = variantsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const { prompt, count, style, currentCode } = parsed.data;
  const profile = resolveProfile(style, prompt);
  const usage = [];

  try {
    // Варианты считаем параллельно: так best-of-N не растёт по времени.
    const angles = ANGLES.slice(0, count);
    const results = await Promise.all(
      angles.map(async (angle, index) => {
        try {
          const content = await completeChat({
            messages: [
              { role: 'system', content: prompts.system },
              {
                role: 'user',
                content: `Запрос: ${prompt}\n\nДополнительное указание к варианту ${index + 1}: ${angle}\n\nСтиль-ориентир: ${profile.nameRu}.`,
              },
            ],
            temperature: 0.9,
            onUsage: (u) => usage.push(u),
          });
          const code = stripCodeFences(content);
          const check = staticValidate(code);
          if (!check.ok) {
            return { ok: false, angle, error: `Код не прошёл проверку: ${check.error.message}` };
          }
          const payload = analysisPayload(code, style, prompt);
          return { ok: true, angle, code, score: payload.score, report: payload.report };
        } catch (err) {
          return { ok: false, angle, error: err?.message || 'Ошибка генерации' };
        }
      }),
    );

    const variants = results
      .filter((r) => r.ok)
      .sort((a, b) => b.score.total - a.score.total)
      .map((r, index) => ({ ...r, rank: index + 1 }));

    const original = currentCode ? analysisPayload(currentCode, style, prompt) : null;
    res.json({
      variants,
      original,
      profile: { id: profile.id, name: profile.name, nameRu: profile.nameRu },
      usage: usage.map((u) => ({ provider: u.provider, model: u.model, total_tokens: u.total_tokens })),
      failed: results.filter((r) => !r.ok).length,
    });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'Не удалось сгенерировать варианты' });
  }
});

// GET /api/music/styles — список референсов для интерфейса.
router.get('/api/music/styles', (req, res) => {
  res.json({
    styles: Object.values(PROFILES).map((p) => ({ id: p.id, name: p.name, nameRu: p.nameRu })),
  });
});

export default router;
