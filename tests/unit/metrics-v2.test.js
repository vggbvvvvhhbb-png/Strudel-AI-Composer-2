// Фаза 4: метрики v2 и защита от читерства.
//
// Главное здесь — последнее: каждая adversarial-фикстура обязана получить
// балл НИЖЕ эталонного трека. Если метрику сломать, тест обязан падать.

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeProgression,
  energyMetrics,
  harmonyMetrics,
  noveltyMetrics,
  variabilityMetrics,
  diversityMetrics,
  automationMetrics,
  jaccard,
  windowDistance,
  WINDOW_BARS,
  NEAR_REPEAT_EPS,
} from '../../server/music/metrics/progression.js';
import { analyzeTrackFromEvents } from '../../server/music/metrics/events.js';
import { scoreTrackV2, V2_CRITERIA, MIN_FORM_BARS } from '../../server/music/score-v2.js';
import { compile } from '../../server/music/compiler/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

async function fixture(name) {
  return readFile(join(root, 'tests/fixtures/cheat', name), 'utf8');
}

/**
 * Эталонный трек: собран компилятором из нормальной спеки.
 * Шесть партий — столько требует профиль стиля.
 */
const referenceSpec = {
  meta: { style: 'techno', bpm: 132, key: 'f:minor', seed: 42 },
  harmony: { progressionId: 'techno-minor-i-vi-iv-v', barsPerChord: 2 },
  form: [
    { kind: 'intro', bars: 8, energy: 0.25, roles: { hats: { recipe: 'sparse' }, bass: { recipe: 'sparse' } } },
    {
      kind: 'build',
      bars: 8,
      energy: 0.6,
      roles: { kick: { recipe: 'default' }, hats: { recipe: 'default' }, bass: { recipe: 'default' } },
      transition: { into: 'drop', type: 'riser' },
    },
    {
      kind: 'drop',
      bars: 16,
      energy: 1.0,
      roles: {
        kick: { recipe: 'busy' },
        snare: { recipe: 'busy' },
        hats: { recipe: 'busy' },
        bass: { recipe: 'busy' },
        arp: { recipe: 'busy' },
        pad: { recipe: 'sparse' },
      },
    },
    { kind: 'breakdown', bars: 8, energy: 0.3, roles: { hats: { recipe: 'sparse' }, pad: { recipe: 'sparse' } } },
    {
      kind: 'build',
      bars: 8,
      energy: 0.75,
      roles: { kick: { recipe: 'busy' }, hats: { recipe: 'busy' }, bass: { recipe: 'busy' } },
      transition: { into: 'drop', type: 'riser' },
    },
    {
      kind: 'drop',
      bars: 16,
      energy: 1.0,
      roles: {
        kick: { recipe: 'busy' },
        snare: { recipe: 'busy' },
        hats: { recipe: 'busy' },
        bass: { recipe: 'busy' },
        arp: { recipe: 'busy' },
        pad: { recipe: 'sparse' },
      },
    },
    { kind: 'outro', bars: 8, energy: 0.2, roles: { hats: { recipe: 'sparse' }, bass: { recipe: 'sparse' } } },
  ],
  motif: { degrees: [4, 2, 0, 2], rhythm: 'x ~ x x', transforms: ['sequence'] },
};

const referenceCode = compile(referenceSpec).code;

describe('фаза 4: метрики по событиям Strudel', () => {
  it('эталонный трек исполняется и даёт события', async () => {
    const metrics = await analyzeProgression(referenceCode, { cycles: 64, style: 'techno' });
    expect(metrics.ok).toBe(true);
    expect(metrics.bars).toBe(64);
    expect(metrics.parts.length).toBeGreaterThan(3);
  });

  it('энергия меняется: у эталона размах больше нуля', async () => {
    const metrics = await analyzeProgression(referenceCode, { cycles: 64, style: 'techno' });
    expect(metrics.energy.dynamicRange).toBeGreaterThan(0.1);
    expect(metrics.energy.curve.length).toBe(64);
  });

  it('гармония меняется: у эталона есть смены аккордов', async () => {
    const metrics = await analyzeProgression(referenceCode, { cycles: 64, style: 'techno' });
    expect(metrics.harmony.changes).toBeGreaterThan(0);
    expect(metrics.harmony.distinct).toBeGreaterThan(1);
  });

  it('автоматизация: у эталона часть параметров движется', async () => {
    const metrics = await analyzeProgression(referenceCode, { cycles: 64, style: 'techno' });
    expect(metrics.automation.total).toBeGreaterThan(0);
    expect(metrics.automation.ratio).toBeGreaterThan(0);
  });

  it('окна считаются по 4 такта', async () => {
    const metrics = await analyzeProgression(referenceCode, { cycles: 64, style: 'techno' });
    expect(metrics.windows.length).toBe(Math.ceil(64 / WINDOW_BARS));
  });
});

describe('фаза 4: чистые функции метрик', () => {
  it('Жаккар: одинаковые множества — 1, разные — 0', () => {
    expect(jaccard([1, 2, 3], [1, 2, 3])).toBe(1);
    expect(jaccard([1, 2], [3, 4])).toBe(0);
    expect(jaccard([], [])).toBe(1);
  });

  it('расстояние окон: одинаковые — ноль', () => {
    const a = { histogram: new Array(12).fill(1 / 12), density: 10, activeParts: 5, centroid: 60 };
    const b = { ...a, histogram: [...a.histogram] };
    expect(windowDistance(a, b)).toBe(0);
  });

  it('размах энергии ноль у плоского трека', () => {
    const frames = Array.from({ length: 8 }, () => ({
      bar: 0,
      activeParts: 4,
      onsets: 8,
      density: 8,
      histogram: new Array(12).fill(1 / 12),
      centroid: 60,
      roots: [],
      chordPcs: [],
    }));
    const energy = energyMetrics(frames, [], 'techno');
    expect(energy.dynamicRange).toBe(0);
  });

  it('окна близкие считаются почти-повторами', () => {
    const base = { histogram: new Array(12).fill(1 / 12), density: 10, activeParts: 5, centroid: 60 };
    const windows = [base, { ...base, histogram: [...base.histogram] }, { ...base }];
    const novelty = noveltyMetrics(windows);
    expect(novelty.nearRepeatShare).toBeGreaterThan(0.5);
    expect(novelty.mean).toBe(0);
  });
});

