// Контекст учёта стоимости запроса.
//
// Зачем отдельный файл. Токены тратятся в разных местах: планировщик,
// компилятор спеки, критик, рефайн-цикл разбора. Ни один из них не знает,
// в каком HTTP-запросе он работает, — а «цена трека», «цена сессии» и
// «цена ночи» определяются именно запросом.
//
// AsyncLocalStorage решает это без протаскивания параметров через пять
// слоёв: контекст задаётся один раз в middleware и сам распространяется по
// всем async-вызовам внутри запроса.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Выполнить функцию в контексте учёта.
 * @param {{operationId?:string, sessionId?:string|null, group?:string|null}} context
 * @param {Function} fn
 */
export function withUsageContext(context, fn) {
  return storage.run(context || {}, fn);
}

/**
 * Текущий контекст учёта (пустой объект, если его нет).
 * @returns {{operationId?:string, sessionId?:string|null, group?:string|null}}
 */
export function currentUsageContext() {
  return storage.getStore() || {};
}
