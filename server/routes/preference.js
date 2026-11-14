// Дорожка H: человеческие метки (бриф §7.1, §7.5).
//
// Это узкое место всего проекта: без пар «лучше / хуже» нельзя ни
// проверить символьный скор, ни обучить Taste Model, ни честно сказать,
// что система стала лучше. Поэтому сбор меток — часть API, а не
// «когда-нибудь вручную».
//
//   GET    /api/preference/queue   — очередь пар на суждение;
//   POST   /api/preference         — записать выбор;
//   GET    /api/preference/stats   — счётчики и надёжность рецензента;
//   GET    /api/preference/pairs   — что лежит в реестре пар;
//   GET    /api/preference/export  — выгрузка меток (chosen/rejected для DPO);
//   DELETE /api/preference         — удалить все метки (приватность).
//
// Данные: JSONL, без PII, локально. Экспорт и удаление — одной командой.
//
// Хранение вынесено в server/preference/ledger.js: маршрут — тонкий слой
// над хранилищем, поэтому обучение (server/taste/*) читает те же данные
// из того же места, а не из второй копии формата.

import express from 'express';
import { z } from 'zod';

import {
  appendLabel,
  buildQueue,
  clearAll,
  hashCode,
  labelCoverage,
  labelStats,
  nextQueueOffset,
  readLabels,
  readPairs,
} from '../preference/ledger.js';

const router = express.Router();

/** Разрешённые исходы суждения. */
export const WINNERS = ['A', 'B', 'tie', 'skip'];

/**
 * Аудио-признаки одной стороны (L0), измеренные в браузере при рендере.
 *
 * Именно их не хватало, чтобы обучать Taste Model: до этого метка знала
 * только «победил вот этот хэш», и сравнивать победителя с проигравшим
 * было нечем. Теперь при прослушивании браузер меряет обе стороны тем же
 * DSP-ядром, что и студия, и отдаёт числа с меткой.
 */
export const AudioSideSchema = z.object({
  lufsI: z.number().finite().nullable().optional(),
  lufsS: z.number().finite().nullable().optional(),
  truePeakDbtp: z.number().finite().nullable().optional(),
  peakDbfs: z.number().finite().nullable().optional(),
  crestDb: z.number().finite().nullable().optional(),
  clipCount: z.number().int().min(0).max(1_000_000).nullable().optional(),
  silenceInternal: z.number().finite().min(0).max(600).nullable().optional(),
});

/** Запись метки: без PII, только то, что нужно для статистики. */
export const PreferenceSchema = z.object({
  pairId: z.string().min(1).max(80),
  winner: z.enum(WINNERS),
  listenMs: z.number().int().min(0).max(3_600_000).optional(),
  prompt: z.string().max(300).optional(),
  seed: z.number().int().optional(),
  skillsVersion: z.string().max(80).optional(),
  hashA: z.string().max(80).optional(),
  hashB: z.string().max(80).optional(),
  swapped: z.boolean().optional(),
  source: z.enum(['explicit', 'implicit']).default('explicit'),
  note: z.string().max(200).optional(),
  // Рендер без сэмплов: трек прозвучал неполным. Метка сохраняется (это
  // труд рецензента), но в обучение не идёт — см. server/taste/dataset.js.
  degraded: z.boolean().optional(),
  audio: z.object({
    a: AudioSideSchema.optional(),
    b: AudioSideSchema.optional(),
  }).optional(),
});

// Обратная совместимость: эти имена использовались снаружи.
export { buildQueue, hashCode };
export const readPreferences = readLabels;
export const appendPreference = appendLabel;

/**
 * GET /api/preference/queue — очередь пар.
 *
 * Смещение по умолчанию — продолжение после закрытых пар (nextQueueOffset).
 * Раньше очередь всегда начиналась с нуля, и каждый сеанс предлагал одни и
 * те же первые двадцать промтов: приёмка §7.2 (≥50 разных промтов) была
 * недостижима, а рецензент вязался в одни и те же двадцать треков.
 */
router.get('/queue', (req, res) => {
  try {
    const asked = req.query.offset;
    const offset = asked === undefined || asked === ''
      ? nextQueueOffset()
      : Number(asked);
    const pairs = buildQueue({ limit: req.query.limit, offset });
    res.json({
      ok: true,
      count: pairs.length,
      offset,
      coverage: labelCoverage(),
      pairs,
    });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/preference — записать суждение.
 */
router.post('/', (req, res) => {
  const parsed = PreferenceSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'Метка не прошла проверку',
      issues: parsed.error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }
  try {
    const record = {
      ...parsed.data,
      at: new Date().toISOString(),
    };
    appendLabel(record);
    res.json({ ok: true, total: readLabels().length });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/preference/stats — счётчики и надёжность рецензента.
 */
router.get('/stats', (req, res) => {
  res.json({ ok: true, ...labelStats() });
});

/**
 * GET /api/preference/pairs — что лежит в реестре пар.
 *
 * Без IR (он большой): нужен состав реестра, а не сами планы.
 */
router.get('/pairs', (req, res) => {
  try {
    const pairs = readPairs().map((pair) => ({
      pairId: pair.pairId,
      prompt: pair.prompt,
      seed: pair.seed,
      swapped: pair.swapped,
      repeat: pair.repeat,
      createdAt: pair.createdAt,
      hashA: pair.a?.hash ?? null,
      hashB: pair.b?.hash ?? null,
    }));
    res.json({ ok: true, count: pairs.length, pairs });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/preference/export — выгрузка меток.
 * Формат chosen/rejected — готовый вход для DPO (§7.5).
 */
router.get('/export', (req, res) => {
  const records = readLabels();
  const pairs = new Map();
  for (const record of records) {
    if (record.winner !== 'A' && record.winner !== 'B') continue;
    const key = record.pairId;
    if (!pairs.has(key)) {
      pairs.set(key, { pairId: key, prompt: record.prompt, seed: record.seed, skillsVersion: record.skillsVersion, hashA: record.hashA, hashB: record.hashB });
    }
    const entry = pairs.get(key);
    const winnerHash = record.winner === 'A' ? record.hashA : record.hashB;
    const loserHash = record.winner === 'A' ? record.hashB : record.hashA;
    entry.chosen = winnerHash;
    entry.rejected = loserHash;
    entry.explicit = true;
  }
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="preferences.ndjson"');
  const lines = [...pairs.values()].map((entry) => JSON.stringify(entry));
  res.send(lines.length ? `${lines.join('\n')}\n` : '');
});

/**
 * DELETE /api/preference — удалить все метки (приватность).
 */
router.delete('/', (req, res) => {
  try {
    const removed = clearAll();
    res.json({ ok: true, deleted: true, removed: removed.length });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

export default router;
