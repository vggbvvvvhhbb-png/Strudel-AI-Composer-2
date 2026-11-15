// Гард агента: лимиты на сессию и fail-open счётчик.
//
// ПОРТИРОВАНО из донора (.scratch/shveyka-igolka/packages/core/src/ai/rateLimitStore.ts
// и apps/web/src/lib/guard.ts). Ключевое решение донора сохранено: если
// счётчик сломался — запрос РАЗРЕШАЕТСЯ (fail-open). Обратное поведение
// (fail-closed) означало бы, что упавший Redis или счётчик выключает музыкальный
// инструмент; для чата это неприемлемо.
//
// Второй слой — лимиты самой сессии агента: сколько шагов, сколько вызовов
// тулзов, сколько времени. Это не rate limit, а защита от бесконечного цикла
// «модель → тулз → модель → тулз».

const WINDOWS = new Map();

/**
 * Памятный счётчик запросов по окну.
 * @param {string} key
 * @param {number} windowSec
 * @returns {number} сколько попыток в текущем окне
 */
export function hit(key, windowSec) {
  const now = Date.now();
  const bucket = WINDOWS.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    WINDOWS.set(key, { count: 1, expiresAt: now + windowSec * 1000 });
    return 1;
  }
  bucket.count += 1;
  // Чистим протухшие окна, чтобы карта не росла бесконечно.
  if (WINDOWS.size > 5000) {
    for (const [k, v] of WINDOWS) {
      if (v.expiresAt <= now) WINDOWS.delete(k);
    }
  }
  return bucket.count;
}

/**
 * Проверка лимита с fail-open: любая ошибка счётчика → запрос разрешён.
 * @param {{key:string, limit:number, windowSec:number, onError?:(err:Error)=>void}} options
 * @returns {{allowed:boolean, remaining:number, error?:string}}
 */
export function checkLimit({ key, limit, windowSec, onError } = {}) {
  try {
    const count = hit(key, windowSec);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch (err) {
    onError?.(err);
    return { allowed: true, remaining: limit, error: String(err?.message || err) };
  }
}

/** Лимиты одной сессии агента. */
export const DEFAULT_SESSION_LIMITS = {
  maxSteps: 8,
  maxToolCalls: 12,
  maxToolCallsPerTool: 4,
  maxWallMs: 120_000,
};

/**
 * Счётчик сессии агента.
 */
export class SessionGuard {
  /**
   * @param {Partial<typeof DEFAULT_SESSION_LIMITS>} [limits]
   */
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_SESSION_LIMITS, ...limits };
    this.toolCalls = new Map();
    this.totalToolCalls = 0;
    this.steps = 0;
    this.startedAt = Date.now();
  }

  /** @param {number} [limit] */
  canStep(limit = this.limits.maxSteps) {
    return this.steps < limit;
  }

  /**
   * Можно ли вызвать тулз: общий лимит и лимит на конкретный тулз.
   * @param {string} toolId
   * @returns {{allowed:boolean, reason?:string}}
   */
  canCallTool(toolId) {
    if (this.totalToolCalls >= this.limits.maxToolCalls) {
      return { allowed: false, reason: `достигнут лимит вызовов инструментов (${this.limits.maxToolCalls})` };
    }
    const used = this.toolCalls.get(toolId) || 0;
    if (used >= this.limits.maxToolCallsPerTool) {
      return { allowed: false, reason: `инструмент ${toolId} уже вызван ${used} раз(а) — лимит ${this.limits.maxToolCallsPerTool}` };
    }
    return { allowed: true };
  }

  /** @param {string} toolId */
  countToolCall(toolId) {
    this.toolCalls.set(toolId, (this.toolCalls.get(toolId) || 0) + 1);
    this.totalToolCalls += 1;
  }

  countStep() {
    this.steps += 1;
  }

  /** @returns {boolean} истекло ли время */
  isOutOfTime() {
    return Date.now() - this.startedAt > this.limits.maxWallMs;
  }

  /** @returns {number} прошло миллисекунд */
  elapsedMs() {
    return Date.now() - this.startedAt;
  }

  /** @returns {object} состояние для отчёта */
  snapshot() {
    return {
      steps: this.steps,
      toolCalls: this.totalToolCalls,
      perTool: Object.fromEntries(this.toolCalls),
      elapsedMs: this.elapsedMs(),
      limits: this.limits,
    };
  }
}
