// Кэш ответов агента: TTL + LRU, версия каталога в ключе.
//
// ПОРТИРОВАНО из донора (.scratch/shveyka-igolka/packages/core/src/ai/answerCache.ts).
// Решения те же, домен наш. Ключевое правие донора сохранено: в кэш попадает
// только то, что можно повторить без контекста. Если в диалоге была история
// или использовались измерения — ответ кэшировать нельзя, иначе один и тот же
// вопрос в разном контексте будет получать один и тот же ответ.
//
// Отличие от донора: у нас нет отдельной версии каталога страниц, поэтому
// версией считается хэш корпуса знаний (server/music/knowledge/*) и реестра
// сэмплов. Правился банк — поехали все ключи.

/**
 * cyrb53 — быстрый некриптографический хэш строки.
 * @param {string} str
 * @param {number} [seed]
 * @returns {string}
 */
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Нормализация вопроса: регистр, «ё», только буквы и цифры.
 * @param {string} question
 * @returns {string}
 */
export function normalizeQuestion(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

/**
 * Ключ кэша. Версия каталога входит в ключ: правка знаний инвалидирует ответы.
 * @param {{question:string, mode?:string, catalogVersion?:string}} options
 * @returns {string}
 */
export function cacheKey({ question, mode = 'default', catalogVersion = '0' } = {}) {
  return `${mode}:${hashString(`${normalizeQuestion(question)}|${catalogVersion}`)}`;
}

/**
 * Можно ли кэшировать такой ответ.
 * @param {{hasHistory?:boolean, usesMeasurements?:boolean}} options
 * @returns {boolean}
 */
export function isCacheable({ hasHistory = false, usesMeasurements = false } = {}) {
  return !hasHistory && !usesMeasurements;
}

/**
 * TTL + LRU в памяти.
 * @template V
 */
export class TtlLruCache {
  /**
   * @param {{max?:number, ttlMs?:number, now?:() => number}} [options]
   */
  constructor({ max = 200, ttlMs = 6 * 60 * 60 * 1000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  /**
   * @param {string} key
   * @param {V} value
   */
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  /**
   * @param {string} key
   * @returns {V|undefined}
   */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Обновляем порядок: недавно прочитанное считается свежим.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** @param {string} key */
  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}
