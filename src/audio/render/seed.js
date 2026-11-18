// Детерминированный PRNG для изолированного рендера (D-143, факт E-022).
//
// ЗАЧЕМ. superdough 1.3.0 генерирует импульсную характеристику реверберации
// белым шумом через Math.random() (generateReverb → Jn()) и случайно
// детюнит генератор бочки. В живом браузере IR кэшируется после первого
// рендера, поэтому повторы в одной странице совпадали; каждый свежий realm
// генерировал бы СВОЮ случайную IR — рендеры с .room() не воспроизводились
// бы между realm и между машинами.
//
// РЕШЕНИЕ. В realm-рендере Math.random заменяется на mulberry32 с фиксированным
// зерном: все realm генерируют идентичные IR, рендер детерминирован. Живая
// страница НЕ трогается — там детерминизм не нужен, а подмена глобального
// Math.random могла бы задеть код приложения.
//
// Установщик вызывается только в одноразовом realm / серверной render page.
// В живой студии этот модуль не устанавливает перехватов.

/** mulberry32: быстрый 32-битный PRNG, период 2^32, качество достаточное для IR. */
export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Зерно рендера: одно на все realm и все машины (часть контракта D-143). */
export const RENDER_SEED = 0x5eed2026;

/** Версия политики: фиксированный PRNG + завершение каждой IR + свежий realm. */
export const RENDER_POLICY_VERSION = 'seeded-ir-v2';

const installations = new WeakMap();

// superdough завершает каждый generate одной записью buffer; старый буфер не означает готовность новой IR.
export function installRenderDeterminism(scope = globalThis, { timeoutMs = 5000 } = {}) {
  if (installations.has(scope)) return installations.get(scope);
  const proto = scope.BaseAudioContext?.prototype;
  const buffer = Object.getOwnPropertyDescriptor(scope.ConvolverNode?.prototype ?? {}, 'buffer');
  if (typeof proto?.createReverb !== 'function' || typeof proto?.createConvolver !== 'function' ||
      typeof buffer?.get !== 'function' || typeof buffer?.set !== 'function') {
    throw new Error('Детерминированный рендер: API reverb / ConvolverNode.buffer недоступен');
  }

  const pending = new Set();
  const generations = new WeakMap();
  let failure = null;
  let creatingReverb = 0;
  const begin = (queue) => {
    const token = {};
    queue.push(token);
    pending.add(token);
    return token;
  };
  const createConvolver = proto.createConvolver;
  const createReverb = proto.createReverb;

  scope.Math.random = createSeededRandom(RENDER_SEED);
  proto.createConvolver = function (...args) {
    const node = createConvolver.apply(this, args);
    if (!creatingReverb) return node;
    const queue = [];
    generations.set(node, queue);
    begin(queue); // createReverb вызовет initial generate до возврата узла.
    Object.defineProperty(node, 'buffer', {
      configurable: true,
      get() { return buffer.get.call(this); },
      set(value) {
        try {
          buffer.set.call(this, value);
        } catch (error) {
          failure = error;
          throw error;
        }
        if (value != null && queue.length) pending.delete(queue.shift());
      },
    });
    return node;
  };
  proto.createReverb = function (...args) {
    let node;
    creatingReverb += 1;
    try {
      node = createReverb.apply(this, args);
    } finally {
      creatingReverb -= 1;
    }
    const queue = generations.get(node);
    if (!queue || typeof node.generate !== 'function') {
      throw new Error('Детерминированный рендер: неподдерживаемая реализация createReverb');
    }
    const generate = node.generate;
    node.generate = function (...params) {
      const token = begin(queue);
      try {
        return generate.apply(this, params);
      } catch (error) {
        pending.delete(token);
        const index = queue.indexOf(token);
        if (index !== -1) queue.splice(index, 1);
        failure = error;
        throw error;
      }
    };
    return node;
  };

  const policy = {
    seed: RENDER_SEED,
    version: RENDER_POLICY_VERSION,
    async prepare() {
      const deadline = Date.now() + timeoutMs;
      while (pending.size) {
        if (failure) throw failure;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`IR реверберации не сгенерировалась за ${timeoutMs} мс (${pending.size} pending) — рендер недостоверен`);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
      }
      if (failure) throw failure;
    },
  };
  installations.set(scope, policy);
  return policy;
}