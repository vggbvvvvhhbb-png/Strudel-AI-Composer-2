// Проверка распределения random01: нет ли смещения, из-за которого
// вариация мотива никогда не срабатывает.

import { random01, hash32 } from '../../src/ir/prng.js';

const seed = 42;
const rolls = [];
for (let i = 0; i < 8; i += 1) {
  rolls.push(random01(seed, 'motif-variation', 'sec-verse-2', i));
}
console.log('броски для мотива:', rolls.map((r) => r.toFixed(3)).join(' '));

// Общее распределение.
const buckets = new Array(10).fill(0);
const N = 100000;
for (let i = 0; i < N; i += 1) {
  const value = random01(seed, 'motif-variation', `sec-${i}`, 0);
  buckets[Math.min(9, Math.floor(value * 10))] += 1;
}
console.log('гистограмма (0..1):', buckets.map((b) => (b / N * 100).toFixed(1) + '%').join(' '));

// Смещение при последовательных индексах: FNV-1a слабо мешает младшие биты,
// поэтому проверяем и «хвосты» распределения.
const low = [];
for (let i = 0; i < 16; i += 1) low.push(hash32(`${seed}motif-variationsec${i}`) % 2);
console.log('младший бит для 16 последовательных ключей:', low.join(''));

const mean = rolls.reduce((a, b) => a + b, 0) / rolls.length;
console.log('среднее по 8 броскам:', mean.toFixed(3), '(ожидается ≈0.5)');
