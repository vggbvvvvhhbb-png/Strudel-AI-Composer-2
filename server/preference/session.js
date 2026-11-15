// Сессии рецензента: кто какие пары реально получил.
//
// ЗАЧЕМ. Метка «человек выбрал лучше» — это не просто JSON в теле запроса.
// Это утверждение, что человек слушал две дорожки и решил, какая лучше.
// Пока сервер верил полю `source` в теле, любой скрипт мог отправить
// 60 таких меток — и выученная цель разблокировалась бы (бриф §7.4).
//
// Теперь сервер сам выдаёт рецензенту сессию (в ответе на очередь) и
// запоминает, какие пары в ней были показаны. Метка со `source: 'explicit'`
// принимается только если:
//   • канал — страница суждения (tinder);
//   • сессия выдана этим сервером и ещё жива;
//   • именно эта пара была показана в этой сессии.
//
// ЧЕГО ЭТО НЕ ДОКАЗЫВАЕТ. Сессия не доказывает, что судил человек: скрипт
// может получить очередь, взять сессию и отметить выданные пары. Поэтому это
// не «доказательство человека», а забор: молчаливый автопост больше не
// проходит, а настоящий рецензент идёт ровно этим путём. Остаток честности
// проверяется статистикой (hold-out, Уилсон) в scripts/check-taste.mjs.

import { randomUUID } from 'node:crypto';

/** Сессия живёт 12 часов: рецензент возвращается в тот же день. */
const TTL_MS = 12 * 60 * 60 * 1000;

/** Больше 200 живых сессий не держим: реестр в памяти, а не в базе. */
const MAX_SESSIONS = 200;

/** @type {Map<string, {id:string, createdAt:number, lastSeenAt:number, servedPairs:Set<string>}>} */
const sessions = new Map();

/**
 * Выдать новую сессию рецензента.
 * @returns {{id:string, createdAt:number, lastSeenAt:number, servedPairs:Set<string>}}
 */
export function issueReviewerSession() {
  prune();
  const now = Date.now();
  const session = { id: randomUUID(), createdAt: now, lastSeenAt: now, servedPairs: new Set() };
  sessions.set(session.id, session);
  return session;
}

/**
 * Найти живую сессию по идентификатору.
 * @param {string} id
 * @returns {object|null}
 */
export function getReviewerSession(id) {
  const key = String(id ?? '');
  if (!key) return null;
  const session = sessions.get(key);
  if (!session) return null;
  if (Date.now() - session.lastSeenAt > TTL_MS) {
    sessions.delete(key);
    return null;
  }
  return session;
}

/**
 * Запомнить, какие пары показаны в сессии.
 * @param {string} id
 * @param {Array<string>} pairIds
 * @returns {object|null} сессия или null, если её нет
 */
export function noteServed(id, pairIds) {
  const session = getReviewerSession(id);
  if (!session) return null;
  for (const pairId of pairIds) {
    if (pairId) session.servedPairs.add(String(pairId));
  }
  session.lastSeenAt = Date.now();
  return session;
}

/**
 * Пара была показана в этой сессии?
 * @param {string} id
 * @param {string} pairId
 * @returns {boolean}
 */
export function hasServed(id, pairId) {
  const session = getReviewerSession(id);
  return Boolean(session && pairId && session.servedPairs.has(String(pairId)));
}

/**
 * Сколько пар показано в сессии.
 * @param {string} id
 * @returns {number}
 */
export function servedCount(id) {
  const session = getReviewerSession(id);
  return session ? session.servedPairs.size : 0;
}

/** Очистить реестр сессий (тесты, сброс). */
export function resetReviewerSessions() {
  sessions.clear();
}

// --- внутреннее ---

/** Выбросить протухшие и лишние сессии. */
function prune() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeenAt > TTL_MS) sessions.delete(id);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (!oldest) break;
    sessions.delete(oldest.id);
  }
}
