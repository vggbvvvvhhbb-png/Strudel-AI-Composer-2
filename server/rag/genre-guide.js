// Жанровые гайды compose: локальный RAG без сетевых эмбеддингов.
import { loadDataset } from './dataset.js';
import { hybridSearch } from './search-core.js';

let cachedEntries;

function guideEntries() {
  if (!cachedEntries) {
    const { entries, errors } = loadDataset();
    if (errors.length) throw new Error(`Не удалось загрузить жанровые гайды: ${errors.map((e) => e.id).join(', ')}`);
    cachedEntries = entries.filter((entry) => entry.education?.guide);
  }
  return cachedEntries;
}

function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\p{Dash_Punctuation}\u2212]/gu, '-')
    .replace(/\s*-\s*/gu, '-')
    .replace(/\s+/gu, ' ').trim();
}

function firstMention(text, entries) {
  const hay = normalizeText(text);
  let best = null;
  for (const entry of entries) {
    const guide = entry.education?.guide;
    if (!guide) continue;
    for (const alias of guide.aliases) {
      const phrase = normalizeText(alias);
      if (!phrase) continue;
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // \b не различает границы кириллических слов. Цифры, combining marks
      // и подчёркивание тоже не должны превращать часть слова в жанр.
      const match = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escaped}(?![\\p{L}\\p{N}\\p{M}_])`, 'u').exec(hay);
      if (match && (!best || match.index < best.index
        || (match.index === best.index && phrase.length > best.alias.length))) {
        best = { genre: guide.genre, alias: phrase, index: match.index };
      }
    }
  }
  return best;
}

/** Запрос имеет приоритет; явный style используется только без алиаса в запросе. */
export function detectGenre(prompt, style, entries = guideEntries()) {
  return (firstMention(prompt, entries) ?? firstMention(style, entries))?.genre ?? null;
}

/** Поиск ограничен гайдами выбранного жанра: ослабление фильтров не меняет жанр. */
export function retrieveGenreGuide(prompt, { style, entries = guideEntries() } = {}) {
  const genre = detectGenre(prompt, style, entries);
  const candidates = entries.filter((entry) => genre && entry.education?.guide?.genre === genre);
  const search = hybridSearch(candidates, {
    query: `${normalizeText(prompt)} ${genre ?? ''}`.trim(),
    queryEmbedding: null,
    topK: 1,
    minResults: 1,
  });
  const entry = search.results[0]?.entry;
  const guide = entry ? {
    id: entry.id,
    title: entry.title,
    direction: entry.education.direction,
    rules: [...entry.education.rules],
    ...structuredClone(entry.education.guide),
  } : null;
  return {
    guide,
    mode: 'lexical',
    semantic: search.semantic,
    degraded: search.degraded,
    reason: search.reason,
    stage: search.stage,
    score: search.results[0]?.score ?? null,
  };
}

/** Правила источника идут в промпт; гармония/ритм/форма остаются рекомендациями. */
export function guideBlock(guide) {
  if (!guide) return '';
  return [
    `Жанровый гайд из локальной базы: ${guide.id} (${guide.genre}).`,
    ...guide.rules.map((rule) => `- ${rule}`),
    `Проверяемый диапазон meta.bpm: ${guide.bpm_range[0]}..${guide.bpm_range[1]} (включительно).`,
    `Обязательные роли part.role: ${guide.required_roles.join(', ') || 'нет'}; ключи партий не являются ролями, дубли ролей допустимы.`,
    `Рекомендуемый аккордовый словарь: ${guide.chord_vocabulary.join(', ') || 'не задан'}.`,
    'Аккордовый словарь, ритм и форма — рекомендации, не результаты автоматической жанровой проверки.',
    'Жанр гайда не заменяет meta.style: используй существующий enum TrackSpec.',
  ].join('\n');
}

/** Только BPM и наличие фактических role; не парсер ритма и не анализ формы. */
export function checkGenreRules(spec, guide) {
  if (!guide) return { ok: true, errors: [] };
  const errors = [];
  const bpm = spec?.meta?.bpm;
  const [min, max] = guide.bpm_range;
  if (!Number.isFinite(bpm) || bpm < min || bpm > max) {
    errors.push({
      code: 'bpm_range', path: 'meta.bpm', expected: [min, max], actual: bpm ?? null,
      message: `meta.bpm: нужен конечный BPM в диапазоне ${min}..${max} для ${guide.genre}, получено ${String(bpm)}`,
    });
  }
  const roles = new Set(Object.values(spec?.parts?.roles ?? {}).map((part) => part?.role));
  for (const role of guide.required_roles) {
    if (!roles.has(role)) errors.push({
      code: 'required_role', path: 'parts.roles', expected: role, actual: [...roles].filter((value) => typeof value === 'string'),
      message: `parts.roles: отсутствует обязательная part.role «${role}» для ${guide.genre}`,
    });
  }
  return { ok: errors.length === 0, errors };
}
