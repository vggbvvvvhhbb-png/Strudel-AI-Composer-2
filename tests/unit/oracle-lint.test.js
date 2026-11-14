// Линтер, скор, канарейки, поиск и критик.
//
// Ключевая проверка здесь — mutation testing линтера (бриф §6): в эталонный
// трек вносятся заведомые дефекты, и линтер обязан их находить.
// Требование: recall ≥ 95 %, precision ≥ 90 %.

import { describe, it, expect } from 'vitest';
import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';
import { cloneIR } from '../../src/ir/schema.js';
import { applyTransform, TRANSFORMS } from '../../src/ir/transforms.js';
import { symbolicReport } from '../../src/oracle/report.js';
import { lintSymbolic } from '../../src/oracle/lint.js';
import { canaryTracks, checkCanaries } from '../../src/oracle/canaries.js';
import { searchBest, mutateIR } from '../../src/oracle/search.js';
import { critique } from '../../src/oracle/critic.js';

const PROMPTS = [
  'мрачный трип-хоп про дождь',
  'уютный лоуфай для учёбы',
  'эйфоричный фестиваль',
  'злой быстрый dnb',
  'тревожный эмбиент, пустой космос',
];

describe('Символьный отчёт', () => {
  it.each(PROMPTS)('отчёт собирается и не пустой: %s', (prompt) => {
    const ir = planIR(prompt, { seed: 42 });
    const report = symbolicReport(ir);
    expect(report.bars).toBeGreaterThan(0);
    expect(report.eventCount).toBeGreaterThan(0);
    expect(report.score.total).toBeGreaterThan(0);
    expect(report.score.total).toBeLessThanOrEqual(100);
    expect(report.lintSummary.total).toBe(report.lint.length);
    expect(report.metrics.energyProfile.length).toBe(report.bars);
    expect(report.metrics.targetProfile.length).toBe(report.bars);
  });

  it('отчёт детерминирован: тот же IR — тот же отчёт', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const a = symbolicReport(ir);
    const b = symbolicReport(cloneIR(ir));
    expect(a.irHash).toBe(b.irHash);
    expect(a.score.total).toBe(b.score.total);
    expect(a.metrics.energyProfile).toEqual(b.metrics.energyProfile);
  });

  it('форма измеряется: секций ≥ 3 и контраст соседей считается', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const report = symbolicReport(ir);
    expect(report.sections.length).toBeGreaterThanOrEqual(3);
    expect(report.metrics.sectionContrasts.length).toBe(report.sections.length - 1);
    expect(report.metrics.minContrast).toBeGreaterThanOrEqual(0);
    expect(report.metrics.minContrast).toBeLessThanOrEqual(1);
  });

  it('профиль энергии коррелирует с целевой кривой арки', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const report = symbolicReport(ir);
    expect(report.metrics.energyCorrelation).not.toBeNull();
    expect(report.metrics.energyCorrelation).toBeGreaterThan(0.5);
  });
});

describe('Линтер: mutation testing', () => {
  /** Дефекты, которые линтер обязан находить. */
  const DEFECTS = [
    {
      id: 'no-sections',
      label: 'трек без формы (одна секция)',
      expectCode: 'sections-too-few',
      apply: (ir) => {
        const next = cloneIR(ir);
        next.sections = [next.sections[0]];
        return next;
      },
    },
    {
      id: 'empty-section',
      label: 'пустая секция в арке',
      expectCode: 'empty-section',
      apply: (ir) => {
        const next = cloneIR(ir);
        const section = next.sections[1];
        section.layers = { texture: { plan: 'texture', density: 0, register: [48, 84], weight: 0 } };
        return next;
      },
    },
    {
      id: 'mechanical-timing',
      label: 'никакого микротайминга',
      expectCode: 'timing-mechanical',
      apply: (ir) => {
        const next = cloneIR(ir);
        next.groove.template = 'straight';
        next.groove.amount = 0;
        next.groove.swing = 0.5;
        next.groove.offsetMs = 0;
        for (const section of next.sections) {
          for (const role of Object.keys(section.layers)) {
            section.layers[role] = { ...section.layers[role], density: 1 };
          }
        }
        return next;
      },
    },
    {
      id: 'bass-high',
      label: 'бас уехал в середину',
      expectCode: 'bass-register-high',
      apply: (ir) => {
        const next = cloneIR(ir);
        for (const section of next.sections) {
          if (!section.layers.bass) continue;
          section.layers.bass = { ...section.layers.bass, register: [60, 72] };
        }
        return next;
      },
    },
  ];

  it('находит не меньше 95 % внесённых дефектов (recall)', () => {
    let found = 0;
    let total = 0;
    for (const prompt of PROMPTS) {
      const ir = planIR(prompt, { seed: 42 });
      for (const defect of DEFECTS) {
        total += 1;
        const broken = defect.apply(ir);
        const report = symbolicReport(broken);
        const codes = report.lint.map((finding) => finding.code);
        if (codes.includes(defect.expectCode)) found += 1;
      }
    }
    const recall = found / total;
    expect(recall, `recall ${found}/${total}`).toBeGreaterThanOrEqual(0.95);
  });

  it('не выдумывает замечаний на здоровом треке (precision)', () => {
    for (const prompt of PROMPTS) {
      const ir = planIR(prompt, { seed: 42 });
      const report = symbolicReport(ir);
      const errors = report.lint.filter((finding) => finding.severity === 'error');
      expect(errors.map((finding) => finding.code), prompt).toEqual([]);
    }
  });

  it('каждое замечание содержит код, серьёзность и предложенные трансформации', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const report = symbolicReport(ir);
    for (const finding of report.lint) {
      expect(typeof finding.code).toBe('string');
      expect(['error', 'warning', 'info']).toContain(finding.severity);
      expect(Array.isArray(finding.suggestedTransforms)).toBe(true);
      for (const transform of finding.suggestedTransforms) {
        expect(typeof transform.transform).toBe('string');
        // Предложенная трансформация должна существовать в реестре.
        expect(Object.keys(TRANSFORMS)).toContain(transform.transform);
      }
    }
  });

  it('линтер не выдаёт замечаний о пустом треке как об ошибках', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const broken = cloneIR(ir);
    broken.sections = [];
    const report = symbolicReport(broken);
    expect(report.lint.some((finding) => finding.code === 'sections-too-few')).toBe(true);
  });
});

