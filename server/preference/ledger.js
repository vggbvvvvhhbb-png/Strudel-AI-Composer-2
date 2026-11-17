// Реестр пар и меток (дорожка H, бриф §7.1 и §7.4).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. До сих пор метка хранила только хэши двух треков:
// «победил вот этот». Из хэшей нельзя обучить ничего — нечем сравнивать
// победителя с проигравшим, потому что признаки не сохранились. Поэтому
// «выученная цель» была невозможна не из-за нехватки данных, а из-за
// нехватки СПОСОБА их использовать.
//
// Реестр решает ровно это: пара рождается вместе со своими признаками.
//
//   • server/data/pairs.jsonl — пары: промпт, зерно, IR обеих сторон,
//     хэши кода. IR хранится, а не только хэш: признаки пересчитываются
//     из IR при обучении, поэтому смена состава признаков не убивает
//     старые пары (они просто пересчитываются).
//   • server/data/preferences.jsonl — метки: кто победил, сколько слушал,
//     и аудио-признаки каждой стороны, измеренные в браузере (L0).
//
// Приватность: ни PII, ни персональных данных; удаление — одной командой.
//
// Файлы вне git (server/data/ в .gitignore).

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';
import { mutateIR } from '../../src/oracle/search.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/**
 * Каталог хранения меток и пар.
 *
 * Переопределяется переменной окружения STRUDEL_DATA_DIR: тесты работают
 * в своём каталоге, поэтому не мешают настоящим меткам владельца и не
 * ломают друг друга параллельно (vitest гоняет файлы тестов в разных
 * процессах).
 *
 * @returns {string}
 */
export function dataDir() {
  const override = process.env.STRUDEL_DATA_DIR;
  return override ? resolve(override) : join(root, 'server', 'data');
}

/** Файл меток. */
export function labelsFile() {
  return join(dataDir(), 'preferences.jsonl');
}

/** Файл реестра пар. */
export function pairsFile() {
  return join(dataDir(), 'pairs.jsonl');
}

/**
 * Сколько разных промтов нужно закрыть для приёмки (бриф §7.2).
 */
export const REQUIRED_UNIQUE_PROMPTS = 50;

/**
 * Промты для очереди: по одному на жанр и настроение, чтобы суждение
 * не скатывалось в один стиль.
 */
