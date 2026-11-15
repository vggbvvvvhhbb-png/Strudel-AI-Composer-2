import { Router } from 'express';
import { z } from 'zod';
import { completeChat } from '../llm/client.js';
import { prompts } from '../prompts.js';

const router = Router();

const bodySchema = z.object({
  code: z.string().min(1).max(20000),
  error: z.string().min(1).max(2000),
});

// Автофикс: не стрим, обычный JSON {code}.
router.post('/api/fix', async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос' });
    return;
  }
  const { code, error } = parsed.data;
  try {
    const content = await completeChat({
      messages: [
        { role: 'system', content: prompts.fix },
        { role: 'user', content: `Код:\n\n${code}\n\nОшибка:\n\n${error}\n\nВерни исправленный код целиком.` },
      ],
      feature: 'fix',
    });
    res.json({ code: content });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'Не удалось исправить код' });
  }
});

export default router;
