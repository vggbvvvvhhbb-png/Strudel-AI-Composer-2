// Поиск сэмплов в Freesound — с жёстким фильтром лицензий.
//
// ЗАЧЕМ. «Охотник» ищет редкий звук в интернете. Единственный источник
// пригодных сэмплов с внятной лицензией — Freesound. Но там лицензия
// у каждого образца своя, и несвободное встречается (NC, ND). Поэтому
// фильтр лицензий здесь ДВОЙНОЙ и fail-closed:
//
//   1. На стороне сервиса: `filter=license:"..."`.
//   2. На нашей стороне: каждый результат проверяется по своему полю
//      license, и всё, что не совпало с белым списком, ВЫБРАСЫВАЕТСЯ.
//
// Если вторую проверку пропустить, а провайдер отдаст лицензию в другой
// форме (URL вместо названия), в пул попадёт несвободное. Fail-closed
// означает: непонятная лицензия — это отказ, а не «наверное, свободная».
//
// ОГРАНИЧЕНИЯ.
//   * Не больше 1 запроса в секунду (лимиты Freesound: 60/мин).
//   * Не больше NIGHT_FS_REQUEST_CAP запросов за ночь (по умолчанию 300).
//   * Хосты: только freesound.org и его CDN. Другие адреса отклоняются —
//     это защита от SSRF через подменённую ссылку.
//   * Ключ не попадает ни в ответ, ни в текст ошибки: он живёт только в
//     заголовке Authorization.
//
// ЧЕСТНОСТЬ. Без ключа инструмент не падает: он говорит, что поиск в
// Freesound недоступен, и агент продолжает по локальной библиотеке.

import { TtlLruCache } from './cache.js';
import { NIGHT_BUDGETS } from './budget.js';
import { usageSummary } from '../stats.js';

/** Базовый адрес поиска Freesound (v2). */
export const FREESOUND_SEARCH_ENDPOINT = 'https://freesound.org/apiv2/search/text/';

/** Хосты, с которых можно брать превью и описания. */
export const ALLOWED_HOSTS = Object.freeze(['freesound.org', 'www.freesound.org', 'cdn.freesound.org']);

/** Минимальный интервал между запросами: 1 запрос в секунду. */
export const MIN_REQUEST_INTERVAL_MS = 1000;

/** TTL кэша поиска: сутки. Каталог сэмплов меняется медленно. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Белый список лицензий.
 *
 * Канонические имена — как их отдаёт Freesound в поиске. В карточке образца
 * лицензия приходит URL-ом, поэтому в белый список входят и формы записи.
 */
export const ALLOWED_LICENSES = Object.freeze({
  cc0: Object.freeze({
    id: 'cc0',
    name: 'Creative Commons 0',
    serviceFilter: 'Creative Commons 0',
    urls: Object.freeze([
      'http://creativecommons.org/publicdomain/zero/1.0/',
      'https://creativecommons.org/publicdomain/zero/1.0/',
      'http://creativecommons.org/publicdomain/zero/1.0',
      'https://creativecommons.org/publicdomain/zero/1.0',
    ]),
  }),
  by: Object.freeze({
    id: 'by',
    name: 'Attribution',
    serviceFilter: 'Attribution',
    urls: Object.freeze([
      'http://creativecommons.org/licenses/by/3.0/',
      'https://creativecommons.org/licenses/by/3.0/',
      'http://creativecommons.org/licenses/by/4.0/',
      'https://creativecommons.org/licenses/by/4.0/',
    ]),
  }),
});

/** Кэш поиска: сутки, до 200 записей. */
const searchCache = new TtlLruCache({ max: 200, ttlMs: CACHE_TTL_MS });

/** Метка времени последнего запроса — для ограничения 1 rps. */
let lastRequestAt = 0;

/**
 * Статус службы Freesound (без раскрытия ключа).
 * @param {object} [env]
 * @returns {{configured:boolean, env:string, available:boolean}}
 */