describe('фаза 4: метрики v1 по событиям', () => {
  it('структурированный трек даёт ненулевую плотность', async () => {
    // Свой парсер mini-нотации не понимает arrange и находит ноль событий —
    // поэтому старые критерии пересчитываются по событиям Strudel.
    const analysis = await analyzeTrackFromEvents(referenceCode, { cycles: 8 });
    expect(analysis.metrics.density).toBeGreaterThan(0);
    expect(analysis.metrics.partCount).toBeGreaterThan(3);
  });

  it('тональность считается по объявленному ключу', async () => {
    const code = await fixture('b-out-of-scale.js');
    const analysis = await analyzeTrackFromEvents(code, { cycles: 8 });
    expect(analysis.key?.name).toBe('c:minor');
    expect(analysis.metrics.scaleFit).toBeLessThan(0.8);
    expect(analysis.outsideScale.length).toBeGreaterThan(0);
  });
});

describe('фаза 4: скор v2', () => {
  it('новые критерии весят 40, старые масштабируются до 60', () => {
    const newWeight = V2_CRITERIA.reduce((sum, c) => sum + c.weight, 0);
    expect(newWeight).toBe(40);
  });

  it('эталонный трек получает высокий балл', async () => {
    const score = await scoreTrackV2(referenceCode, 'techno');
    expect(score.hasForm).toBe(true);
    expect(score.total).toBeGreaterThan(70);
    expect(score.newTotal).toBeGreaterThan(0);
    expect(score.oldTotal).toBeGreaterThan(0);
  });

  it('трек короче 16 тактов: новые критерии не применяются, но есть замечание', async () => {
    const shortSpec = {
      ...referenceSpec,
      form: [
        { kind: 'intro', bars: 4, energy: 0.3, roles: { kick: { recipe: 'default' } } },
        { kind: 'drop', bars: 8, energy: 1, roles: { kick: { recipe: 'busy' }, bass: { recipe: 'busy' } } },
      ],
    };
    const score = await scoreTrackV2(compile(shortSpec).code, 'techno');
    expect(score.hasForm).toBe(false);
    expect(score.newTotal).toBe(0);
    expect(score.issues.some((i) => i.id === 'no-form')).toBe(true);
  });

  it('замечания конкретные: называют, что не так и что делать', async () => {
    const score = await scoreTrackV2(await fixture('a-repeated-cycle.js'), 'techno');
    expect(score.issues.length).toBeGreaterThan(0);
    for (const issue of score.issues) {
      expect(issue.hint.length).toBeGreaterThan(20);
    }
  });
});

describe('фаза 4: защита от читерства', () => {
  it('эталон набирает больше всех adversarial-фикстур', async () => {
    const reference = await scoreTrackV2(referenceCode, 'techno');

    const cases = [
      ['a-repeated-cycle.js', 'один цикл, растянутый на 64 такта'],
      ['b-out-of-scale.js', 'ноты вне лада'],
      ['c-same-rhythm.js', '8 партий с одним ритмом'],
      ['d-static-params.js', 'статичные параметры'],
    ];

    for (const [file, description] of cases) {
      const code = await fixture(file);
      const score = await scoreTrackV2(code, 'techno');
      expect(
        score.total,
        `${description} (${file}) набрал ${score.total}, эталон — ${reference.total}`,
      ).toBeLessThan(reference.total);
    }
  }, 30000);

  it('фикстура (a): нет развития — размах энергии ноль, гармония не меняется', async () => {
    const metrics = await analyzeProgression(await fixture('a-repeated-cycle.js'), {
      cycles: 64,
      style: 'techno',
    });
    expect(metrics.energy.dynamicRange).toBe(0);
    expect(metrics.harmony.changes).toBe(0);
    expect(metrics.novelty.mean).toBe(0);
  });

  it('фикстура (b): тональность низкая, несмотря на разнообразие', async () => {
    const code = await fixture('b-out-of-scale.js');
    const analysis = await analyzeTrackFromEvents(code, { cycles: 8 });
    const metrics = await analyzeProgression(code, { cycles: 64, style: 'techno' });
    expect(analysis.metrics.scaleFit).toBeLessThan(0.8);
    // При этом трек разнообразен: партий много, рисунки разные.
    expect(metrics.diversity.parts).toBeGreaterThan(4);
  });

  it('фикстура (c): партии играют один и тот же ритм', async () => {
    const metrics = await analyzeProgression(await fixture('c-same-rhythm.js'), {
      cycles: 64,
      style: 'techno',
    });
    // Жаккар сеток онсетов у партий максимальный: рисунок общий.
    expect(metrics.diversity.maxJaccard).toBe(1);
    expect(metrics.diversity.meanJaccard).toBeGreaterThan(0.8);
  });

  it('фикстура (d): автоматизации нет', async () => {
    const metrics = await analyzeProgression(await fixture('d-static-params.js'), {
      cycles: 64,
      style: 'techno',
    });
    expect(metrics.automation.total).toBeGreaterThan(0);
    expect(metrics.automation.ratio).toBe(0);
  });
});
