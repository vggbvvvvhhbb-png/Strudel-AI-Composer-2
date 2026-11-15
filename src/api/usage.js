// Идентификатор сессии браузера для учёта стоимости.
//
// Зачем. На сервере считается «цена сессии» — сколько денег ушло за работу
// одного человека в одной вкладке. Без идентификатора сервер видит только
// общую сумму и не может сказать, «сколько стоит трек» и «сколько стоит
// ночь».
//
// Сессия живёт в sessionStorage: перезагрузка страницы её не меняет
// (это тот же человек за тем же треком), а новая вкладка — меняет.

const STORAGE_KEY = 'strudel.session.id';

/**
 * Идентификатор сессии. В sessionStorage, чтобы переживать перезагрузку.
 * @returns {string}
 */
export function sessionId() {
  try {
    let id = window.sessionStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      window.sessionStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    // Приватный режим или file:// — работаем без идентификатора.
    return 's-anonymous';
  }
}

/**
 * Заголовки запроса с идентификатором сессии.
 * @param {object} [extra] дополнительные заголовки
 * @returns {object}
 */
export function usageHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', 'X-Strudel-Session': sessionId(), ...extra };
}
