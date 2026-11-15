// Поиск по локальной библиотеке: сэмплы, банки, знания, пресеты, навыки.
//
// Этот инструмент работает ВСЕГДА: ни сети, ни ключей, ни LLM. Именно поэтому
// режим ресёрча деградирует не в ошибку, а в «ответ по каталогу».
//
// Про лицензии: сэмплы возвращаются вместе со статусом лицензии из машинного
// реестра (server/music/data/sample-licenses.json). Агент не должен предлагать
// банк, который ждёт решения владельца, как «свободный» — иначе мы сами
// сломаем лицензионную гигиену, которая в D-083 и в docs/LICENSES.md не
// обсуждается.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRESETS } from '../../src/presets/index.js';
import { listSkills } from '../skills/loader.js';
import {
  PROGRESSIONS,
  FORMS,
  RECIPES,
  TRANSITIONS,
  ROLES,
  rolesForStyle,
} from '../music/knowledge/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'music', 'data');

let registryCache = null;

/**
 * Реестр банков и лицензий (читается один раз).
 * @returns {{banks:object, licenses:object}}
 */
function registry() {
  if (!registryCache) {
    const banks = JSON.parse(readFileSync(join(dataDir, 'sample-banks.json'), 'utf8'));
    const licenses = JSON.parse(readFileSync(join(dataDir, 'sample-licenses.json'), 'utf8'));
    registryCache = { banks: banks.banks ?? {}, licenses: licenses.banks ?? {} };
  }
  return registryCache;
}

/**
 * Нормализация для поиска: нижний регистр, «ё» → «е».
 * @param {string} text
 * @returns {string}
 */
function norm(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е');
}

/**
 * Слова-пустышки: в запросе модели они почти всегда есть и ничего не значат.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over',
  'на', 'в', 'и', 'с', 'по', 'для', 'от', 'до', 'а', 'не', 'но', 'или',
  'к', 'из', 'за', 'что', 'как', 'это', 'под', 'над', 'при', 'без',
]);

/**
 * Слова запроса: по ним ищем, когда точная фраза не совпала.
 *
 * ЗАЧЕМ. Модель спрашивает естественным языком («vinyl rain snare reverb
 * kick 808 bass»), а поиск был по целой фразе — такое никогда не находится,
 * и инструмент честно, но бесполезно отвечал «ничего не найдено». По словам
 * запрос находится: «kick» находит банк с kick.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return norm(text)
    .split(/[^a-zа-я0-9+#-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

/**
 * Оценка совпадения: 0 — не совпало, больше — совпало сильнее.
 *
 * @param {string} hay нормализованный текст записи
 * @param {string} needle нормализованный запрос целиком
 * @param {string[]} tokens слова запроса
 * @returns {number}
 */
function scoreMatch(hay, needle, tokens) {
  if (!needle) return 1;
  if (hay.includes(needle)) return 100 + tokens.length;
  let score = 0;
  for (const token of tokens) {
    if (hay.includes(token)) score += 1;
  }
  return score;
}

/**
 * Сэмплы: поиск по именам внутри банков.
 * @param {{query:string, limit?:number}} args
 */
function searchSamples({ query, limit = 10 }) {
  const { banks, licenses } = registry();
  const needle = norm(query);
  const tokens = tokenize(query);
  const hits = [];
  for (const [bank, entry] of Object.entries(banks)) {
    const license = licenses[bank] ?? null;
    for (const name of entry.names ?? []) {
      const score = scoreMatch(norm(name), needle, tokens);
      if (!score) continue;
      hits.push({
        name,
        bank,
        bankUrl: entry.url ?? null,
        // Статус лицензии — обязательное поле, а не украшение.
        license: license?.license ?? 'не подтверждена',
        licenseId: license?.licenseId ?? null,
        verdict: license?.verdict ?? 'требует решения владельца',
        confirmed: Boolean(license?.licenseId),
        commercial: license?.commercial ?? false,
        score,
      });
    }
  }
  // Сначала точные совпадения, потом подтверждённая лицензия, потом имя.
  hits.sort((a, b) => (b.score - a.score) || (Number(a.confirmed) - Number(b.confirmed)) || a.name.localeCompare(b.name, 'en'));
  const total = hits.length;
  const top = hits.slice(0, limit);
  return {
    total,
    hits: top.map(({ score, ...hit }) => hit),
    note: top.length && top.every((h) => !h.confirmed)
      ? 'Ни один найденный сэмпл не имеет подтверждённой лицензии — их нельзя предлагать как свободные.'
      : null,
  };
}

/**
 * Банки целиком (без поиска по именам).
 * @param {{query?:string, limit?:number}} args
 */
