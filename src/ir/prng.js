// Counter-based PRNG: вся случайность композиции приходит отсюда.
//
// Инвариант (§2.4 брифа v2): правка баса не пересыпает случайности барабанов.
// Поэтому генератор не «потоковый», а адресный: значение для конкретного
// места определяется хэшем от (seed, sectionId, roleId, stepIndex).
// Такой генератор можно считать заново в любом порядке — результат не плывёт.

/**
 * FNV-1a 32-bit по строке. Стабилен между рантаймами: нет Math.random,
 * нет Date.now, нет зависимости от порядка обхода.
 *
 * ВНИМАНИЕ: сам по себе FNV-1a — ПЛОХОЙ источник случайности. Измерено
 * (tests/spike/prng-distribution.probe.mjs): у «голого» FNV старшие биты
 * почти не смешиваются, и распределение получается рваным — 46 % значений
 * попадали в один десятый интервала, среднее 0.68 вместо 0.5. Поэтому
 * после FNV применяется финализатор fmix32 (MurmurHash3): он и есть
 * avalanche-шаг, который даёт равномерное распределение.
 *
 * @param {string} text
 * @returns {number} беззнаковое 32-битное число
 */
export function hash32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return fmix32(hash);
}

/**
 * Финализатор fmix32 (MurmurHash3) — превращает хэш в равномерно
 * распределённые биты. Без него верхние биты FNV повторяют структуру ключа.
 * @param {number} h
 * @returns {number}
 */
export function fmix32(h) {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Собирает ключ генератора из произвольных частей.
 * Части приводятся к строке канонично, чтобы 1 и '1' не давали разных зёрен.
 * @param {Array<string|number>} parts
 * @returns {string}
 */
export function randomKey(parts) {
  // Разделитель экранируется внутри частей: иначе random01(1, 'a\u0001b')
  // совпал бы с random01(1, 'a', 'b') — одно и то же зерно на два разных
  // адреса.
  return parts
    .map((part) => String(part).split("\u0001").join("\u0001\u0001"))
    .join("\u0001");
}

/**
 * Псевдослучайное число в [0, 1) по адресному ключу.
 * @param {number} seed
 * @param {...(string|number)} parts адрес (секция, роль, шаг, …)
 * @returns {number}
 */
export function random01(seed, ...parts) {
  const key = `${seed}${randomKey(parts)}`;
  // Два независимых прохода FNV со смещением: второй проход отделяет ключи,
  // которые отличаются только последним символом.
  const a = hash32(key);
  const b = hash32(`${key}`);
  return ((a ^ b) >>> 0) / 4294967296;
}

/**
 * Генератор «как функция от адреса»: r() — одно и то же значение по ключу.
 * @param {number} seed
 * @param {...(string|number)} parts базовый адрес
 * @returns {() => number}
 */
export function makeRng(seed, ...parts) {
  return () => random01(seed, ...parts);
}

/**
 * Выбор из списка по адресному ключу.
 * @template T
 * @param {number} seed
 * @param {T[]} items
 * @param {...(string|number)} parts адрес
 * @returns {T}
 */
export function pick(seed, items, ...parts) {
  if (!items.length) throw new Error('pick: пустой список');
  const index = Math.floor(random01(seed, ...parts) * items.length);
  return items[Math.min(index, items.length - 1)];
}

/**
 * Вероятностное событие: детерминированно «случайно» попасть в выборку.
 * @param {number} seed
 * @param {number} probability 0..1
 * @param {...(string|number)} parts адрес
 * @returns {boolean}
 */
export function chance(seed, probability, ...parts) {
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  return random01(seed, ...parts) < probability;
}

/**
 * Отклонение от нуля в диапазоне [-amount, +amount] с центром 0.
 * @param {number} seed
 * @param {number} amount
 * @param {...(string|number)} parts адрес
 * @returns {number}
 */
export function jitter(seed, amount, ...parts) {
  return (random01(seed, ...parts) * 2 - 1) * amount;
}
