// Библиотека стилей, собранная из паспортов разбора (D-112).
//
// Проверяем честность пайплайна: числа извлекаются только из измеренного,
// нотные последовательности не переносятся, редкий стиль в промпт не идёт,
// а композитор реально потребляет библиотеку.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  extractFeatures,
  onsetHistogram16,
  backbeatWeight,
  intervalDistribution,
  normalizedEntropy,
  rangeSemitones,
  pauseShare,
} from '../../server/music/mining/extract.js';
import {
  aggregateStyle,
  buildLibrary,
  melodyLeak,
  verifyLibrary,
  MIN_SOURCES,
} from '../../server/music/mining/aggregate.js';
import {
  loadMinedLibrary,
  minedStats,
  minedDigest,
  resetMinedLibraryCache,
} from '../../server/music/mining/library.js';
import {
  profileFromPattern,
  histogramDistance,
  matchMinedPattern,
} from '../../server/music/mining/groove.js';
import { styleDigest } from '../../server/music/compose/pipeline.js';

const tempDirs = [];

function makeLibraryDir(styles) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mined-'));
  tempDirs.push(dir);
  const index = {
    schemaVersion: '1.0',
    sources: Object.values(styles).reduce((sum, list) => sum + list.length, 0),
    styles: Object.keys(styles),
    minSources: MIN_SOURCES,
  };
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index), 'utf8');
  for (const [style, stats] of Object.entries(styles)) {
    writeFileSync(path.join(dir, `${style}.json`), JSON.stringify(stats), 'utf8');
  }
  return dir;
}

function sampleStats(sources) {
  return {
    sources,
    sparse: sources < MIN_SOURCES,
    bpm: { mean: 128, p25: 120, p75: 132 },
    groove: {
      onsetHistogram16: new Array(16).fill(0.0625),
      swingRatio: 0.5,
      backbeatWeight: 0.5,
    },
    contour: { intervalDistribution: { 0: 1 }, entropy: 0.1, rangeSemitones: 7, pauseShare: 0.2 },
    energy: { perSectionCurve: [0.3, 0.9, 0.4], peakPosition: 0.33 },
    timbre: { centroidHzByRole: { drums: 4000 } },
  };
}

