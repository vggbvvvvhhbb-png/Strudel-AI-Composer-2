// Адаптер оценки v2.
//
// Фаза 4 (метрики v2) добавляет модуль score-v2.js. Он может появиться
// позже этого файла, а падать из-за отсутствующего модуля нельзя:
// композиция должна работать и на одном лишь скоре v1.
//
// Поэтому импорт динамический и мягкий: нет файла или нет функции —
// возвращаем null, и вызывающий код считает, что метрик v2 пока нет.

let cached = null;
let attempted = false;

/**
 * Пытается загрузить скор v2.
 * @returns {Promise<Function|null>} функция (code, style, text) => score
 */
async function loadV2() {
  if (attempted) return cached;
  attempted = true;
  try {
    const mod = await import('../score-v2.js');
    const fn = mod.scoreTrackV2 || mod.scoreV2 || mod.default;
    cached = typeof fn === 'function' ? fn : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Считает скор v2 по коду.
 * @param {string} code
 * @param {string} [style]
 * @param {string} [text]
 * @returns {Promise<object|null>}
 */
export async function scoreWithV2(code, style, text) {
  const fn = await loadV2();
  if (!fn) return null;
  try {
    const score = await fn(code, style, text);
    if (!score || typeof score.total !== 'number') return null;
    return score;
  } catch {
    // Метрики v2 требуют исполнения Strudel — если оно не удалось,
    // трек просто оценивается по v1.
    return null;
  }
}