export function freesoundStatus(env = process.env) {
  const configured = Boolean(String(env?.FREESOUND_API_KEY ?? '').trim());
  return { configured, env: 'FREESOUND_API_KEY', available: configured };
}

/**
 * Канонический идентификатор лицензии по её названию или URL.
 *
 * @param {unknown} value
 * @returns {'cc0'|'cc-by'|null} null — лицензия неизвестна (fail-closed)
 */
export function canonicalLicense(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/\/+$/, '');
  if (lower === 'creative commons 0' || lower === 'cc0') return 'cc0';
  if (lower === 'attribution' || lower === 'cc-by' || lower === 'cc by') return 'cc-by';
  for (const license of Object.values(ALLOWED_LICENSES)) {
    for (const url of license.urls) {
      const normalized = url.toLowerCase().replace(/\/+$/, '');
      if (lower === normalized) return license.id === 'cc0' ? 'cc0' : 'cc-by';
    }
  }
  return null;
}

/**
 * Разрешена ли лицензия. Неизвестная — не разрешена.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAllowedLicense(value) {
  return canonicalLicense(value) !== null;
}

/**
 * Проверка адреса: только https и только разрешённые хосты.
 *
 * @param {string} url
 * @returns {{ok:true, url:string}|{ok:false, reason:string}}
 */
