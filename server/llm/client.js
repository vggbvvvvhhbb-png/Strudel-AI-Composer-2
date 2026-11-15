// Публичный интерфейс LLM для маршрутов.
// Реализация вынесена в llm/router.js — там провайдеры и форматы ответа.

import { streamChat as routerStream, completeChat as routerComplete } from './router.js';

/**
 * Стриминг ответа по дельтам.
 * @param {{messages:Array, temperature?:number, signal?:AbortSignal, providerId?:string}} options
 */
export function streamChat(options) {
  return routerStream(options);
}

/**
 * Нестримовый вызов — для автофикса, улучшения и генерации вариантов.
 * `responseFormat` — структурированный вывод (`{type:'json_schema', ...}`):
 * провайдер, который его не поддерживает, получит запрос без него.
 * @param {{messages:Array, temperature?:number, signal?:AbortSignal, providerId?:string, onUsage?:Function, responseFormat?:object, feature?:string}} options
 */
export function completeChat(options) {
  return routerComplete(options);
}

// Список доступных провайдеров — для /api/health и панели в интерфейсе.
export { providerChain } from './router.js';