function listBanks({ query, limit = 10 }) {
  const { banks, licenses } = registry();
  const needle = norm(query);
  const tokens = tokenize(query);
  return {
    total: Object.keys(banks).length,
    banks: Object.entries(banks)
      .map(([bank, entry]) => ({
        bank,
        url: entry.url ?? null,
        names: (entry.names ?? []).length,
        license: licenses[bank]?.license ?? 'не подтверждена',
        verdict: licenses[bank]?.verdict ?? 'требует решения владельца',
        confirmed: Boolean(licenses[bank]?.licenseId),
        score: scoreMatch(norm(bank), needle, tokens),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ score, ...entry }) => entry),
  };
}

/**
 * Знания: прогрессии, формы, рецепты, переходы, роли.
 * @param {{query:string, limit?:number}} args
 */
function searchKnowledge({ query, limit = 10 }) {
  const needle = norm(query);
  const tokens = tokenize(query);
  const hits = [];

  const push = (kind, id, title, detail) => {
    const hay = norm(`${id} ${title} ${JSON.stringify(detail ?? {})}`);
    const score = scoreMatch(hay, needle, tokens);
    if (!score) return;
    hits.push({ kind, id, title, detail: detail ?? null, score });
  };

  for (const p of PROGRESSIONS) push('progression', p.id ?? p.name, p.name ?? p.id, p);
  for (const [id, form] of Object.entries(FORMS)) push('form', id, form?.name ?? id, form);
  for (const [id, recipe] of Object.entries(RECIPES)) push('recipe', id, id, recipe);
  // TRANSITIONS — объект по типу перехода, а не список.
  for (const [id, transition] of Object.entries(TRANSITIONS)) push('transition', id, id, transition);
  for (const role of ROLES) push('role', role, role, { rolesForStyle: rolesForStyle(role).length });

  hits.sort((a, b) => b.score - a.score);
  return { total: hits.length, hits: hits.slice(0, limit).map(({ score, ...hit }) => hit) };
}

/**
 * Пресеты студии.
 * @param {{query?:string, limit?:number}} args
 */
function listPresets({ query, limit = 10 }) {
  const needle = norm(query);
  const tokens = tokenize(query);
  const hits = PRESETS
    .map((preset) => ({
      preset,
      score: scoreMatch(norm(`${preset.name} ${(preset.tags ?? []).join(' ')} ${preset.bpm} ${preset.key}`), needle, tokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    total: hits.length,
    hits: hits.slice(0, limit).map(({ preset }) => ({
      id: preset.id ?? preset.name,
      name: preset.name,
      tags: preset.tags ?? [],
      bpm: preset.bpm ?? null,
      key: preset.key ?? null,
      code: preset.code ?? null,
    })),
  };
}

/**
 * Карточки навыков.
 * @param {{query?:string, limit?:number}} args
 */
function listSkillCards({ query, limit = 10 }) {
  const needle = norm(query);
  const tokens = tokenize(query);
  const hits = listSkills()
    .map((card) => ({
      card,
      score: scoreMatch(norm(`${card.id} ${card.kind} ${(card.tags ?? []).join(' ')}`), needle, tokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    total: hits.length,
    hits: hits.slice(0, limit).map(({ card }) => ({
      id: card.frontmatter?.id ?? card.id,
      kind: card.frontmatter?.kind ?? null,
      tags: card.frontmatter?.tags ?? [],
    })),
  };
}

/**
 * Единая точка входа: поиск по библиотеке.
 *
 * @param {{query:string, kind?:string, limit?:number}} args
 * @returns {{kind:string, total:number, hits:Array, note?:string|null}}
 */
export function librarySearch({ query = '', kind = 'samples', limit = 10 } = {}) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  switch (kind) {
    case 'banks':
      return { kind, ...listBanks({ query, limit: safeLimit }) };
    case 'knowledge':
      return { kind, ...searchKnowledge({ query, limit: safeLimit }) };
    case 'presets':
      return { kind, ...listPresets({ query, limit: safeLimit }) };
    case 'skills':
      return { kind, ...listSkillCards({ query, limit: safeLimit }) };
    case 'samples':
    default:
      return { kind: 'samples', ...searchSamples({ query, limit: safeLimit }) };
  }
}

/**
 * Версия каталога для ключа кэша: меняется вместе с реестром и знаниями.
 * @returns {string}
 */
export function catalogVersion() {
  const { banks } = registry();
  const parts = [
    Object.keys(banks).length,
    PROGRESSIONS.length,
    Object.keys(FORMS).length,
    Object.keys(RECIPES).length,
    PRESETS.length,
  ];
  return parts.join('-');
}
