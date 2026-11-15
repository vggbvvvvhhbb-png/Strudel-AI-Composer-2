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
import { formatAudioRemarks } from '../music/compose/audio-remarks.js';
import { scoreAudioReport, combineScores } from '../music/compose/audio-score.js';
import { parseMetricsReport } from '../../src/audio/metrics-report.js';
import { runAudioQa } from '../../src/audio/qa.js';

const router = Router();

const analyzeSchema = z.object({
  code: z.string().min(1).max(20000),
  style: z.string().max(40).optional(),
  // Отчёт о рендере из браузера (Audio QA). Форма проверяется, числа — нет:
  // аудио на сервере отсутствует.
  audioReport: z.unknown().optional(),
  useAudio: z.boolean().default(true),
});

const refineSchema = z.object({
  code: z.string().min(1).max(20000),
  style: z.string().max(40).optional(),
  iterations: z.number().int().min(1).max(3).default(2),
  // Замечания по отрендеренному аудио (Audio QA). Приходят из браузера:
  // рендер живёт в AudioContext, на сервере аудио нет. Текст замечаний —
  // данные, а не инструкции (см. formatAudioRemarks).
  audioRemarks: z
    .array(
      z.object({
        code: z.string().min(1).max(60),
        severity: z.enum(['error', 'warning']).optional(),
        label: z.string().max(200).optional(),
        hint: z.string().max(500).optional(),
        params: z.record(z.any()).optional(),
      }),
    )
    .max(50)
    .optional(),
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
function analysisPayload(code, styleId, fallbackText = '', audioReport = null) {
  const { analysis, score, profile } = analyse(code, styleId, fallbackText);
  // Аудио-блок: 20% общего скора, если отчёт о рендере пришёл.
  const audio = audioReport ? scoreAudioReport(audioReport) : null;
  const total = audio ? combineScores(score.total, null, audio.total) : score.total;
  const findings = audioReport ? runAudioQa(audioReport) : [];
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
    score: {
      ...score,
      // Итоговый балл с учётом аудио-блока; v1Total — балл только по разбору кода.
      v1Total: score.total,
      total,
      audio: audio ? { total: audio.total, checks: audio.checks, issues: audio.issues } : null,
    },
    audio: audio
      ? {
          total: audio.total,
          findings,
          report: audioSummary(audioReport),
        }
      : null,
    profile: { id: profile.id, name: profile.name, nameRu: profile.nameRu },
    report: formatReport(analysis, score, profile),
  };
}

/** Ключевые числа отчёта — без всего подряд, только то, что человек смотрит. */
function audioSummary(report) {
  if (!report) return null;
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(2)) : null);
  return {
    engineVersion: report.engineVersion ?? null,
    renderMode: report.renderMode ?? null,
    lufsI: num(report.lufsI),
    truePeakDbtp: num(report.truePeakDbtp),
    peakDbfs: num(report.peakDbfs),
    crestDb: num(report.crestDb),
    clipCount: report.clipCount ?? 0,
    bands: report.bands ?? null,
    silence: report.silence ?? null,
    repeatability: report.repeatability ?? null,
  };
}

// POST /api/music/analyze — разбор без обращения к модели.
router.post('/api/music/analyze', (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const { code, style, audioReport, useAudio } = parsed.data;
  const audio = useAudio && audioReport ? parseMetricsReport(audioReport) : { ok: false, report: null };
  res.json({
    ...analysisPayload(code, style, '', audio.ok ? audio.report : null),
    audioRejected: useAudio && audioReport && !audio.ok ? audio.error : null,
  });
});

// POST /api/music/refine — переписывание кода под замечания разбора.
router.post('/api/music/refine', async (req, res) => {
  const parsed = refineSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const { code: startCode, style, iterations, audioRemarks } = parsed.data;

  try {
    let current = startCode;
    const before = analysisPayload(current, style);
    const steps = [];

    // Замечания по аудио — отдельный вход: они не меняют разбор кода, но
    // показывают модели, что не так со звучанием (громкость, клиппинг, пик).
    const audioBlock = formatAudioRemarks(audioRemarks || []);

    for (let i = 0; i < iterations; i++) {
      const { analysis, score, profile } = analyse(current, style);
      if (!score.issues.length && !audioBlock) {
        steps.push({ iteration: i + 1, applied: false, reason: 'Замечаний нет', score: score.total });
        break;
      }
      const report = formatReport(analysis, score, profile);
      const content = await completeChat({
        messages: [
          { role: 'system', content: prompts.critic },
          {
            role: 'user',
            content:
              `Текущий код:\n\n${current}\n\n${report}\n\n${audioBlock}\n\n` +
              'Исправь замечания и верни полный обновлённый код.',
          },
        ],
        temperature: 0.5,
        feature: 'refine',
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
            feature: 'variants',
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
