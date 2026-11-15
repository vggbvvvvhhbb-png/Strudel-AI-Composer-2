// Доступ к результату разбора — по токену, а не по одному идентификатору.
//
// ЗАЧЕМ. Идентификатор задачи — UUID, но ссылка на разбор была открытой:
// любой, у кого есть URL, видел весь отчёт — измерения чужого оригинала,
// код двойника и его WAV. UUID от этого не защищает: он попадает в историю
// браузера, в скриншоты, в переписку и в логи прокси.
//
// КАК. У каждой задачи есть токен доступа (24 случайных байта). Он живёт
// рядом с задачей на диске — значит ссылка переживает перезапуск сервера.
//
// ГДЕ ЖИВЁТ ТОКЕН. В ссылке он стоит во ФРАГМЕНТЕ (`#t=…`): браузер не
// отправляет фрагмент серверу, поэтому токен не попадает в логи сервера,
// в заголовок Referer и в журналы обратного прокси. Клиент достаёт токен
// из адреса сам и передаёт его серверу заголовком `X-Razbor-Token`.
//
// ОТКАЗ ПОМОЩИТЬ. Если токена нет или он не тот — ответ 404, а не 403:
// «задачи не существует» и «доступа нет» не должны различаться, иначе
// маршрут становится оракулом существования чужих задач.

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Заголовок, в котором клиент передаёт токен доступа. */
export const TOKEN_HEADER = 'x-razbor-token';

/** Сколько случайных байт в токене (48 hex-символов). */
export const TOKEN_BYTES = 24;

/**
 * Новый токен доступа.
 * @returns {string} hex-строка
 */
export function generateAccessToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Сравнение токенов за постоянное время.
 *
 * Обычное `===` сравнивает строки до первого различия, а по времени ответа
 * можно было бы подбирать токен по символам. Здесь сравнение всегда идёт
 * целиком.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Есть ли у задачи доступ по предъявленному токену.
 *
 * Задача без токена (старая запись на диске, до появления токенов) доступа
 * не даёт: иначе «нет токена» означало бы «доступ есть».
 *
 * @param {object|undefined} job задача
 * @param {string|null|undefined} provided предъявленный токен
 * @returns {boolean}
 */
export function isAuthorized(job, provided) {
  const expected = job?.accessToken;
  if (!expected) return false;
  return tokensEqual(expected, provided);
}

/**
 * Достать токен из запроса: сначала заголовок, потом query (нужно для
 * скачивания WAV и MIDI по обычной ссылке — там нет возможности повесить
 * заголовок).
 *
 * @param {object} req запрос express
 * @returns {string|null}
 */
export function readToken(req) {
  const header = req?.get?.(TOKEN_HEADER);
  if (typeof header === 'string' && header.trim()) return header.trim();
  const query = req?.query?.token;
  if (typeof query === 'string' && query.trim()) return query.trim();
  return null;
}

/**
 * Ссылка на задачу с токеном во фрагменте.
 *
 * @param {string} jobId
 * @param {string|null} token
 * @returns {string|null} ссылка или null, если ссылки не выдаём
 */
export function permalinkFor(jobId, token) {
  if (!jobId || !token) return null;
  return `/razbor/${jobId}#t=${token}`;
}
