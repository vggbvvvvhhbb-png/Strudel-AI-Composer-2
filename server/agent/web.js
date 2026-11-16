// Веб-инструменты: поиск и чтение страниц — с честной деградацией.
//
// ПРАВИЛО (из донорской webConfig.ts и из гайда): нет ключа провайдера поиска —
// режим не падает. Он отвечает по локальной библиотеке и САМ ГОВОРИТ, что
// интернета нет. Значения ключей никогда не попадают в ответ — только имена
// переменных.
//
// Ключ один на оба веб-инструмента (EXA_API_KEY): «интернет» — это одна
// внешняя способность, а не две. Если ключа нет, недоступны и поиск, и
// чтение страниц: так честнее, чем «искать нельзя, а читать можно».
//
// SSRF: страницы читаем только по http(s) и только для публичных хостов.
// Локальные адреса и метаданные (169.254.169.254) закрыты.

import { WEB_SERVICES } from './services.js';

const SEARCH_ENDPOINT = 'https://api.exa.ai/search';
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_MAX_BYTES = 200_000;

/**
 * Статус веб-сервисов: есть ли ключ (без раскрытия значения).
 * @param {object} [env]
 * @returns {{search:{configured:boolean, env:string}, missing:string[], internet:boolean}}
 */
export function webServicesStatus(env = process.env) {
  const missing = [];
  const services = {};
  for (const [name, envName] of Object.entries(WEB_SERVICES)) {
    const configured = Boolean(String(env?.[envName] ?? '').trim());
    services[name] = { configured, env: envName };
    if (!configured) missing.push(envName);
  }
  return { ...services, missing, internet: missing.length === 0 };
}

/**
 * @param {object} [env]
 * @returns {boolean}
 */
export function internetAvailable(env = process.env) {
  return webServicesStatus(env).internet;
}

/**
 * Хост в приватной сети? Закрываем и локальные адреса, и метаданные.
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal' || host === '169.254.169.254') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  return false;
}

/**
 * Проверка URL перед запросом.
 * @param {string} url
 * @returns {{ok:true, url:string}|{ok:false, reason:string}}
 */
export function checkFetchUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: 'некорректный URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `протокол ${parsed.protocol} не читаем` };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: 'адрес внутренней сети недоступен' };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Поиск в интернете.
 *
 * @param {{query:string, numResults?:number, depth?:string}} args
 * @param {{env?:object, fetchImpl?:Function}} [ctx]
 * @returns {Promise<object>} результат или честная деградация
 */
export async function webSearch({ query, numResults = 5, depth = 'basic' } = {}, ctx = {}) {
  const env = ctx.env ?? process.env;
  const status = webServicesStatus(env);
  const text = String(query || '').trim();
  if (!text) return { ok: false, available: false, degraded: true, reason: 'пустой запрос' };
  if (!status.search.configured) {
    return {
      ok: false,
      available: false,
      degraded: true,
      reason: `Интернет недоступен: не задан ${status.search.env}. Отвечаю по локальной библиотеке.`,
    };
  }
  // Бюджет ночи — стоп, а не предупреждение: если исчерпан, поиск не идёт.
  if (ctx.budgetState) {
    const budget = ctx.budgetState();
    if (budget.exhausted) {
      return {
        ok: false,
        available: true,
        degraded: true,
        reason: `Поиск не выполнен: ${budget.reason}. Отвечаю по локальной библиотеке.`,
      };
    }
  }
  const key = String(env[status.search.env] ?? '').trim();
  const doFetch = ctx.fetchImpl ?? fetch;
  try {
    const res = await doFetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        query: text,
        numResults: Math.max(1, Math.min(10, Number(numResults) || 5)),
        contents: { text: { maxCharacters: 1200 } },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, available: true, degraded: true, reason: `поиск вернул ${res.status}` };
    }
    const json = await res.json();
    const results = (json.results ?? []).map((item) => {
      // Текст страницы приходит из поиска (contents.text): до 10 результатов
      // с содержимым входят в цену поиска, отдельная платная загрузка не
      // нужна. Поэтому сохраняем текст целиком, а не только обрезок.
      const pageText = String(item.text ?? item.snippet ?? '');
      return {
        title: item.title ?? null,
        url: item.url ?? null,
        snippet: pageText.slice(0, 600),
        text: pageText,
        textChars: pageText.length,
        publishedDate: item.publishedDate ?? null,
      };
    });
    // Цена запроса измеряется провайдером: costDollars.total — это факт,
    // а не оценка по числу токенов (D-102).
    const cost = json.costDollars && typeof json.costDollars === 'object'
      ? {
        total: Number(json.costDollars.total ?? 0),
        search: json.costDollars.search ?? null,
      }
      : null;
    return { ok: true, available: true, degraded: false, query: text, results, depth, costDollars: cost };
  } catch (err) {
    return { ok: false, available: true, degraded: true, reason: `поиск не удался: ${err?.message || err}` };
  }
}

/**
 * Чтение страницы.
 *
 * Если текст уже есть (он приходит из поиска — contents.text входит в цену
 * поиска), страницу второй раз не качаем: отдаём готовый текст. Отдельная
 * загрузка нужна только когда текста нет.
 *
 * @param {{url:string, maxChars?:number, text?:string|null}} args
 * @param {{env?:object, fetchImpl?:Function}} [ctx]
 * @returns {Promise<object>}
 */
export async function webFetch({ url, maxChars = 4000, text = null } = {}, ctx = {}) {
  const env = ctx.env ?? process.env;
  const status = webServicesStatus(env);
  if (!status.search.configured) {
    return {
      ok: false,
      available: false,
      degraded: true,
      reason: `Интернет недоступен: не задан ${status.search.env}. Страницу прочитать не могу.`,
    };
  }
  const check = checkFetchUrl(url);
  if (!check.ok) return { ok: false, available: true, degraded: true, reason: check.reason };

  const given = String(text ?? '').trim();
  if (given.length) {
    return {
      ok: true,
      available: true,
      degraded: false,
      url: check.url,
      text: given.slice(0, Math.max(200, Math.min(20_000, Number(maxChars) || 4000))),
      truncated: false,
      source: 'search',
    };
  }

  const doFetch = ctx.fetchImpl ?? fetch;
  try {
    const res = await doFetch(check.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/html,text/plain,application/json' },
    });
    if (!res.ok) return { ok: false, available: true, degraded: true, reason: `страница вернула ${res.status}` };
    const buffer = Buffer.from(await res.arrayBuffer());
    const body = buffer.subarray(0, FETCH_MAX_BYTES).toString('utf8');
    const pageText = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      ok: true,
      available: true,
      degraded: false,
      url: check.url,
      text: pageText.slice(0, Math.max(200, Math.min(20_000, Number(maxChars) || 4000))),
      truncated: body.length >= FETCH_MAX_BYTES,
      source: 'fetch',
    };
  } catch (err) {
    return { ok: false, available: true, degraded: true, reason: `страница не прочитана: ${err?.message || err}` };
  }
}
