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
//   GET  /api/local/tasks             — очередь демона (список задач);
//   GET  /api/local/tasks/:id         — статус задачи;
//   GET  /api/local/tasks/:id/stream  — прогресс задачи в SSE (прокси);
//   GET  /api/local/tasks/:id/audio   — WAV готового рендера (прокси).

import express from 'express';
import { Readable } from 'node:stream';

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
  // Коды демона сохраняются: «неизвестный тип задачи» (400), «нет такой
  // задачи» (404), «слишком большое тело» (413), «не тот content-type» (415)
  // и «слишком много задач» (429) — это ошибки запроса, а не «демон
  // недоступен». Иначе клиент получил бы 503 и подумал бы, что демон лежит.
  const passthrough = [400, 404, 413, 415, 429];
  const status = passthrough.includes(err?.status) ? err.status : 503;
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
    // Идентификатор задачи от клиента: повторный запрос с тем же id не
    // ставит тяжёлую работу второй раз (идемпотентность на стороне демона).
    const id = typeof req.body?.id === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(req.body.id)
      ? req.body.id
      : undefined;
    const task = await client.submit(type, req.body?.payload ?? {}, { id });
    res.status(202).json(task);
  } catch (err) {
    daemonError(res, err);
  }
});

// Очередь демона: список задач виден в интерфейсе, а не только в консоли.
router.get('/tasks', async (_req, res) => {
  const client = daemon();
  if (!client) {
    res.status(503).json({ error: 'Локальный демон не настроен (LOCAL_DAEMON_URL).' });
    return;
  }
  try {
    const list = await client.list();
    res.json(list);
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
  let task;
  try {
    task = await client.status(req.params.id);
  } catch (err) {
    daemonError(res, err);
    return;
  }
  if (res.destroyed) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify({ type: 'snapshot', task })}\n\n`);
  if (task.state === 'done' || task.state === 'error') {
    res.end(`event: ${task.state}\ndata: ${JSON.stringify({ type: task.state, task })}\n\n`);
    return;
  }
  const { streamTask } = await import('../../local/client.mjs');
  if (res.destroyed) return;
  const stop = streamTask(req.params.id, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done' || event.type === 'error') res.end();
  }, { baseUrl: DAEMON_URL, token: DAEMON_TOKEN });
  res.on('close', stop);
});

// WAV готового рендера: прокси от демона. Токен демона остаётся на сервере —
// браузер ходит только сюда, секрет в клиент не попадает.
router.get('/tasks/:id/audio', async (req, res) => {
  if (!DAEMON_URL) {
    res.status(503).json({ error: 'Локальный демон не настроен (LOCAL_DAEMON_URL).' });
    return;
  }
  try {
    const upstream = await fetch(`${DAEMON_URL.replace(/\/+$/, '')}/tasks/${encodeURIComponent(req.params.id)}/audio`, {
      headers: DAEMON_TOKEN ? { authorization: `Bearer ${DAEMON_TOKEN}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) {
      const body = await upstream.json().catch(() => ({}));
      res.status(upstream.status).json({ error: body?.error || `демон ответил HTTP ${upstream.status}` });
      return;
    }
    res.setHeader('content-type', upstream.headers.get('content-type') || 'audio/wav');
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('content-length', length);
    res.setHeader('cache-control', 'no-store');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) daemonError(res, err);
    else res.end();
  }
});

export default router;
