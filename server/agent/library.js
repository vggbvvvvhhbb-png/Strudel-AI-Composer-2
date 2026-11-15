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
 * Сэмплы: поиск по именам внутри банков.
 * @param {{query:string, limit?:number}} args
 */
function searchSamples({ query, limit = 10 }) {
  const { banks, licenses } = registry();
  const needle = norm(query);
  const hits = [];
  for (const [bank, entry] of Object.entries(banks)) {
    const license = licenses[bank] ?? null;
    for (const name of entry.names ?? []) {
      if (needle && !norm(name).includes(needle)) continue;
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
      });
      if (hits.length >= limit * 4) break;
    }
    if (hits.length >= limit * 4) break;
  }
  hits.sort((a, b) => Number(a.confirmed) - Number(b.confirmed));
  return {
    total: hits.length,
    hits: hits.slice(0, limit),
    note: hits.length && hits.every((h) => !h.confirmed)
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
  return {
    total: Object.keys(banks).length,
    banks: Object.entries(banks)
      .filter(([bank]) => !needle || norm(bank).includes(needle))
      .slice(0, limit)
      .map(([bank, entry]) => ({
        bank,
        url: entry.url ?? null,
        names: (entry.names ?? []).length,
        license: licenses[bank]?.license ?? 'не подтверждена',
        verdict: licenses[bank]?.verdict ?? 'требует решения владельца',
        confirmed: Boolean(licenses[bank]?.licenseId),
      })),
  };
}

/**
 * Знания: прогрессии, формы, рецепты, переходы, роли.
 * @param {{query:string, limit?:number}} args
 */
function searchKnowledge({ query, limit = 10 }) {
  const needle = norm(query);
  const hits = [];

  const push = (kind, id, title, detail) => {
    const hay = norm(`${id} ${title} ${JSON.stringify(detail ?? {})}`);
    if (needle && !hay.includes(needle)) return;
    hits.push({ kind, id, title, detail: detail ?? null });
  };

  for (const p of PROGRESSIONS) push('progression', p.id ?? p.name, p.name ?? p.id, p);
  for (const [id, form] of Object.entries(FORMS)) push('form', id, form?.name ?? id, form);
  for (const [id, recipe] of Object.entries(RECIPES)) push('recipe', id, id, recipe);
  // TRANSITIONS — объект по типу перехода, а не список.
  for (const [id, transition] of Object.entries(TRANSITIONS)) push('transition', id, id, transition);
  for (const role of ROLES) push('role', role, role, { rolesForStyle: rolesForStyle(role).length });

  return { total: hits.length, hits: hits.slice(0, limit) };
}

/**
 * Пресеты студии.
 * @param {{query?:string, limit?:number}} args
 */
function listPresets({ query, limit = 10 }) {
  const needle = norm(query);
  const hits = PRESETS.filter((preset) => {
    if (!needle) return true;
    return norm(`${preset.name} ${(preset.tags ?? []).join(' ')} ${preset.bpm} ${preset.key}`).includes(needle);
  });
  return {
    total: hits.length,
    hits: hits.slice(0, limit).map((preset) => ({
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
  const cards = listSkills();
  const hits = cards.filter((card) => {
    if (!needle) return true;
    return norm(`${card.id} ${card.kind} ${(card.tags ?? []).join(' ')}`).includes(needle);
  });
  return {
    total: hits.length,
    hits: hits.slice(0, limit).map((card) => ({
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