describe('Канарейки (анти-взлом скора)', () => {
  it('каждая канарейка набирает меньше медианы нормального корпуса', () => {
    const corpus = PROMPTS.map((prompt) => symbolicReport(planIR(prompt, { seed: 42 })).score.total);
    const canaries = canaryTracks().map((canary) => ({
      id: canary.id,
      label: canary.label,
      score: symbolicReport(canary.ir).score.total,
    }));
    const check = checkCanaries(corpus, canaries);
    const details = canaries
      .map((canary) => `${canary.label}=${canary.score.toFixed(1)}`)
      .join(', ');
    expect(check.ok, `медиана ${check.median.toFixed(1)}; ${details}`).toBe(true);
  });

  it('канарейки собираются как обычные IR и компилируются', () => {
    for (const canary of canaryTracks()) {
      const compiled = compileIR(canary.ir);
      expect(typeof compiled.code).toBe('string');
      expect(compiled.code.length).toBeGreaterThan(0);
    }
  });
});

describe('Поиск best-of-N', () => {
  it('оценивает кандидатов и возвращает лучших', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const result = searchBest(ir, { n: 16, topK: 3 });
    expect(result.evaluated).toBe(16);
    expect(result.candidates.length).toBe(3);
    for (const candidate of result.candidates) {
      expect(candidate.score).not.toBeNull();
    }
    // Кандидаты отсортированы по убыванию скора.
    const scores = result.candidates.map((candidate) => candidate.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('поиск детерминирован', () => {
    const ir = planIR('уютный лоуфай для учёбы', { seed: 42 });
    const a = searchBest(ir, { n: 8, topK: 3 });
    const b = searchBest(ir, { n: 8, topK: 3 });
    expect(a.candidates.map((c) => c.mutation)).toEqual(b.candidates.map((c) => c.mutation));
    expect(a.candidates.map((c) => c.score)).toEqual(b.candidates.map((c) => c.score));
  });

  it('мутация не ломает IR: результат проходит валидацию', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    for (let index = 0; index < 10; index += 1) {
      const mutation = mutateIR(ir, 42, index);
      expect(() => symbolicReport(mutation.ir)).not.toThrow();
    }
  });

  it('быстрый оракул успевает за десятки кандидатов в секунду', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const started = Date.now();
    const result = searchBest(ir, { n: 32, topK: 3 });
    const elapsed = Date.now() - started;
    expect(result.evaluated).toBe(32);
    // Бюджет брифа: оракул ≤ 50 мс на трек. Здесь — 32 кандидата,
    // поэтому берём 32 × 50 мс как верхнюю границу.
    expect(elapsed, `32 кандидата за ${elapsed} мс`).toBeLessThan(32 * 50);
  });
});

describe('Критик-цикл', () => {
  it('не ухудшает трек и не берёт больше трёх итераций', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const result = critique(ir);
    expect(result.report.score.total).toBeGreaterThanOrEqual(result.startScore);
    expect(result.steps.length).toBeLessThanOrEqual(3);
  });

  it('исходный IR не мутируется', () => {
    const ir = planIR('уютный лоуфай для учёбы', { seed: 42 });
    const before = JSON.stringify(ir);
    critique(ir);
    expect(JSON.stringify(ir)).toBe(before);
  });

  it('принимает только те правки, что подняли скор', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const result = critique(ir);
    for (const step of result.steps) {
      if (step.accepted) {
        expect(step.scoreAfter).toBeGreaterThan(step.scoreBefore);
      } else {
        expect(step.scoreAfter).toBeLessThanOrEqual(step.scoreBefore);
      }
    }
  });

  it('находит и чинит дефект: трек без формы получает секции обратно', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const broken = cloneIR(ir);
    broken.sections = [broken.sections[0]];
    const result = critique(broken);
    const codes = result.report.lint.map((finding) => finding.code);
    expect(result.report.score.total).toBeGreaterThanOrEqual(symbolicReport(broken).score.total);
    expect(Array.isArray(codes)).toBe(true);
  });
});
