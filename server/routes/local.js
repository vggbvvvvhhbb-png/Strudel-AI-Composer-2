// Маршруты сервера к локальному демону.
//
// ЗАЧЕМ. Сервер — витрина и оркестрация, тяжёлое считается на машине
// владельца (D-097). Сервер не знает, где демон, пока владелец не скажет:
// адрес и токен приходят из переменных окружения.
//
// ЧЕСТНОСТЬ. Если демон не настроен или не отвечает, сервер так и говорит —
// «демон недоступен» с кодом 503. Молчаливый успех означал бы, что тяжёлый
// рендер куда-то ушёл, и это была бы ложь.
//
// Эндпоинты:
//   GET  /api/local/status            — настроен ли демон, что он умеет, что в очереди;
//   POST /api/local/tasks             — поставить задачу в демон;
//   GET  /api/local/tasks/:id         — статус задачи;
//   GET  /api/local/tasks/:id/stream  — прогресс задачи в SSE (прокси).

import express from 'express';

import { createDaemonClient } from '../../local/client.mjs';

const router = express.Router();

const DAEMON_URL = process.env.LOCAL_DAEMON_URL || '';
const DAEMON_TOKEN = process.env.LOCAL_DAEMON_TOKEN || '';

/**
 * Клиент демона или null, если демон не настроен.
 * @returns {object|null}
 */
function daemon() {
  if (!DAEMON_URL) return null;
  return createDaemonClient({ baseUrl: DAEMON_URL, token: DAEMON_TOKEN });
}

/**
 * @param {import('express').Response} res
 * @param {Error} err
 */
function daemonError(res, err) {
  // Коды демона сохраняются: «неизвестный тип задачи» (400) и «нет такой
  // задачи» (404) — это ошибки запроса, а не «демон недоступен». Иначе
  // клиент получил бы 503 и подумал бы, что демон лежит.
  const status = err?.status === 400 || err?.status === 404 ? err.status : 503;
  res.status(status).json({
    error: err?.message || 'Демон недоступен',
    daemonConfigured: Boolean(DAEMON_URL),
    // Перечень доступных типов задач демон возвращает вместе с ошибкой 400 —
    // клиенту он нужен, чтобы показать человеку, что вообще можно делать.
    ...(Array.isArray(err?.body?.available) ? { available: err.body.available } : {}),
  });
}

// Статус демона: сервер должен честно показывать, есть ли тяжёлое железо.
router.get('/status', async (_req, res) => {
  const client = daemon();
  if (!client) {
    res.json({
      configured: false,
      available: false,
      reason: 'Локальный демон не настроен: задайте LOCAL_DAEMON_URL и LOCAL_DAEMON_TOKEN.',
      url: null,
    });
    return;
  }
  try {
    const health = await client.health();
    res.json({
      configured: true,
      available: true,
      url: DAEMON_URL,
      machine: health.machine ?? null,
      tasks: health.tasks ?? [],
      analysis: health.analysis ?? null,
      render: health.render ?? null,
      queue: health.queue ?? null,
    });
  } catch (err) {
    res.json({
      configured: true,
      available: false,
      reason: err?.message || 'Демон не отвечает',
      url: DAEMON_URL,
    });
  }
});

// Постановка задачи в демон.
router.post('/tasks', async (req, res) => {
  const client = daemon();
  if (!client) {
    res.status(503).json({ error: 'Локальный демон не настроен (LOCAL_DAEMON_URL).' });
    return;
  }
  try {
    const type = String(req.body?.type ?? '').trim();
    if (!type) {
      res.status(400).json({ error: 'Нужен тип задачи (type).' });
      return;
    }
    const task = await client.submit(type, req.body?.payload ?? {});
    res.status(202).json(task);
  } catch (err) {
    daemonError(res, err);
  }
});

// Статус задачи.
router.get('/tasks/:id', async (req, res) => {
  const client = daemon();
  if (!client) {
    res.status(503).json({ error: 'Локальный демон не настроен (LOCAL_DAEMON_URL).' });
    return;
  }
  try {
    const task = await client.status(req.params.id);
    res.json({ task });
  } catch (err) {
    daemonError(res, err);
  }
});

// Прогресс задачи: прокси SSE от демона к клиенту.
router.get('/tasks/:id/stream', async (req, res) => {
  const client = daemon();
  if (!client) {
    res.status(503).json({ error: 'Локальный демон не настроен (LOCAL_DAEMON_URL).' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  try {
    const { status } = await client.status(req.params.id);
    res.write(`event: snapshot\ndata: ${JSON.stringify({ type: 'snapshot', task: status })}\n\n`);
  } catch {
    // Демон мог не ответить на статус — стрим всё равно попробует отдать события.
  }
  const { streamTask } = await import('../../local/client.mjs');
  const stop = streamTask(req.params.id, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done' || event.type === 'error') res.end();
  }, { baseUrl: DAEMON_URL, token: DAEMON_TOKEN });
  req.on('close', () => stop());
});

export default router;
