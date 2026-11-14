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
//   GET    /api/preference/export  — выгрузка меток (chosen/rejected для DPO);
//   DELETE /api/preference         — удалить все метки (приватность).
//
// Данные: JSONL, без PII, локально. Экспорт и удаление — одной командой.

import express from 'express';
import { z } from 'zod';
import { appendFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';
import { mutateIR } from '../../src/oracle/search.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dataDir = join(root, 'server', 'data');
const labelsFile = join(dataDir, 'preferences.jsonl');

const router = express.Router();

/** Разрешённые исходы суждения. */
export const WINNERS = ['A', 'B', 'tie', 'skip'];

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
});

/**
 * Читает все метки.
 * @returns {Array<object>}
 */
export function readPreferences() {
  if (!existsSync(labelsFile)) return [];
  const raw = readFileSync(labelsFile, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // битая строка не должна ронять чтение лога
    }
  }
  return out;
}

/**
 * Дописывает метку в JSONL.
 * @param {object} record
 */
export function appendPreference(record) {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(labelsFile, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Хэш кода трека — идентификатор кандидата в парах.
 * @param {string} code
 * @returns {string}
 */
export function hashCode(code) {
  return createHash('sha256').update(String(code ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Строит очередь пар для суждения.
 *
 * Пара = два кандидата на один промт: A — план по правилам (текущая
 * система), B — детерминированная мутация того же плана. Стороны
 * переставляются по хэшу пары, чтобы порядок не выдавал систему.
 *
 * Каждая десятая пара — повтор с переставленными сторонами: так измеряется
 * надёжность рецензента (§7.1).
 *
 * @param {{limit?: number, offset?: number}} [options]
 * @returns {Array<object>}
 */
/**
 * Второй кандидат пары: мутация исходного плана.
 *
 * Мутация не всегда меняет план: у эмбиента, например, нет ударных, а
 * мутация плотности бьёт по ролям ударных — и получается пара «сам с собой»,
 * то есть фиктивное сравнение. Поэтому кандидаты перебираются, пока коды не
 * разойдутся; если не разошлись ни одна мутация — берётся другой план того же
 * промта (другая арка придумана тем же seed).
 *
 * @param {object} base исходный IR
 * @param {string} prompt
 * @param {number} seed
 * @param {number} index
 * @returns {{ir:object, code:string}}
 */
function variantFor(base, prompt, seed, index) {
  const baseCode = compileIR(base).code;
  for (let attempt = 0; attempt < MUTATION_TRIES; attempt += 1) {
    const mutated = mutateIR(base, seed, index + attempt);
    const variant = mutated?.ir ?? mutated;
    const code = compileIR(variant).code;
    if (code !== baseCode) return { ir: variant, code };
  }
  const alternative = planIR(prompt, { seed: seed + 997 });
  return { ir: alternative, code: compileIR(alternative).code };
}

/** Сколько мутаций перебирается, прежде чем сдаться. */
const MUTATION_TRIES = 12;

export function buildQueue({ limit = 10, offset = 0 } = {}) {
  const count = Math.max(1, Math.min(60, Number(limit) || 10));
  const from = Math.max(0, Number(offset) || 0);
  const pairs = [];

  for (let index = from; index < from + count && pairs.length < count; index += 1) {
    const id = `pair-${String(index + 1).padStart(3, '0')}`;
    // Каждая десятая пара — повтор предыдущей с переставленными сторонами:
    // так измеряется надёжность рецензента (§7.1).
    const isRepeat = index % 10 === 9;
    const sourceIndex = isRepeat ? index - 9 : index;
    const prompt = PROMPTS[sourceIndex % PROMPTS.length];
    const seed = 2000 + sourceIndex;
    const base = planIR(prompt, { seed });
    const baseCode = compileIR(base).code;
    const variant = variantFor(base, prompt, seed, sourceIndex);
    const variantCode = variant.code;

    // Стороны переставляются детерминированно: порядок не выдаёт систему.
    const baseSwapped = sourceIndex % 2 === 1;
    const swapped = isRepeat ? !baseSwapped : baseSwapped;

    pairs.push({
      id,
      prompt,
      seed,
      a: { code: swapped ? variantCode : baseCode, hash: hashCode(swapped ? variantCode : baseCode) },
      b: { code: swapped ? baseCode : variantCode, hash: hashCode(swapped ? baseCode : variantCode) },
      swapped,
      repeat: isRepeat,
      index,
    });
  }
  return pairs;
}

/**
 * Промты для очереди: по одному на жанр и настроение, чтобы суждение
 * не скатывалось в один стиль.
 */
const PROMPTS = [
  'мрачный трип-хоп про дождь',
  'светлый синтипоп для вечеринки',
  'тревожный эмбиент, пустой космос',
  'злой быстрый dnb',
  'уютный лоуфай для учёбы',
  'нежная колыбельная',
  'эйфоричный фестиваль',
  'меланхолия осеннего города',
  'агрессивный фонк',
  'ностальгическая кассета из 90-х',
];

/**
 * GET /api/preference/queue — очередь пар.
 */
router.get('/queue', (req, res) => {
  try {
    const pairs = buildQueue({ limit: req.query.limit, offset: req.query.offset });
    res.json({ ok: true, count: pairs.length, pairs });
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
    appendPreference(record);
    res.json({ ok: true, total: readPreferences().length });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/preference/stats — счётчики и надёжность рецензента.
 *
 * Надёжность: на повторных парах (те же hashA/hashB, стороны переставлены)
 * считается доля совпадений выбора. При 80% рецензент считается надёжным
 * (§7.2).
 */
router.get('/stats', (req, res) => {
  const records = readPreferences();
  const explicit = records.filter((record) => record.source === 'explicit');
  const decided = explicit.filter((record) => record.winner === 'A' || record.winner === 'B');
  const ties = explicit.filter((record) => record.winner === 'tie').length;
  const skips = records.filter((record) => record.winner === 'skip').length;

  // Повторы: одна и та же пара, оценённая дважды.
  const byPair = new Map();
  for (const record of decided) {
    const key = [record.hashA, record.hashB].sort().join('|');
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(record);
  }
  let repeated = 0;
  let agreements = 0;
  for (const list of byPair.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        repeated += 1;
        // Победитель по хэшам, а не по буквам: стороны могли поменяться.
        const winnerOf = (record) => {
          if (record.winner === 'A') return record.hashA;
          if (record.winner === 'B') return record.hashB;
          return null;
        };
        if (winnerOf(list[i]) && winnerOf(list[i]) === winnerOf(list[j])) agreements += 1;
      }
    }
  }

  const reliability = repeated ? agreements / repeated : null;
  res.json({
    ok: true,
    total: records.length,
    explicit: explicit.length,
    decided: decided.length,
    ties,
    skips,
    pairsJudged: byPair.size,
    repeatedComparisons: repeated,
    agreements,
    reliability: reliability === null ? null : Number(reliability.toFixed(3)),
    reliable: reliability !== null && reliability >= 0.8,
  });
});

/**
 * GET /api/preference/export — выгрузка меток.
 * Формат chosen/rejected — готовый вход для DPO (§7.5).
 */
router.get('/export', (req, res) => {
  const records = readPreferences();
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
 * DELETE /api/preference — удалить все метки.
 * Приватность: удаление одной командой (§2.10).
 */
router.delete('/', (req, res) => {
  try {
    if (existsSync(labelsFile)) rmSync(labelsFile, { force: true });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

export default router;
