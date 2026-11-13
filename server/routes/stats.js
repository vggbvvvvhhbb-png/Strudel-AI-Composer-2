import { Router } from 'express';
import { usageSummary } from '../stats.js';

// /api/stats — агрегаты использования без тел запросов и без ключей.
// Правило из вводных: «учёт токенов/стоимости в /api/stats без тел запросов».
const router = Router();

router.get('/api/stats', (req, res) => {
  res.json(usageSummary());
});

export default router;