afterEach(() => {
  resetMinedLibraryCache();
  delete process.env.MINED_LIBRARY_DIR;
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('mining/extract', () => {
  const passport = {
    track: { id: 'job-1' },
    measurements: {
      tempo: { bpm: 128, confidence: 0.9 },
      key: { tonic: 'F', mode: 'minor', confidence: 0.8 },
    },
    structure: [
      { label: 'intro', energy: 0.3 },
      { label: 'drop', energy: 0.9 },
      { label: 'outro', energy: 0.4 },
    ],
    stem_descriptors: {
      drums: {
        onsets: {
          swing: 0.56,
          hits: [
            { time_s: 0 },
            { time_s: 0.234375 },
            { time_s: 0.46875 },
            { time_s: 0.703125 },
          ],
        },
      },
      lead: { notes: [{ midi: 60 }, { midi: 64 }, { midi: 67 }] },
    },
  };

  it('гистограмма атак нормирована и состоит из 16 слотов', () => {
    const histogram = onsetHistogram16(passport.stem_descriptors.drums.onsets.hits, 128);
    expect(histogram).toHaveLength(16);
    expect(histogram.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
  });

  it('вес бэкбита считается по долям такта', () => {
    const weight = backbeatWeight(
      [{ time_s: 0 }, { time_s: 60 / 128 }, { time_s: 120 / 128 }, { time_s: 180 / 128 }],
      128,
    );
    expect(weight).toBeGreaterThan(0);
    expect(weight).toBeLessThanOrEqual(1);
  });

  it('неизмеренные величины дают null, а не 0', () => {
    expect(onsetHistogram16([], 120)).toBeNull();
    expect(onsetHistogram16([{ time_s: 0 }], null)).toBeNull();
    expect(backbeatWeight([], 120)).toBeNull();
    expect(intervalDistribution([])).toBeNull();
    expect(normalizedEntropy(null)).toBeNull();
    expect(rangeSemitones([])).toBeNull();
    expect(pauseShare([60], 0.25)).toBeNull();
  });

  it('фичи паспорта собираются из измеренных данных', () => {
    const features = extractFeatures(passport, { style: 'techno' });
    expect(features.style).toBe('techno');
    expect(features.bpm).toBe(128);
    expect(features.key).toBe('F minor');
    expect(features.groove.onsetHistogram16).toHaveLength(16);
    expect(features.energy.perSectionCurve).toEqual([0.3, 0.9, 0.4]);
    expect(features.contour.rangeSemitones).toBe(7);
  });
});

describe('mining/aggregate', () => {
  const features = Array.from({ length: 6 }, (_, index) => ({
    style: 'techno',
    bpm: 120 + index,
    groove: { onsetHistogram16: new Array(16).fill(0.0625), swingRatio: 0.5, backbeatWeight: 0.5 },
    contour: { intervalDistribution: { 0: 0.5, 2: 0.5 }, entropy: 0.8, rangeSemitones: 7, pauseShare: 0.2 },
    energy: { perSectionCurve: [0.3, 0.9], peakPosition: 0.5 },
    timbre: { byRole: { drums: { centroidHz: 4000 } } },
  }));

  it('стиль с достаточным числом источников не помечается редким', () => {
    const stats = aggregateStyle(features);
    expect(stats.sources).toBe(6);
    expect(stats.sparse).toBe(false);
    expect(stats.bpm.mean).toBe(122.5);
  });

  it('мало источников — стиль помечается редким', () => {
    const stats = aggregateStyle(features.slice(0, 2));
    expect(stats.sparse).toBe(true);
  });

  it('сборка библиотеки идемпотентна', () => {
    const first = buildLibrary(features);
    const second = buildLibrary(features);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.index.styles).toEqual(['techno']);
  });

  it('страж не пропускает нотные последовательности', () => {
    const library = buildLibrary(features);
    expect(verifyLibrary(library).ok).toBe(true);
    const dirty = JSON.parse(JSON.stringify(library));
    dirty.styles.techno.contour.notes = [60, 62, 64];
    expect(melodyLeak(dirty).ok).toBe(false);
  });
});

describe('mining/library', () => {
  it('пустая библиотека честно сообщает об отсутствии источников', () => {
    const dir = makeLibraryDir({});
    process.env.MINED_LIBRARY_DIR = dir;
    resetMinedLibraryCache();
    const library = loadMinedLibrary();
    expect(library.index.sources).toBe(0);
    expect(minedStats('techno')).toBeNull();
    expect(minedDigest('techno')).toBe('');
  });

  it('редкий стиль не отдаётся ни в статистику, ни в промпт', () => {
    const dir = makeLibraryDir({ techno: sampleStats(2) });
    process.env.MINED_LIBRARY_DIR = dir;
    resetMinedLibraryCache();
    expect(minedStats('techno')).toBeNull();
    expect(minedDigest('techno')).toBe('');
  });

  it('достаточный стиль отдаёт числа в дайджест', () => {
    const dir = makeLibraryDir({ techno: sampleStats(6) });
    process.env.MINED_LIBRARY_DIR = dir;
    resetMinedLibraryCache();
    const digest = minedDigest('techno');
    expect(digest).toContain('Измеренная статистика стиля');
    expect(digest).toContain('128');
    expect(minedStats('techno').sources).toBe(6);
  });
});

describe('mining/groove', () => {
  it('профиль паттерна считается по событиям mini-нотации', () => {
    const profile = profileFromPattern('bd*4');
    expect(profile).not.toBeNull();
    expect(profile.histogram16).toHaveLength(16);
    expect(profile.density).toBe(4);
  });

  it('расстояние между одинаковыми гистограммами равно нулю', () => {
    const a = new Array(16).fill(0.0625);
    expect(histogramDistance(a, a)).toBe(0);
  });

  it('подбор рисунка выбирает ближайший к измеренному груву', () => {
    const mined = {
      groove: {
        onsetHistogram16: [0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0],
        backbeatWeight: 0.5,
      },
    };
    const match = matchMinedPattern(['bd*4', 'bd ~ bd ~', 'bd sd bd sd'], mined);
    expect(match).not.toBeNull();
    expect(match.pattern).toBe('bd ~ bd ~');
  });

  it('без измеренных данных подбор молчит', () => {
    expect(matchMinedPattern(['bd*4'], null)).toBeNull();
    expect(matchMinedPattern([], { groove: { onsetHistogram16: new Array(16).fill(0.0625) } })).toBeNull();
  });
});

describe('композитор потребляет библиотеку', () => {
  it('в дайджест стиля попадают измеренные числа', () => {
    const dir = makeLibraryDir({ techno: sampleStats(6) });
    process.env.MINED_LIBRARY_DIR = dir;
    resetMinedLibraryCache();
    const digest = styleDigest('techno');
    expect(digest).toContain('Измеренная статистика стиля');
    expect(digest).toContain('свинг');
  });

  it('без библиотеки дайджест остаётся прежним', () => {
    const dir = makeLibraryDir({});
    process.env.MINED_LIBRARY_DIR = dir;
    resetMinedLibraryCache();
    const digest = styleDigest('techno');
    expect(digest).not.toContain('Измеренная статистика стиля');
    expect(digest).toContain('kick');
  });
});
