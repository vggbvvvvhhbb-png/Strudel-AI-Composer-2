// Клиент локального демона.
//
// КТО ПОЛЬЗУЕТСЯ. Сервер (оркестрация: сервер знает, что демон есть, и может
// отдать ему тяжёлую задачу) и фронт (офлайн-режим: фронт ходит в
// http://127.0.0.1:3213 напрямую, когда сервера нет).
//
// ЧЕСТНОСТЬ СОСТОЯНИЙ. Если демон недоступен или не настроен, клиент НЕ
// притворяется, что задача ушла: submit() бросает ошибку с понятным текстом.
// Выдуманный «успех» здесь означал бы, что тяжёлый рендер потерян.
//
// ТОКЕН. Берётся из LOCAL_DAEMON_TOKEN. В репозитории ключей нет — только
// переменная окружения.

import http from 'node:http';
import https from 'node:https';

const DEFAULT_URL = process.env.LOCAL_DAEMON_URL || 'http://127.0.0.1:3213';
const DEFAULT_TOKEN = process.env.LOCAL_DAEMON_TOKEN || '';

/**
 * Ошибка демона: понятный текст + код ответа.
 */
export class DaemonError extends Error {
  constructor(message, { status = null, cause = null, body = null } = {}) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
    this.cause = cause;
    // Тело ответа демона сохраняем: в нём могут быть полезные поля
    // (например, перечень доступных типов задач при ошибке 400).
    this.body = body;
  }
}

/**
 * @param {string} pathname
 * @param {{baseUrl?:string, token?:string, method?:string, body?:object, timeoutMs?:number}} options
 * @returns {Promise<{status:number, body:object}>}
 */
function request(pathname, { baseUrl = DEFAULT_URL, token = DEFAULT_TOKEN, method = 'GET', body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, baseUrl);
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (token) headers.authorization = `Bearer ${token}`;

    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = { raw: text };
          }
          if (res.statusCode >= 400) {
            reject(new DaemonError(parsed?.error || `демон ответил HTTP ${res.statusCode}`, {
              status: res.statusCode,
              body: parsed,
            }));
            return;
          }
          resolve({ status: res.statusCode ?? 200, body: parsed });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new DaemonError(`демон не ответил за ${timeoutMs} мс`));
    });
    req.on('error', (err) => {
      if (err instanceof DaemonError) reject(err);
      else reject(new DaemonError(`демон недоступен (${baseUrl}): ${err?.message || err}`, { cause: err }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Клиент демона.
 * @param {{baseUrl?:string, token?:string}} [options]
 */
export function createDaemonClient({ baseUrl = DEFAULT_URL, token = DEFAULT_TOKEN } = {}) {
  return {
    baseUrl,
    token,

    /**
     * Здоровье демона.
     * @returns {Promise<object>}
     */
    async health() {
      const { body } = await request('/health', { baseUrl, token, timeoutMs: 5000 });
      return body;
    },

    /**
     * Кладёт задачу в очередь демона.
     * @param {string} type
     * @param {object} payload
     * @returns {Promise<{id:string, type:string, state:string}>}
     */
    async submit(type, payload = {}) {
      const { body } = await request('/tasks', { baseUrl, token, method: 'POST', body: { type, payload } });
      return body;
    },

    /**
     * Статус задачи.
     * @param {string} id
     * @returns {Promise<object>}
     */
    async status(id) {
      const { body } = await request(`/tasks/${id}`, { baseUrl, token });
      return body.task;
    },

    /**
     * Список задач.
     * @returns {Promise<object>}
     */
    async list() {
      const { body } = await request('/tasks', { baseUrl, token });
      return body;
    },
  };
}

/**
 * Стрим прогресса задачи (SSE). Отдаёт функцию отмены.
 *
 * @param {string} id
 * @param {(event:object)=>void} onEvent
 * @param {{baseUrl?:string, token?:string}} [options]
 * @returns {() => void}
 */
export function streamTask(id, onEvent, { baseUrl = DEFAULT_URL, token = DEFAULT_TOKEN } = {}) {
  const target = new URL(`/tasks/${id}/stream`, baseUrl);
  const lib = target.protocol === 'https:' ? https : http;
  const req = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
          try {
            onEvent(JSON.parse(dataLine.slice('data:'.length).trim()));
          } catch {
            // частичный кадр — пропускаем
          }
        }
      });
    },
  );
  req.on('error', () => {});
  req.end();
  return () => req.destroy();
}
