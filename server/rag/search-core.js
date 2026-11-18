// Ядро гибридного поиска базы знаний — чистые функции, общие для
// локального и Supabase-хранилища (D-134/D-137). Порядок: жёсткий фильтр
// по метаданным → векторное ранжирование → мягкий fallback по стадиям,
// если выдача меньше minResults. Детерминизм: тай-брейк по id.

import { normalizeTonic } from './music-check.js';

export const FILTER_STAGES = ['exact', 'tonic', 'genre-roles', 'all'];

const STOP_WORDS = new Set([
  'и', 'в', 'на', 'с', 'для', 'по', 'из', 'the', 'a', 'an', 'in', 'on', 'with', 'for', 'of',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9#]+/i)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function intersects(a, b) {
  return a.some((x) => b.includes(x));
}

/** Фильтр стадии. genre/roles/complexity учитываются, только если заданы. */
export function stageFilter(entry, filters, stage) {
  const f = filters || {};
  const tags = entry.music_tags;
  const tonic = f.tonic ? normalizeTonic(f.tonic) : null;
  if (stage === 'exact') {
    if (tonic && normalizeTonic(tags.tonic) !== tonic) return false;
    if (f.mode && tags.mode !== f.mode) return false;
  } else if (stage === 'tonic') {
    // родственные лады: тоника та же, лад любой
    if (tonic && normalizeTonic(tags.tonic) !== tonic) return false;
  } else if (stage === 'genre-roles') {
    const genreOk = !f.genre?.length || intersects(f.genre, tags.genre);
    const rolesOk = !f.roles?.length || intersects(f.roles, tags.roles);
    if (!genreOk && !rolesOk) return false;
  }
  if (f.genre?.length && stage === 'exact' && !intersects(f.genre, tags.genre)) return false;
  if (f.roles?.length && (stage === 'exact' || stage === 'tonic') && !intersects(f.roles, tags.roles)) return false;
  if (f.complexity && stage === 'exact' && tags.complexity !== f.complexity) return false;
  return true;
}

export function cosineSimilarity(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Лексическое сходство запроса с записью (фолбэк без эмбеддингов). */
export function lexicalScore(query, entry) {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const doc = new Set(tokenize(`${entry.title} ${entry.description} ${entry.rationale} ${entry.music_tags.genre.join(' ')} ${entry.music_tags.roles.join(' ')} ${(entry.education?.rules || []).join(' ')}`));
  const title = new Set(tokenize(entry.title));
  let hits = 0;
  let titleHits = 0;
  for (const t of q) {
    if (doc.has(t)) hits += 1;
    if (title.has(t)) titleHits += 1;
  }
  return hits / q.length + 0.2 * (titleHits / q.length);
}

/**
 * Ранжирование кандидатов. С эмбеддингами — косинус; записи без
 * эмбеддинга получают лексический балл с понижающим коэффициентом 0.5
 * (честно хуже семантики, а не имитация). Без эмбеддинга запроса —
 * лексика для всех. Тай-брейк по id — детерминизм.
 */
export function rankCandidates(candidates, query, queryEmbedding) {
  const scored = candidates.map((entry) => {
    let score;
    if (queryEmbedding && Array.isArray(entry.embedding)) {
      score = cosineSimilarity(queryEmbedding, entry.embedding);
    } else if (queryEmbedding) {
      score = 0.5 * lexicalScore(query, entry);
    } else {
      score = lexicalScore(query, entry);
    }
    return { entry, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.entry.id < b.entry.id ? -1 : 1));
  return scored;
}

/**
 * Гибридный поиск по массиву записей (локальное хранилище и тесты).
 * @returns {{results: Array<{entry: object, score: number}>, stage: string,
 *   semantic: boolean, degraded: boolean, reason: string|null}}
 */
export function hybridSearch(entries, { query, queryEmbedding = null, filters = {}, topK = 3, minResults = 3 } = {}) {
  const semantic = Boolean(queryEmbedding);
  let results = [];
  let stage = 'exact';
  for (const s of FILTER_STAGES) {
    stage = s;
    const candidates = entries.filter((e) => stageFilter(e, filters, s));
    results = rankCandidates(candidates, query, queryEmbedding).slice(0, topK);
    if (results.length >= Math.min(minResults, topK)) break;
  }
  const degraded = stage !== 'exact' || !semantic;
  const reasons = [];
  if (stage !== 'exact') reasons.push(`фильтры ослаблены до стадии «${stage}» (мало точных совпадений)`);
  if (!semantic) reasons.push('семантический поиск недоступен — лексическое ранжирование');
  return { results, stage, semantic, degraded, reason: reasons.length ? reasons.join('; ') : null };
}