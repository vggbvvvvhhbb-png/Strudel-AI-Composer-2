// L1-метрики мелодии (фаза D) и разбор секций.
//
// Метрики обязаны быть честными: «нет данных» — это null, а не 0, и
// статичный трек не должен получать идеальную оценку за «развитие».

import { describe, it, expect } from 'vitest';

import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { analyzeTrack, melodyMetrics } from '../../server/music/features.js';
import { extractTrack, parseFormSections } from '../../server/music/extract.js';
import { validateTrackSpec } from '../../src/schemas/track-spec.schema.js';

function spec(parts, sections) {
  return validateTrackSpec({
    meta: { style: 'cinematic', key: 'Cmin', bpm: 90 },
    structure: {
      sections: sections ?? [
        { name: 'intro', cycles: 4, energy: 0.35, harmony: 'Cm' },
        { name: 'verse', cycles: 4, energy: 0.55, harmony: 'Cm Ab' },
        { name: 'drop', cycles: 8, energy: 0.9, harmony: 'Cm Gm' },
      ],
    },
    parts: { roles: parts },
  });
}

describe('разбор секций', () => {
  it('порядок секций берётся из строки формы компилятора', () => {
    const code = compileTrackSpec(spec({
      KICK: { role: 'kick', activeIn: ['intro', 'drop'], pattern: 'bd*4', sound: 'bd' },
    }));
    expect(parseFormSections(code)).toEqual(['intro', 'verse', 'drop']);
  });

  it('партия отдаёт ноты по секциям', () => {
    const code = compileTrackSpec(spec({
      LEAD: {
        role: 'lead',
        activeIn: ['intro', 'verse', 'drop'],
        pattern: '0 2 4 2',
        sound: 'triangle',
        sections: {
          intro: { pattern: '0 2 4 2' },
          verse: { pattern: '4 6 8 6' },
          drop: { pattern: '2 4 4 0' },
        },
      },
    }));
    const track = extractTrack(code);
    const part = track.parts[0];
    const parsed = analyzeTrack(code);
    const sections = parsed.parts[0];
    expect(sections.role).toBe('lead');
    // Три секции, в каждой — свои ноты.
    expect(part.sources.filter((source) => source.section).length).toBe(3);
  });
});

describe('L1-метрики мелодии', () => {
  it('развитая мелодия: секции отличаются, материал родственный', () => {
    const code = compileTrackSpec(spec({
      LEAD: {
        role: 'lead',
        activeIn: ['intro', 'verse', 'drop'],
        pattern: '0 2 4 2',
        sound: 'triangle',
        sections: {
          intro: { pattern: '0 2 4 2' },
          verse: { pattern: '4 6 8 6' },
          drop: { pattern: '2 4 4 0' },
        },
      },
    }));
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.motifDevelopment).toBeGreaterThan(0.5);
    expect(analysis.metrics.cadenceClarity).toBeGreaterThan(0.5);
    expect(analysis.melody.parts.length).toBe(1);
  });

  it('статичная мелодия: развития нет — это не дефект измерителя, а факт', () => {
    const code = compileTrackSpec(spec({
      LEAD: {
        role: 'lead',
        activeIn: ['intro', 'verse', 'drop'],
        pattern: '0 2 4 2',
        sound: 'triangle',
      },
    }));
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.motifDevelopment).toBe(0);
    // Связность при этом высокая: одна тема на весь трек.
    expect(analysis.metrics.motifCoherence).toBeGreaterThan(0.9);
  });

  it('одна секция — данных о развитии нет (null, а не 0)', () => {
    // 16 тактов: трек короче не проходит проверку формы (минимум 16).
    const code = compileTrackSpec(spec({
      LEAD: { role: 'lead', activeIn: ['intro'], pattern: '0 2 4 2', sound: 'triangle' },
    }, [{ name: 'intro', cycles: 16, energy: 0.5, harmony: 'Cm' }]));
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.motifDevelopment).toBeNull();
  });

  it('каденция: последняя нота на тонике засчитывается как разрешение', () => {
    const code = compileTrackSpec(spec({
      LEAD: {
        role: 'lead',
        activeIn: ['intro', 'verse', 'drop'],
        pattern: '0 2 4 2',
        sound: 'triangle',
        sections: {
          intro: { pattern: '0 2 4 4' },
          verse: { pattern: '4 6 8 4' },
          drop: { pattern: '2 4 4 0' },
        },
      },
    }));
    const analysis = analyzeTrack(code);
    // Половинная каденция (доминанта) и полное разрешение (тоника).
    expect(analysis.metrics.cadenceClarity).toBe(1);
    expect(analysis.metrics.resolution).toBeGreaterThan(0);
    expect(analysis.metrics.resolution).toBeLessThan(1);
  });

  it('диапазон мелодии измеряется в полутонах', () => {
    const code = compileTrackSpec(spec({
      LEAD: {
        role: 'lead',
        activeIn: ['intro', 'verse', 'drop'],
        pattern: '0 2 4 2',
        sound: 'triangle',
        sections: {
          intro: { pattern: '0 2 4 2' },
          verse: { pattern: '4 6 8 6' },
          drop: { pattern: '2 4 4 0' },
        },
      },
    }));
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.melodyRange).toBeGreaterThan(0);
  });

  it('метрики доступны и как отдельная функция', () => {
    const code = compileTrackSpec(spec({
      LEAD: { role: 'lead', activeIn: ['intro', 'verse', 'drop'], pattern: '0 2 4 2', sound: 'triangle' },
    }));
    const track = extractTrack(code);
    const metrics = melodyMetrics(track, track.key);
    expect(metrics).toHaveProperty('motifCoherence');
    expect(metrics).toHaveProperty('motifDevelopment');
    expect(metrics).toHaveProperty('cadenceClarity');
    expect(metrics).toHaveProperty('contourEntropy');
    expect(metrics).toHaveProperty('melodyRange');
  });
});
