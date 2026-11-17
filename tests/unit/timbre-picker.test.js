// Панель выбора инструмента (этап 4, D-131): чистые функции фильтра
// и параметры резолвера. DOM-панель проверяется в браузере (замер этапа 4),
// здесь — логика, как у passportLine панели пула.

import { describe, expect, it } from 'vitest';

import { filterPresets, resolverQuery } from '../../src/timbre/picker-filter.js';
import { loadTimbreCatalog, timbreReport } from '../../server/samples/timbre.js';

const report = timbreReport(loadTimbreCatalog());
const presets = report.presets;

describe('карточка пресета в отчёте каталога', () => {
  it('каждый пресет несёт лицензию, превью, паспорт и атрибуцию', () => {
    expect(presets.length).toBeGreaterThanOrEqual(10);
    for (const preset of presets) {
      expect(preset.license).toBe('CC0-1.0');
      expect(preset.licenses).toEqual(['CC0-1.0']);
      expect(preset.preview).toMatch(/^\/timbre-audio\/tp_[a-z0-9_]+\/[\w.-]+\.ogg$/);
      expect(preset.descriptor).toBeTruthy();
      expect(Number.isFinite(preset.descriptor.spectral?.centroidHz)).toBe(true);
      expect(preset.attribution).toContain('CC0-1.0');
    }
  });

  it('превью — файл зоны, ближайшей к середине клавиатуры (детерминированно)', () => {
    const catalog = loadTimbreCatalog();
    for (const preset of presets) {
      const zones = catalog.zones.filter((zone) => zone.instrument_id === preset.id);
      const expected = zones.slice().sort(
        (x, y) => Math.abs(x.root_key - 60) - Math.abs(y.root_key - 60) || x.root_key - y.root_key,
      )[0];
      const asset = catalog.assets[expected.asset_id];
      expect(preset.preview).toBe(`/timbre-audio/${asset.file}`);
    }
  });
});

describe('фильтр каталога по метаданным', () => {
  it('семейство и роль — жёсткие фильтры', () => {
    const keys = filterPresets(presets, { family: 'keys' });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((preset) => preset.family === 'keys')).toBe(true);
    const chords = filterPresets(presets, { role: 'chords' });
    expect(chords.every((preset) => preset.roles.includes('chords'))).toBe(true);
  });

  it('басовый пресет не предлагается вместо пианино (роль chords)', () => {
    const chords = filterPresets(presets, { role: 'chords' });
    expect(chords.some((preset) => preset.family === 'bass')).toBe(false);
    expect(chords.length).toBeGreaterThan(0);
  });

  it('профиль совпадает с timbreProfile или тегом', () => {
    const warm = filterPresets(presets, { profile: 'warm' });
    expect(warm.length).toBeGreaterThan(0);
    for (const preset of warm) {
      expect(preset.timbreProfile === 'warm' || preset.tags.includes('warm')).toBe(true);
    }
  });

  it('текстовый поиск по имени и тегам, регистр не важен', () => {
    const found = filterPresets(presets, { query: 'VIOLIN' });
    expect(found.length).toBeGreaterThan(0);
    for (const preset of found) {
      const hay = `${preset.name} ${preset.tags.join(' ')} ${preset.family}`.toLowerCase();
      expect(hay).toContain('violin');
    }
    expect(filterPresets(presets, { query: 'несуществующий-запрос' })).toEqual([]);
  });

  it('порядок детерминирован — по id; пустой вход не падает', () => {
    const a = filterPresets(presets, {});
    const b = filterPresets(presets.slice().reverse(), {});
    expect(a.map((preset) => preset.id)).toEqual(b.map((preset) => preset.id));
    expect(filterPresets([], {})).toEqual([]);
    expect(filterPresets(null, {})).toEqual([]);
  });
});

describe('параметры запроса резолвера', () => {
  it('роль учитывается только с включённым фильтром', () => {
    expect(resolverQuery({ role: 'chords', profile: 'warm', style: 'lo-fi', useRole: true }))
      .toBe('role=chords&profile=warm&style=lo-fi&limit=5');
    expect(resolverQuery({ role: 'chords', profile: null, style: null, useRole: false }))
      .toBe('limit=5');
  });

  it('без фильтра роли запрос идёт по семейству (роли-инструменты экспансии)', () => {
    expect(resolverQuery({ role: 'piano', family: 'keys', profile: null, style: null, useRole: false }))
      .toBe('family=keys&limit=5');
    expect(resolverQuery({ role: 'piano', family: 'keys', profile: null, style: null, useRole: true }))
      .toBe('role=piano&limit=5');
  });
});