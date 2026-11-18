// Детерминированный PRNG realm-рендера (D-143/E-022): чистая функция,
// глобальный Math.random в тестах не подменяется.

import { describe, it, expect } from 'vitest';
import { createSeededRandom, RENDER_SEED } from '../../src/audio/render/seed.js';

describe('createSeededRandom', () => {
  it('одно зерно — одна последовательность (воспроизводимость realm)', () => {
    const a = createSeededRandom(RENDER_SEED);
    const b = createSeededRandom(RENDER_SEED);
    const seqA = Array.from({ length: 1000 }, () => a());
    const seqB = Array.from({ length: 1000 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('разные зёрна — разные последовательности', () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('значения в [0, 1), не вырождены', () => {
    const random = createSeededRandom(RENDER_SEED);
    const values = Array.from({ length: 10_000 }, () => random());
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(new Set(values).size).toBeGreaterThan(9900);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.48);
    expect(mean).toBeLessThan(0.52);
  });
});