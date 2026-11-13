// Фаза 7: eval-инструменты — знаковый критерий, анализ A/B, отпечаток.
//
// Эти функции решают, чему мы верим в отчёте. Поэтому они проверяются
// на числах, где ответ известен заранее.

import { describe, it, expect } from 'vitest';
import { signTest, effectSize, analyze, extractPairs } from '../../eval/analyze-ab.mjs';
import { fingerprint, distanceBetween, selectDiverse } from '../../scripts/build-corpus.mjs';
import { readFile } from 'node:fs/promises';
import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';
import { checkSpec } from '../../server/music/spec/check.js';
import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { detectSpecStyle, fallbackSpec, SPEC_STYLES } from '../../server/music/compose/pipeline.js';

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

describe('фаза 7: жанры eval и канонические запасные планы', () => {
  it.each([
    ['Спокойный lo-fi с пианино', 'lo-fi'],
    ['Драм-н-бейс 174 BPM', 'techno'],
    ['DNB с двумя разными дропами', 'techno'],
    ['Медитативный эмбиент', 'ambient'],
    ['Дабстеп 140 BPM', 'dubstep'],
  ])('%s: распознавание даёт допустимый стиль %s', (text, expected) => {
    expect(detectSpecStyle(text)).toBe(expected);
    const spec = fallbackSpec(detectSpecStyle(text), 1);
    expect(spec.meta.style).toBe(expected);
    expect(checkSpec(spec).ok).toBe(true);
    expect(typeof compileTrackSpec(spec)).toBe('string');
  });

  it('все исходные промпты eval получают валидный fallback без расширения enum', async () => {
    const source = JSON.parse(await readFile(new URL('../../eval/prompts.json', import.meta.url), 'utf8'));
    expect(source.prompts).toHaveLength(40);
    expect(SPEC_STYLES).toEqual(TrackSpecSchema.shape.meta.shape.style.options);
    expect(SPEC_STYLES).not.toContain('dnb');
    const dnb = source.prompts.filter((item) => item.style === 'dnb');
    expect(dnb).toHaveLength(4);
    for (const item of source.prompts) {
      const style = detectSpecStyle(item.text);
      expect(SPEC_STYLES, item.id).toContain(style);
      const spec = fallbackSpec(style, item.id.length);
      expect(TrackSpecSchema.safeParse(spec).success, item.id).toBe(true);
      const checked = checkSpec(spec);
      expect(checked.ok, `${item.id}: ${checked.errors.join('; ')}`).toBe(true);
      expect(compileTrackSpec(spec), item.id).toContain('setCpm(');
      if (item.style === 'dnb') expect(spec.meta.style, item.id).toBe('techno');
      if (item.style === 'lofi') expect(spec.meta.style, item.id).toBe('lo-fi');
    }
  });
});

describe('фаза 7: отпечаток спеки', () => {
  const specA = {
    meta: { style: 'techno', bpm: 132, key: 'Cmin' },
    structure: { sections: [
      { name: 'intro', cycles: 8, energy: 0.3, harmony: 'Cm Ab Fm Gm' },
      { name: 'drop', cycles: 16, energy: 1, harmony: 'Cm Ab Fm Gm' },
    ] },
    parts: { roles: {
      kick: { activeIn: ['intro', 'drop'], pattern: 'bd*4', sound: 's' },
      bass: { activeIn: ['intro'], pattern: '0 ~ 2 4', sound: 'sawtooth' },
    } },
  };

  it('одинаковые спеки дают одинаковый отпечаток', () => {
    expect(TrackSpecSchema.safeParse(specA).success).toBe(true);
    expect(checkSpec(specA).ok).toBe(true);
    expect(fingerprint(specA)).toBe(fingerprint(JSON.parse(JSON.stringify(specA))));
  });

  it('разная форма или гармония меняет отпечаток', () => {
    const other = JSON.parse(JSON.stringify(specA));
    other.structure.sections[0].cycles = 4;
    expect(TrackSpecSchema.safeParse(other).success).toBe(true);
    expect(fingerprint(specA)).not.toBe(fingerprint(other));

    const otherHarmony = JSON.parse(JSON.stringify(specA));
    otherHarmony.structure.sections[0].harmony = 'Fm Cm Ab Gm';
    expect(checkSpec(otherHarmony).ok).toBe(true);
    expect(fingerprint(specA)).not.toBe(fingerprint(otherHarmony));
  });

  it('расстояние между одинаковыми отпечатками ноль', () => {
    const print = fingerprint(specA);
    expect(distanceBetween(print, print)).toBe(0);
  });

  it('расстояние растёт с различиями', () => {
    const near = fingerprint(specA);
    const other = {
      meta: { style: 'ambient', bpm: 64, key: 'Cmin' },
      structure: { sections: [
        { name: 'verse', cycles: 8, energy: 0.4, harmony: 'Ab Fm Cm Gm' },
        { name: 'outro', cycles: 8, energy: 0.1, harmony: 'Fm Ab Gm Cm' },
      ] },
      parts: { roles: { pad: { activeIn: ['verse', 'outro'], pattern: '0,2,4', sound: 'sine' } } },
    };
    expect(checkSpec(other).ok).toBe(true);
    const far = fingerprint(other);
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
