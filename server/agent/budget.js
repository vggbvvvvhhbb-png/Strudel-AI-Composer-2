// Бюджеты ночи: жёсткие стопы платных вызовов.
//
// ПРАВИЛО. Бюджет — это стоп, а не совет. Достигнут — вызов не делается,
// агент говорит об этом честно и продолжает работу без платного шага.
// Потратить больше, чем разрешено, — нарушение инварианта, а не «инициатива».
//
// ЧТО СЧИТАЕТСЯ. Траты ведутся по фактическим ценам провайдеров: Exa отдаёт
// `costDollars.total` за запрос (D-102 — измеренная цена, не оценка), Freesound
// тарифицирует запросы, LLM — токены. Счётчики живут в процессе сервера:
// `usageSummary()` уже копит цену по фичам, поэтому отдельного хранилища
// не нужно — состояние одно.
//
// ОГРАНИЧЕНИЕ ИЗМЕРЕНИЕ. Счётчики живут в памяти процесса. Сервер, поднятый
// один раз на ночь, считает верно; перезапуск обнуляет счёт. Это зафиксировано
// как известное ограничение, а не как «всё точно».

import { usageSummary } from '../stats.js';

/** Фича, по которой копится цена платного поиска. */
const SEARCH_FEATURE = 'web_search';

/**
 * Лимиты ночи. Значения — по умолчанию; переопределяются переменными
 * окружения, чтобы владелец мог урезать или расширить ночь.
 *
 * NIGHT_EXA_BUDGET_USD — жёсткий стоп по сумме costDollars.total.
 *   Кредит владельца — $19; резерв не меньше $17, поэтому на ночь $2.
 * NIGHT_FS_REQUEST_CAP — суммарный счётчик запросов к Freesound.
 *   Лимиты сервиса: 60/мин и 2000/день.
 * NIGHT_LLM_BUDGET_USD — стоп по цене LLM-вызовов.
 */
export const NIGHT_BUDGETS = {
  exaUsd: Number(process.env.NIGHT_EXA_BUDGET_USD ?? 2.0),
  freesoundRequests: Number(process.env.NIGHT_FS_REQUEST_CAP ?? 300),
  llmUsd: Number(process.env.NIGHT_LLM_BUDGET_USD ?? 5.0),
  /** Ночной лимит вызовов поиска: дешевле, но ограничивает шум. */
  exaCalls: Number(process.env.NIGHT_EXA_CALL_CAP ?? 40),
};

/**
 * Текущее состояние бюджета поиска.
 * @returns {{limitUsd:number, spentUsd:number, remainingUsd:number, exhausted:boolean, reason:string|null}}
 */
export function searchBudgetState() {
  const summary = usageSummary();
  const feature = summary.byFeature?.[SEARCH_FEATURE] ?? {};
  const spentUsd = Number(feature.costUsd ?? 0);
  const calls = Number(feature.requests ?? 0);
  const limitUsd = NIGHT_BUDGETS.exaUsd;

  if (spentUsd >= limitUsd) {
    return {
      limitUsd,
      spentUsd,
      calls,
      remainingUsd: 0,
      exhausted: true,
      reason: `бюджет ночи на поиск исчерпан: $${spentUsd.toFixed(4)} из $${limitUsd.toFixed(2)}`,
    };
  }
  if (calls >= NIGHT_BUDGETS.exaCalls) {
    return {
      limitUsd,
      spentUsd,
      calls,
      remainingUsd: Math.max(0, limitUsd - spentUsd),
      exhausted: true,
      reason: `бюджет ночи на поиск исчерпан: ${calls} вызовов из ${NIGHT_BUDGETS.exaCalls}`,
    };
  }
  return {
    limitUsd,
    spentUsd,
    calls,
    remainingUsd: Math.max(0, limitUsd - spentUsd),
    exhausted: false,
    reason: null,
  };
}
