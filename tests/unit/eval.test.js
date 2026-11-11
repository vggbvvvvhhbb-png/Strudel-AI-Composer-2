// Фаза 7: eval-инструменты — знаковый критерий, анализ A/B, отпечаток.
//
// Эти функции решают, чему мы верим в отчёте. Поэтому они проверяются
// на числах, где ответ известен заранее.

import { describe, it, expect } from 'vitest';
import { signTest, effectSize, analyze, extractPairs } from '../../eval/analyze-ab.mjs';
import { fingerprint, distanceBetween, selectDiverse } from '../../scripts/build-corpus.mjs';

describe('фаза 7: знаковый критерий', () => {
  it('одинаковые пары дают p = 1', () => {
    const result = signTest([0, 0, 0]);
    expect(result.n).toBe(0);
    expect(result.p).toBe(1);
  });

  it('явное превосходство даёт значимый результат', () => {
    // 10 пар, все в пользу B: W+ = 10, W− = 0, z = 3.16, p ≈ 0.0016.
    const result = signTest(Array(10).fill(5));
    expect(result.wPlus).toBe(10);
    expect(result.wMinus).toBe(0);
    expect(result.p).toBeLessThan(0.01);
  });

  it('ничья не даёт значимого результата', () => {
    const result = signTest([1, -1, 1, -1, 1, -1, 1, -1]);
    expect(result.wPlus).toBe(4);
    expect(result.wMinus).toBe(4);
    expect(result.p).toBeGreaterThan(0.5);
  });

  it('нулевые разности не искажают статистику', () => {
    const result = signTest([0, 0, 3, 0]);
    expect(result.n).toBe(1);
    expect(result.wPlus).toBe(1);
  });
});

describe('фаза 7: размер эффекта', () => {
  it('считает долю побед и медиану', () => {
    const effect = effectSize([2, 4, -1, 6]);
    expect(effect.wins).toBe(3);
    expect(effect.losses).toBe(1);
    expect(effect.winRate).toBe(0.75);
    expect(effect.median).toBe(4);
  });
});

describe('фаза 7: анализ A/B', () => {
  it('читает оба формата результатов', () => {
    expect(extractPairs([{ a: 1, b: 2 }]).pairs).toHaveLength(1);
    expect(extractPairs({ pairs: [{ a: 1, b: 2 }, { a: 3, b: 1 }] }).pairs).toHaveLength(2);
  });

  it('честно говорит, когда улучшения нет', () => {
    const report = analyze({ pairs: [{ a: 80, b: 60 }, { a: 70, b: 55 }, { a: 90, b: 70 }] });
    expect(report.winRate).toBe(0);
    expect(report.verdict).toContain('A лучше чаще');
  });

  it('честно говорит, когда улучшение есть', () => {
    const pairs = Array.from({ length: 12 }, () => ({ a: 60, b: 85 }));
    const report = analyze({ pairs });
    expect(report.winRate).toBe(1);
    expect(report.sign.p).toBeLessThan(0.01);
    expect(report.verdict).toContain('значимо лучше');
  });

  it('на пустых данных не выдумывает вывод', () => {
    const report = analyze({ pairs: [] });
    expect(report.count).toBe(0);
    expect(report.verdict).toContain('Нет данных');
  });
});

describe('фаза 7: отпечаток спеки', () => {
  const specA = {
    harmony: { progressionId: 'p1' },
    form: [
      { kind: 'intro', bars: 8, energy: 0.3, roles: { kick: { recipe: 'sparse' }, bass: { recipe: 'sparse' } } },
      { kind: 'drop', bars: 16, energy: 1, roles: { kick: { recipe: 'busy' } } },
    ],
  };

  it('одинаковые спеки дают одинаковый отпечаток', () => {
    expect(fingerprint(specA)).toBe(fingerprint(JSON.parse(JSON.stringify(specA))));
  });

  it('разная форма или гармония меняет отпечаток', () => {
    const other = JSON.parse(JSON.stringify(specA));
    other.form[0].bars = 4;
    expect(fingerprint(specA)).not.toBe(fingerprint(other));

    const otherHarmony = JSON.parse(JSON.stringify(specA));
    otherHarmony.harmony.progressionId = 'p2';
    expect(fingerprint(specA)).not.toBe(fingerprint(otherHarmony));
  });

  it('расстояние между одинаковыми отпечатками ноль', () => {
    const print = fingerprint(specA);
    expect(distanceBetween(print, print)).toBe(0);
  });

  it('расстояние растёт с различиями', () => {
    const near = fingerprint(specA);
    const far = fingerprint({
      harmony: { progressionId: 'other' },
      form: [{ kind: 'outro', bars: 8, energy: 0.1, roles: { pad: { recipe: 'sparse' } } }],
    });
    expect(distanceBetween(near, far)).toBeGreaterThan(0.5);
  });

  it('отбор разных оставляет уникальные отпечатки', () => {
    const items = [
      { print: 'a|b|c|d' },
      { print: 'a|b|c|d' },
      { print: 'x|y|z|w' },
      { print: 'x|y|z|w' },
      { print: 'p|q|r|s' },
    ];
    const selected = selectDiverse(items, 3);
    expect(selected).toHaveLength(3);
    const prints = new Set(selected.map((i) => i.print));
    expect(prints.size).toBe(3);
  });
});
