import { Router } from 'express';
import { usageSummary, PRICING } from '../stats.js';

// /api/stats — агрегаты использования без тел запросов и без ключей.
// Правило из вводных: «учёт токенов/стоимости в /api/stats без тел запросов».
//
// Что видно в ответе:
//   • costUsd — цена всего, что прогонялось с момента старта сервера;
//   • tracks[] — цена отдельных операций (одна операция = одна генерация);
//   • sessions[] — цена по браузерным сессиям;
//   • night — цена текущих суток;
//   • byModel / byFeature / byDay — токены и деньги по моделям, фичам и дням;
//   • unpricedModels — модели без известной цены: молча считать их
//     бесплатными нельзя, поэтому они видны отдельным списком.
const router = Router();

router.get('/api/stats', (req, res) => {
  const summary = usageSummary();
  res.json({
    ...summary,
    // Таблица цен — чтобы ответ был самодостаточным: видно, по чему считалось.
    pricing: PRICING,
  });
});

export default router;