export function checkFreesoundUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: 'некорректный адрес' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `протокол ${parsed.protocol} не читаем` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) {
    return { ok: false, reason: `хост ${host} не в списке разрешённых` };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Состояние ночного бюджета Freesound.
 * @returns {{limit:number, used:number, remaining:number, exhausted:boolean, reason:string|null}}
 */
export function freesoundBudgetState() {
  const summary = usageSummary();
  const feature = summary.byFeature?.freesound_search ?? {};
  const used = Number(feature.requests ?? 0);
  const limit = NIGHT_BUDGETS.freesoundRequests;
  if (used >= limit) {
    return {
      limit,
      used,
      remaining: 0,
      exhausted: true,
      reason: `ночной лимит запросов к Freesound исчерпан: ${used} из ${limit}`,
    };
  }
  return { limit, used, remaining: Math.max(0, limit - used), exhausted: false, reason: null };
}

/**
 * Пауза до следующего допустимого запроса (не больше 1 rps).
 * @param {number} [now]
 * @returns {Promise<number>} сколько ждали, мс
 */
async function throttle(now = Date.now()) {
  const since = now - lastRequestAt;
  if (lastRequestAt && since < MIN_REQUEST_INTERVAL_MS) {
    const wait = MIN_REQUEST_INTERVAL_MS - since;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
  return Math.max(0, since);
}

/**
 * Ключ кэша поиска.
 * @param {{query:string, license:string, durationMax:number, sort:string}} args
 * @returns {string}
 */
export function searchCacheKey({ query, license, durationMax, sort } = {}) {
  return `${license}|${sort}|${durationMax}|${String(query).trim().toLowerCase()}`;
}

/**
 * Поиск сэмплов в Freesound.
 *
 * @param {{query:string, license?:string, durationMax?:number, sort?:string, numResults?:number}} args
 * @param {{env?:object, fetchImpl?:Function, now?:() => number, budgetState?:Function}} [ctx]
 * @returns {Promise<object>}
 */
export async function freesoundSearch({
  query,
  license = 'cc0',
  durationMax = 30,
  sort = 'relevance',
  numResults = 5,
} = {}, ctx = {}) {
  const env = ctx.env ?? process.env;
  const status = freesoundStatus(env);
  const text = String(query || '').trim();
  if (!text) return { ok: false, available: false, degraded: true, reason: 'пустой запрос' };
  if (!status.configured) {
    return {
      ok: false,
      available: false,
      degraded: true,
      reason: `Поиск сэмплов недоступен: не задан ${status.env}. Продолжаю по локальной библиотеке.`,
    };
  }

  const budgetState = ctx.budgetState ?? freesoundBudgetState;
  const budget = budgetState();
  if (budget.exhausted) {
    return {
      ok: false,
      available: true,
      degraded: true,
      reason: `Поиск сэмплов не выполнен: ${budget.reason}. Продолжаю по локальной библиотеке.`,
    };
  }

  const allowed = ALLOWED_LICENSES[license];
  if (!allowed) {
    return {
      ok: false,
      available: true,
      degraded: false,
      reason: `лицензия «${license}» не в списке разрешённых (cc0, by)`,
    };
  }

  const key = searchCacheKey({ query: text, license, durationMax, sort });
  const cached = searchCache.get(key);
  if (cached) return { ...cached, cached: true };

  const filters = [`license:"${allowed.serviceFilter}"`];
  if (Number.isFinite(Number(durationMax)) && Number(durationMax) > 0) {
    filters.push(`duration:[0 TO ${Math.round(Number(durationMax))}]`);
  }
  const url = new URL(FREESOUND_SEARCH_ENDPOINT);
  url.searchParams.set('query', text);
  url.searchParams.set('filter', filters.join(' '));
  url.searchParams.set('sort', sort);
  url.searchParams.set('page_size', String(Math.max(1, Math.min(20, Number(numResults) || 5))));
  url.searchParams.set(
    'fields',
    'id,name,tags,username,license,duration,previews,url,created,download',
  );

  const doFetch = ctx.fetchImpl ?? fetch;
  const keyValue = String(env.FREESOUND_API_KEY);
  try {
    await throttle(ctx.now?.() ?? Date.now());
    const res = await doFetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Token ${keyValue}`, accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 429) {
      return { ok: false, available: true, degraded: true, requestSent: true, reason: 'Freesound отклонил запрос по частоте (429)' };
    }
    if (!res.ok) {
      return { ok: false, available: true, degraded: true, requestSent: true, reason: `Freesound вернул ${res.status}` };
    }
    const json = await res.json();
    const raw = Array.isArray(json?.results) ? json.results : [];
    const accepted = [];
    const rejected = [];
    for (const item of raw) {
      const licenseId = canonicalLicense(item?.license);
      if (!licenseId) {
        rejected.push({ id: item?.id ?? null, license: item?.license ?? null });
        continue;
      }
      const preview = pickPreview(item?.previews);
      if (preview) {
        const check = checkFreesoundUrl(preview);
        if (!check.ok) {
          rejected.push({ id: item?.id ?? null, reason: check.reason });
          continue;
        }
      }
      accepted.push({
        id: item?.id ?? null,
        name: item?.name ?? null,
        username: item?.username ?? null,
        license: item?.license ?? null,
        licenseId,
        duration: Number.isFinite(Number(item?.duration)) ? Number(item.duration) : null,
        tags: Array.isArray(item?.tags) ? item.tags.slice(0, 12) : [],
        url: item?.url ?? null,
        previewUrl: preview,
        created: item?.created ?? null,
      });
    }
    const result = {
      ok: true,
      available: true,
      degraded: false,
      query: text,
      license,
      results: accepted,
      // Отклонённые показываем честно: их было, и они не в белом списке.
      rejected,
      filteredOut: rejected.length,
    };
    searchCache.set(key, result);
    return result;
  } catch (err) {
    // Текст ошибки не должен содержать ключ: в URL его нет, но на всякий
    // случай убираем значение, если провайдер его вернул.
    const message = String(err?.message || err).split(keyValue).join('***');
    return { ok: false, available: true, degraded: true, reason: `Freesound не ответил: ${message}` };
  }
}

/**
 * Превью сэмпла: сначала качественное, потом обычное.
 * @param {object} previews
 * @returns {string|null}
 */
function pickPreview(previews) {
  if (!previews || typeof previews !== 'object') return null;
  for (const key of ['preview-hq-mp3', 'preview-lq-mp3', 'preview-hq-ogg', 'preview-lq-ogg']) {
    const value = previews[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** Сброс кэша и счётчика частоты (нужно тестам). */
export function resetFreesoundState() {
  searchCache.clear();
  lastRequestAt = 0;
}
