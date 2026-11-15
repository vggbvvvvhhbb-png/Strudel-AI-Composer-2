// Маршруты агента.
//
//   GET  /api/agent/tools  → паспорт инструментов, режимы, статус внешних сервисов
//   POST /api/agent        → агентный цикл в SSE (шаги отдельно от текста)
//
// ФОРМАТ ПОТОКА. События SSE с именем типа: plan, tool_start, tool_end, text,
// usage, done, error. Панель студии рисует шаги отдельно от текста ответа —
// поэтому это разные события, а не один поток строк.
//
// ПОЧЕМУ SSE, А НЕ JSON. Цикл агента — это последовательность «план → тулз →
// наблюдение → ответ». Пользователь должен видеть, что агент делает, пока
// ответ ещё пишется. JSON-ответ показал бы всё только в конце.

import express from 'express';

import { runAgent } from '../agent/loop.js';
import { toolManifest } from '../agent/tools.js';
import { MODES } from '../agent/modes.js';
import { webServicesStatus } from '../agent/web.js';
import { checkLimit } from '../agent/guard.js';

const router = express.Router();

// Лимит запросов агента на IP: агент дороже обычного запроса (несколько
// вызовов модели внутри), поэтому у него свой, более жёсткий лимит.
const AGENT_RATE_LIMIT = Number(process.env.AGENT_RATE_LIMIT_PER_MIN || 10);
const AGENT_RATE_WINDOW_SEC = 60;

/**
 * Отправка события SSE.
 * @param {import('express').Response} res
 * @param {string} type
 * @param {object} data
 */
function sendEvent(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * GET /api/agent/tools — что агент умеет и что сейчас доступно.
 */
router.get('/tools', (_req, res) => {
  res.json({
    modes: Object.values(MODES).map((mode) => ({
      id: mode.id,
      label: mode.label,
      hint: mode.hint,
      maxSteps: mode.maxSteps,
      maxToolCalls: mode.maxToolCalls,
      tools: mode.tools,
    })),
    tools: toolManifest(),
    services: webServicesStatus(),
    limits: { requestsPerMinute: AGENT_RATE_LIMIT },
  });
});

/**
 * POST /api/agent — агентный цикл.
 */
router.post('/', async (req, res) => {
  const body = req.body || {};
  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) {
    res.status(400).json({ error: 'Нужен запрос (prompt)' });
    return;
  }
  if (prompt.length > 4000) {
    res.status(400).json({ error: 'Запрос длиннее 4000 символов' });
    return;
  }

  const clientKey = req.get('X-Strudel-Session') || req.ip || 'unknown';
  const limit = checkLimit({
    key: `agent:${clientKey}`,
    limit: AGENT_RATE_LIMIT,
    windowSec: AGENT_RATE_WINDOW_SEC,
    onError: (err) => console.error('[agent] счётчик лимита сломался, запрос разрешён:', err.message),
  });
  if (!limit.allowed) {
    res.status(429).json({
      error: `Слишком много запросов к агенту. Подождите минуту (лимит ${AGENT_RATE_LIMIT}/мин).`,
    });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Клиент может отключиться — тогда цикл надо честно остановить.
  // ВАЖНО: слушаем ЗАКРЫТИЕ ОТВЕТА, а не запроса: 'close' на запросе срабатывает
  // сразу после чтения тела, то есть при обычном запросе, и агент отменял бы
  // сам себя на первом же шаге. Ответ закрылся, а завершён он не был — значит,
  // клиент отвалился.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    for await (const event of runAgent({
      prompt,
      mode: body.mode,
      currentCode: typeof body.currentCode === 'string' ? body.currentCode : null,
      currentIr: body.currentIr && typeof body.currentIr === 'object' ? body.currentIr : null,
      history: Array.isArray(body.history) ? body.history.slice(-8) : [],
      signal: controller.signal,
    })) {
      sendEvent(res, event.type, event);
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[agent] цикл упал:', err?.message || err);
      sendEvent(res, 'error', { message: `Агент упал: ${err?.message || err}` });
    }
  } finally {
    res.end();
  }
});

export default router;
