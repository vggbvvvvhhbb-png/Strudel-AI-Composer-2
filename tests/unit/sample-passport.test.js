// Паспорт звука и локальный пул сэмплов (D-115).
//
// Проверяем три вещи: паспорт измеряет, а не выдумывает; пул не принимает
// несвободное; лицензия и атрибуция пишутся в реестр.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPassport,
  spectralShape,
  tonalShape,
  tempoFromOnsets,
  describeCharacter,
} from '../../server/samples/passport.js';
import {
  addToPool,
  readPool,
  writePool,
  listPool,
  getFromPool,
  searchPool,
  attributionFor,
  poolLicenseRegistry,
  poolLicensesMarkdown,
} from '../../server/samples/pool.js';
import { licenseReport } from '../../server/music/licenses.js';

const tempDirs = [];

function tempPoolFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'pool.json');
  writeFileSync(file, JSON.stringify({ samples: {}, updatedAt: null }), 'utf8');
  return file;
}

/** Синусоида 220 Гц длительностью 1 с на 44100 Гц. */
function sine(freq = 220, seconds = 1, sampleRate = 44100) {
  const length = Math.round(seconds * sampleRate);
  const channel = new Float64Array(length);
  for (let i = 0; i < length; i += 1) channel[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return channel;
}

/** Щелчок: короткий всплеск с экспоненциальным спадом. */
function click(times, sampleRate = 44100, lengthS = 1) {
  const length = Math.round(lengthS * sampleRate);
  const channel = new Float64Array(length);
  for (const time of times) {
    const start = Math.round(time * sampleRate);
    for (let i = 0; i < sampleRate * 0.02 && start + i < length; i += 1) {
      channel[start + i] += 0.8 * Math.exp(-i / (sampleRate * 0.004));
    }
  }
  return channel;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('passport: измерение', () => {
  it('паспорт содержит длительность, громкость и спектр', () => {
    const passport = buildPassport([sine()], 44100, { name: 'тон' });
    expect(passport.durationS).toBeCloseTo(1, 2);
    expect(passport.sampleRate).toBe(44100);
    expect(passport.loudness.lufsI).not.toBeNull();
    expect(passport.spectral.centroidHz).not.toBeNull();
    expect(passport.spectral.bands).toBeTruthy();
  });

  it('центроид тона 220 Гц близок к самой частоте', () => {
    const shape = spectralShape(sine(220, 0.5), 44100);
    expect(shape.centroidHz).toBeGreaterThan(150);
    expect(shape.centroidHz).toBeLessThan(300);
    // rolloff измеряется, а не остаётся нулём (регресс: сумма не копилась).
    expect(shape.rolloffHz).toBeGreaterThan(150);
    expect(shape.rolloffHz).toBeLessThan(500);
  });

  it('тональный сигнал даёт высоту, шум — нет', () => {
    const tonal = tonalShape(sine(220, 0.5), 44100);
    expect(tonal.f0Hz).toBeGreaterThan(200);
    expect(tonal.f0Hz).toBeLessThan(240);
    // note — имя ноты, а не номер класса высоты (регресс: pitchClass — число).
    expect(tonal.note).toBe('A');

    const noise = new Float64Array(22050);
    for (let i = 0; i < noise.length; i += 1) noise[i] = Math.random() * 2 - 1;
    const noisy = tonalShape(noise, 44100);
    expect(noisy.f0Hz === null || noisy.voicedRatio < 0.5).toBe(true);
  });

  it('темп по атакам: ровные удары дают темп, одиночные — нет', () => {
    const steady = tempoFromOnsets([0, 0.5, 1, 1.5, 2]);
    expect(steady.bpm).toBeCloseTo(120, 0);
    expect(steady.confidence).toBeGreaterThan(0.5);
    expect(tempoFromOnsets([0.3]).bpm).toBeNull();
  });

  it('атаки считаются по сигналу', () => {
    const passport = buildPassport([click([0, 0.25, 0.5, 0.75])], 44100);
    expect(passport.transients.count).toBeGreaterThanOrEqual(3);
    expect(passport.transients.densityPerSec).toBeGreaterThan(2);
  });

  it('нечего измерять — null, а не ноль', () => {
    const passport = buildPassport([], 44100);
    expect(passport.durationS).toBeNull();
    expect(passport.loudness.lufsI).toBeNull();
    expect(passport.spectral.centroidHz).toBeNull();
    expect(passport.tempo.bpm).toBeNull();
  });

  it('характер описывается измеренными величинами', () => {
    const traits = describeCharacter({
      centroidHz: 8000,
      densityPerSec: 6,
      voicedRatio: 0.1,
      lufsI: -12,
    });
    expect(traits).toContain('резкий по верхам');
    expect(traits).toContain('плотный');
    expect(describeCharacter({})).toEqual([]);
  });
});

describe('pool: лицензии', () => {
  it('запись без разрешённой лицензии не принимается', () => {
    const file = tempPoolFile();
    const result = addToPool({ id: 'x', license: 'Attribution Noncommercial' }, { file });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('не в списке разрешённых');
  });

  it('CC0 и CC-BY принимаются', () => {
    const file = tempPoolFile();
    expect(addToPool({ id: 'a', license: 'Creative Commons 0' }, { file }).ok).toBe(true);
    expect(addToPool({ id: 'b', license: 'Attribution' }, { file }).ok).toBe(true);
  });

  it('в записи лежит строка атрибуции', () => {
    const file = tempPoolFile();
    const added = addToPool({
      id: 'c',
      name: 'Glass Hit',
      author: 'someone',
      url: 'https://freesound.org/people/someone/sounds/1/',
      license: 'Attribution',
    }, { file });
    expect(added.entry.attribution).toContain('Glass Hit');
    expect(added.entry.attribution).toContain('CC BY 4.0');
    expect(added.entry.attribution).toContain('someone');
  });

  it('реестр лицензий пула считает CC0 и CC-BY отдельно', () => {
    const file = tempPoolFile();
    addToPool({ id: 'a', license: 'Creative Commons 0' }, { file });
    addToPool({ id: 'b', license: 'Attribution' }, { file });
    const registry = poolLicenseRegistry({ file });
    expect(registry.totals.samples).toBe(2);
    expect(registry.totals.cc0).toBe(1);
    expect(registry.totals.ccBy).toBe(1);
    expect(registry.samples.b.attributionRequired).toBe(true);
  });

  it('атрибуция для неизвестной записи говорит, что источник неизвестен', () => {
    expect(attributionFor(null)).toContain('неизвестен');
  });
});

describe('pool: записи и поиск', () => {
  it('пустой пул честно пуст', () => {
    const file = tempPoolFile();
    expect(listPool({ file })).toEqual([]);
    expect(readPool(file).samples).toEqual({});
  });

  it('запись читается по идентификатору', () => {
    const file = tempPoolFile();
    addToPool({ id: 'z', name: 'Zap', license: 'Creative Commons 0' }, { file });
    expect(getFromPool('z', { file }).name).toBe('Zap');
    expect(getFromPool('нет', { file })).toBeNull();
  });

  it('поиск по описанию находит по измеренному характеру', () => {
    const file = tempPoolFile();
    addToPool({
      id: 'glass',
      name: 'Glass Impact',
      license: 'Creative Commons 0',
      passport: { character: ['яркий', 'ударный'], durationS: 0.6 },
    }, { file });
    const found = searchPool('яркий ударный', { file });
    expect(found.length).toBe(1);
    expect(found[0].entry.id).toBe('glass');
    expect(searchPool('ничего похожего тут нет', { file })).toEqual([]);
  });

  it('раздел markdown перечисляет лицензии и атрибуцию', () => {
    const file = tempPoolFile();
    addToPool({
      id: 'g',
      name: 'Glass',
      author: 'ann',
      url: 'https://freesound.org/people/ann/sounds/2/',
      license: 'Attribution',
    }, { file });
    const markdown = poolLicensesMarkdown({ file });
    expect(markdown).toContain('CC BY 4.0');
    expect(markdown).toContain('ann');
    expect(markdown).toContain('licenses:pool');
  });

  it('строка таблицы лицензий — настоящие 6 ячеек, а не одна склеенная', () => {
    const file = tempPoolFile();
    addToPool({
      id: 'g',
      name: 'Glass | Hit',
      author: 'ann',
      url: 'https://freesound.org/people/ann/sounds/2/',
      license: 'Attribution',
    }, { file });
    const markdown = poolLicensesMarkdown({ file });
    const row = markdown.split('\n').find((line) => line.includes('ann'));
    expect(row).toBeTruthy();
    // 6 ячеек = 7 неэкранированных разделителей; '|' внутри имени экранирован.
    const separators = row.match(/(?<!\\)\|/g) ?? [];
    expect(separators.length).toBe(7);
    expect(row).toContain('Glass \\| Hit');
    expect(row.startsWith('| ')).toBe(true);
    expect(row.endsWith(' |')).toBe(true);
  });

  it('пустой пул даёт честный отчёт без выдуманных записей', () => {
    const file = tempPoolFile();
    const pool = readPool(file);
    writePool(pool, file);
    expect(poolLicenseRegistry({ file }).totals.samples).toBe(0);
  });
});

describe('лицензии проекта видят пул', () => {
  it('отчёт о лицензиях содержит слой пула', () => {
    const report = licenseReport();
    expect(report).toHaveProperty('pool');
    expect(report.pool).toHaveProperty('totals');
    expect(typeof report.pool.totals.samples).toBe('number');
  });
});
