import { Router } from 'express';
import { z } from 'zod';
import { streamChat } from '../llm/client.js';
import { prompts } from '../prompts.js';

const router = Router();

const bodySchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  mode: z.enum(['new', 'improve']).default('new'),
  currentCode: z.string().max(20000).optional(),
  context: z
    .object({
      bpm: z.number().int().min(40).max(220).optional(),
      key: z.string().max(40).optional(),
      mutedParts: z.array(z.string().max(40)).max(16).optional(),
    })
    .optional(),
});

function buildMessages(body) {
  const ctx = [];
  if (body.context?.bpm) ctx.push(`Текущий BPM: ${body.context.bpm}`);
  if (body.context?.key) ctx.push(`Текущая тональность: ${body.context.key}`);
  if (body.context?.mutedParts?.length) ctx.push(`Заглушены партии: ${body.context.mutedParts.join(', ')}`);
  const contextText = ctx.length ? `Контекст: ${ctx.join('; ')}.` : '';

  if (body.mode === 'improve' && body.currentCode) {
    return [
      { role: 'system', content: prompts.system },
      { role: 'system', content: prompts.improve },
      {
        role: 'user',
        content: `Текущий код:\n\n${body.currentCode}\n\nИнструкция: ${body.prompt}${contextText ? `\n\n${contextText}` : ''}\n\nВерни полный обновлённый код.`,
      },
    ];
  }
  return [
    { role: 'system', content: prompts.system },
    { role: 'user', content: `${contextText ? `${contextText}\n\n` : ''}Запрос: ${body.prompt}` },
  ];
}

// SSE-стрим: события {type:'delta'|'done'|'error'} как data:-пакеты.
router.post('/api/generate', (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const body = parsed.data;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // Отмена апстрима при разрыве соединения клиентом (кнопка «Стоп»).
  // Слушаем close у ответа: close у запроса приходит сразу после чтения тела
  // и обрывал бы апстрим ещё до генерации.
  const upstream = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) upstream.abort();
  });

  let full = '';
  // streamChat — асинхронный генератор, поэтому обходим его через for await,
  // а не через .then(): промисом он не является.
  (async () => {
    try {
      for await (const delta of streamChat({ messages: buildMessages(body), signal: upstream.signal })) {
        if (upstream.signal.aborted) break;
        full += delta;
        send({ type: 'delta', text: delta });
      }
      if (!upstream.signal.aborted) send({ type: 'done', code: full });
    } catch (err) {
      if (!upstream.signal.aborted) {
        send({ type: 'error', message: err?.message || 'Ошибка генерации' });
      }
    } finally {
      res.end();
    }
  })();
});

export default router;
