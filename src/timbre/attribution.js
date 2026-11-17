// Атрибуция тембров для экспорта и шеринга (D-126).
//
// Каталог пресетов — релизный слой: CC-BY ассеты обязаны ехать вместе
// с кодом строкой TASL. Логика сопоставления «код → пресеты → ассеты»
// живёт на сервере (server/samples/timbre.js), здесь только транспорт.
// Каталог пуст или пресеты не используются — пустой список, без выдумок.

/**
 * Строки атрибуции для набора кодов. Ошибка сети — пустой список с
 * пометкой в консоли: экспорт не ломается, но молча терять атрибуцию
 * нельзя — вызывающий код показывает предупреждение.
 *
 * @param {string[]} codes
 * @returns {Promise<{attributions: string[][], degraded: boolean}>}
 */
export async function fetchAttributions(codes) {
  if (!codes.length) return { attributions: [], degraded: false };
  try {
    const res = await fetch('/api/timbre/attribution', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codes }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { attributions: data.attributions ?? [], degraded: false };
  } catch (error) {
    console.warn('Атрибуция тембров недоступна:', error?.message || error);
    return { attributions: codes.map(() => []), degraded: true };
  }
}