export const PROMPTS = [
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
 * Пул промтов для очереди: 60 стратифицированных промтов корпуса
 * Baseline-0 (4 квадранта × 5 жанров × 3 плотности).
 *
 * Зачем: приёмка по брифу §7.2 требует ≥50 РАЗНЫХ промтов, а очередь из
 * десяти строк даёт десять — и все суждения скатываются в один стиль.
 *
 * Файл лежит рядом с модулем, потому что каталог corpus/ в образ не
 * попадает, а очередь нужна и на сервере. Связь с корпусом проверяется
 * по хэшу (npm run queue:prompts --check).
 *
 * @returns {Array<{id:string, prompt:string, seed:number, quadrant?:string, genre?:string, density?:string}>}
 */
export function promptPool() {
  const file = join(here, 'prompts.json');
  const fallback = () => PROMPTS.map((prompt, index) => ({
    id: `fallback-${index}`,
    prompt,
    seed: 2000 + index,
  }));
  if (!existsSync(file)) return fallback();
  try {
    const document = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(document?.prompts) ? document.prompts : [];
    return list.length ? list : fallback();
  } catch {
    return fallback();
  }
}

/**
 * Тип пары: 'track' (композиция, IR) или 'timbre' (тембр, D-132).
 * Смотрится в реестре пар; запасной вариант — поле метки. Старые пары
 * и метки без типа — трековые (обратная совместимость).
 *
 * @param {object} record метка
 * @param {Map<string,object>} [pairsById]
 * @returns {'track'|'timbre'}
 */
export function pairTypeOf(record, pairsById = new Map(readPairs().map((pair) => [pair.pairId, pair]))) {
  const type = pairsById.get(record.pairId)?.type ?? record.pairType;
  return type === 'timbre' ? 'timbre' : 'track';
}

/**
 * Смещение очереди: сколько пар рецензент уже закрыл.
 *
 * Зачем: очередь всегда начиналась с нуля, и каждый сеанс предлагал одни и
 * те же первые двадцать промтов. Приёмка по брифу §7.2 требует ≥50 РАЗНЫХ
 * промтов — с таким поведением она недостижима в принципе: владелец будет
 * бесконечно судить одно и то же. Смещение берётся по максимальному
 * индексу оценённой пары, поэтому непройденные пары возвращаются, а
 * пройденные не повторяются.
 *
 * Тип очереди разделяет счётчики: тембровые пары (D-132) живут в своём
 * индексном пространстве и не двигают смещение трековой очереди.
 *
 * @param {'track'|'timbre'} [type]
 * @returns {number}
 */
export function nextQueueOffset(type = 'track') {
  const pairs = new Map(readPairs().map((pair) => [pair.pairId, pair]));
  let max = -1;
  for (const record of readLabels()) {
    const winner = record.winner;
    // Ничья — тоже суждение (промт закрыт), «пропуск» — нет.
    if (winner !== 'A' && winner !== 'B' && winner !== 'tie') continue;
    if (pairTypeOf(record, pairs) !== type) continue;
    const index = pairs.get(record.pairId)?.index;
    if (Number.isInteger(index) && index > max) max = index;
  }
  return max + 1;
}

/**
 * Покрытие промтов: сколько разных промтов закрыто суждениями рецензента.
 *
 * Это ровно тот счётчик, который смотрит приёмка (§7.2): не «сколько пар
 * оценено», а «сколько разных промтов услышано». Считается по реестру пар
 * (там промт надёжнее, чем в самой метке), с запасным вариантом из метки.
 *
 * Тембровые пары (D-132) в покрытие НЕ входят: их промты — не промты
 * корпуса Baseline-0, и засчитывать их в приёмку ≥50 промтов было бы
 * подменой измерения. Они считаются отдельно (timbreJudged).
 *
 * @returns {{judgedPairs:number, uniquePrompts:number, promptsNeeded:number, timbreJudged:number}}
 */
export function labelCoverage() {
  const pairs = new Map(readPairs().map((pair) => [pair.pairId, pair]));
  const prompts = new Set();
  const judged = new Set();
  const timbreJudged = new Set();
  for (const record of readLabels()) {
    const winner = record.winner;
    if (winner !== 'A' && winner !== 'B' && winner !== 'tie') continue;
    if (pairTypeOf(record, pairs) === 'timbre') {
      timbreJudged.add(record.pairId);
      continue;
    }
    judged.add(record.pairId);
    const prompt = pairs.get(record.pairId)?.prompt ?? record.prompt;
    if (prompt) prompts.add(prompt);
  }
  return {
    judgedPairs: judged.size,
    uniquePrompts: prompts.size,
    promptsNeeded: REQUIRED_UNIQUE_PROMPTS,
    timbreJudged: timbreJudged.size,
  };
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
 * Читает все метки.
 * @returns {Array<object>}
 */
export function readLabels() {
  return readJsonl(labelsFile());
}

/**
 * Дописывает метку в JSONL.
 * @param {object} record
 */
export function appendLabel(record) {
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(labelsFile(), `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Читает все пары из реестра.
 * @returns {Array<object>}
 */
export function readPairs() {
  return readJsonl(pairsFile());
}

/**
 * Дописывает пару в реестр (идемпотентно по pairId: повторная запись
 * с тем же id перезаписывает запись, а не плодит дубли).
 * @param {object} record
 */
export function upsertPair(record) {
  mkdirSync(dataDir(), { recursive: true });
  const existing = readPairs();
  const index = existing.findIndex((pair) => pair.pairId === record.pairId);
  if (index >= 0) {
    existing[index] = record;
    writeJsonl(pairsFile(), existing);
    return record;
  }
  appendFileSync(pairsFile(), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * Удаляет все метки и пары (приватность — одной командой, §2.10).
 */
export function clearAll() {
  const removed = [];
  for (const file of [labelsFile(), pairsFile()]) {
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    removed.push(file);
  }
  return removed;
}

/**
 * Сколько мутаций перебирается, прежде чем сдаться.
 */
const MUTATION_TRIES = 12;

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
 * Пара кладётся в реестр вместе с IR обеих сторон: оттуда потом берутся
 * признаки для обучения.
 *
 * @param {{limit?: number, offset?: number}} [options]
 * @returns {Array<object>}
 */
export function buildQueue({ limit = 10, offset = 0 } = {}) {
  const count = Math.max(1, Math.min(60, Number(limit) || 10));
  const from = Math.max(0, Number(offset) || 0);
  const pairs = [];
  const pool = promptPool();

  for (let index = from; index < from + count && pairs.length < count; index += 1) {
    const id = `pair-${String(index + 1).padStart(3, '0')}`;
    // Каждая десятая пара — повтор предыдущей с переставленными сторонами:
    // так измеряется надёжность рецензента (§7.1).
    const isRepeat = index % 10 === 9;
    const sourceIndex = isRepeat ? index - 9 : index;
    const entry = pool[sourceIndex % pool.length];
    const prompt = entry.prompt;
    // Зерно: первый круг — зерно корпуса (тот самый Baseline-0 трек),
    // следующие круги — сдвиг, чтобы пары не повторялись по треку.
    const lap = Math.floor(sourceIndex / pool.length);
    const seed = Number(entry.seed ?? 2000) + lap * 7919;
    const base = planIR(prompt, { seed });
    const baseCode = compileIR(base).code;
    const variant = variantFor(base, prompt, seed, sourceIndex);
    const variantCode = variant.code;
    const variantIr = variant.ir;

    // Стороны переставляются детерминированно: порядок не выдаёт систему.
    const baseSwapped = sourceIndex % 2 === 1;
    const swapped = isRepeat ? !baseSwapped : baseSwapped;

    const left = swapped ? variantIr : base;
    const right = swapped ? base : variantIr;
    const leftCode = swapped ? variantCode : baseCode;
    const rightCode = swapped ? baseCode : variantCode;

    const record = {
      pairId: id,
      prompt,
      promptId: entry.id ?? null,
      quadrant: entry.quadrant ?? null,
      genre: entry.genre ?? null,
      density: entry.density ?? null,
      seed,
      swapped,
      repeat: isRepeat,
      index,
      createdAt: new Date().toISOString(),
      a: { hash: hashCode(leftCode), ir: left },
      b: { hash: hashCode(rightCode), ir: right },
    };

    upsertPair(record);
    pairs.push({
      id,
      pairId: id,
      prompt,
      promptId: record.promptId,
      quadrant: record.quadrant,
      genre: record.genre,
      seed,
      a: { code: leftCode, hash: record.a.hash },
      b: { code: rightCode, hash: record.b.hash },
      swapped,
      repeat: isRepeat,
      index,
    });
  }
  return pairs;
}

/**
 * Находит пару в реестре.
 * @param {string} pairId
 * @returns {object|null}
 */
export function findPair(pairId) {
  return readPairs().find((pair) => pair.pairId === pairId) ?? null;
}

/**
 * Считает метки: решения, ничьи, пропуски и надёжность рецензента.
 *
 * Надёжность: на повторных парах (те же hashA/hashB, стороны переставлены)
 * считается доля совпадений выбора. При 80% рецензент считается надёжным
 * (§7.2).
 *
 * @returns {object}
 */
export function labelStats() {
  const records = readLabels();
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
  return {
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
    pairs: readPairs().length,
    // Сколько РАЗНЫХ промтов закрыто суждениями: это тот счётчик, который
    // смотрит приёмка (§7.2). «Сколько пар оценено» — не то же самое.
    ...labelCoverage(),
  };
}

// --- внутреннее ---

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
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

function writeJsonl(file, records) {
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  writeFileSync(file, body ? `${body}\n` : '', 'utf8');
}
