// Каталог Timbre Palette: asset-level права и ворота публикации (D-126).
//
// Проверяем то, что должно быть правдой всегда:
//   * ассет без полной записи прав ломает механику реестра;
//   * ассет не approved блокирует релиз, даже если механизм цел;
//   * approved невозможен с несвободной лицензией (fail-closed);
//   * alias пресета не конфликтует с банками и синтезаторами;
//   * атрибуция TASL готовится для экспорта, CC-BY помечается обязательной;
//   * реальный скелет каталога (источники VSCO2 CE / VCSL) полон.

import { describe, it, expect } from 'vitest';
import {
  loadTimbreCatalog,
  auditTimbre,
  attributionForAsset,
  attributionLinesForCode,
  presetsUsedInCode,
  timbreReport,
  ASSET_RIGHTS_FIELDS,
} from '../../server/samples/timbre.js';

const SOURCE = {
  name: 'Test Pack',
  source_url: 'https://example.org/pack',
  creator: 'Author',
  license: 'CC0-1.0',
  licenseId: 'cc0',
  license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  checked_at: '2026-11-17',
  commercial_use: true,
  redistribution: true,
  derivatives: true,
  ai_use: 'allowed',
  rights_status: 'approved',
};

function makeAsset(overrides = {}) {
  const base = {
    id: 'asset-1',
    name: 'Piano C4',
    source: 'test-pack',
    source_url: 'https://example.org/pack/c4.wav',
    creator: 'Author',
    license: 'CC0-1.0',
    licenseId: 'cc0',
    license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    checked_at: '2026-11-17',
    commercial_use: true,
    redistribution: true,
    derivatives: true,
    ai_use: 'allowed',
    attribution: '«Piano C4» by Author — CC0-1.0 — https://example.org/pack/c4.wav',
    rights_status: 'approved',
    rights_notes: null,
    sha256: 'a'.repeat(64),
    sha256_derived: null,
    duration_s: 2.5,
    sample_rate: 44100,
    channels: 2,
    root_midi: 60,
    tags: ['warm'],
    descriptor: null,
    file: 'test-pack/piano-c4.ogg',
  };
  return { ...base, ...overrides };
}

function makeCatalog({ asset = makeAsset(), preset = {}, zones } = {}) {
  return {
    sources: { 'test-pack': { ...SOURCE } },
    assets: { [asset.id]: asset },
    presets: {
      'tp-test-piano-v1': {
        name: 'Test Piano',
        family: 'keys',
        roles: ['chords', 'lead'],
        strudelAlias: 'tp_test_piano_v1',
        tags: ['warm'],
        version: '1',
        ...preset,
      },
    },
    zones: zones ?? [{
      instrument_id: 'tp-test-piano-v1',
      asset_id: asset.id,
      root_key: 60,
      key_low: 0,
      key_high: 127,
    }],
  };
}

describe('каталог Timbre: механизм реестра', () => {
  it('реальный скелет каталога цел и релиз не блокирует (пресетов пока нет)', () => {
    const catalog = loadTimbreCatalog();
    const audit = auditTimbre(catalog, { bankNames: ['bd', 'piano'] });
    expect(audit.ok).toBe(true);
    expect(audit.releaseBlocked).toBe(false);
    expect(catalog.sources['vsco2-ce'].rights_status).toBe('approved');
    expect(catalog.sources['vcsl'].rights_status).toBe('approved');
  });

  it('полный approved-каталог проходит механику и релиз', () => {
    const audit = auditTimbre(makeCatalog(), { bankNames: ['bd', 'sd', 'piano'] });
    expect(audit.issues).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.releaseBlocked).toBe(false);
    expect(audit.totals.approvedAssets).toBe(1);
  });

  it('ассет без источника — механизм красный', () => {
    const catalog = makeCatalog({ asset: makeAsset({ source: 'no-such-pack' }) });
    const audit = auditTimbre(catalog);
    expect(audit.ok).toBe(false);
    expect(audit.issues.some((i) => i.kind === 'asset-source-missing')).toBe(true);
  });

  it('ассет без обязательного поля прав — механизм красный', () => {
    for (const field of ASSET_RIGHTS_FIELDS) {
      const asset = makeAsset();
      delete asset[field];
      const audit = auditTimbre(makeCatalog({ asset }));
      expect(audit.ok, `поле ${field} должно быть обязательным`).toBe(false);
      expect(audit.issues.some((i) => i.kind === 'asset-incomplete')).toBe(true);
    }
  });

  it('approved с NC-лицензией невозможен (fail-closed)', () => {
    const catalog = makeCatalog({ asset: makeAsset({ licenseId: 'cc-by-nc', rights_status: 'approved' }) });
    const audit = auditTimbre(catalog);
    expect(audit.ok).toBe(false);
    expect(audit.issues.some((i) => i.kind === 'asset-license')).toBe(true);
  });

  it('неизвестный rights_status — механизм красный', () => {
    const catalog = makeCatalog({ asset: makeAsset({ rights_status: 'вроде бесплатно' }) });
    const audit = auditTimbre(catalog);
    expect(audit.ok).toBe(false);
    expect(audit.issues.some((i) => i.kind === 'asset-status')).toBe(true);
  });
});

describe('каталог Timbre: ворота релиза', () => {
  it('pending-ассет в пресете блокирует релиз, механизм цел', () => {
    const catalog = makeCatalog({ asset: makeAsset({ rights_status: 'pending' }) });
    const audit = auditTimbre(catalog);
    expect(audit.ok).toBe(true);
    expect(audit.releaseBlocked).toBe(true);
    expect(audit.unapprovedAssets).toEqual(['asset-1']);
  });

  it('rejected-ассет блокирует релиз', () => {
    const catalog = makeCatalog({ asset: makeAsset({ rights_status: 'rejected' }) });
    expect(auditTimbre(catalog).releaseBlocked).toBe(true);
  });

  it('ассет не из пресета релиз не блокирует (рабочий слой каталога)', () => {
    const catalog = makeCatalog({ asset: makeAsset({ rights_status: 'pending' }), zones: [] });
    // пресет без зон — механизм красный, но релиз блокируют только используемые ассеты
    const audit = auditTimbre(catalog);
    expect(audit.releaseBlocked).toBe(false);
  });
});

describe('каталог Timbre: неймспейс alias', () => {
  it('коллизия с именем банка — механизм красный', () => {
    const catalog = makeCatalog({ preset: { strudelAlias: 'tp_bd' } });
    const audit = auditTimbre(catalog, { bankNames: ['tp_bd'] });
    expect(audit.issues.some((i) => i.kind === 'alias-collision')).toBe(true);
  });

  it('коллизия с синтезатором — механизм красный', () => {
    const catalog = makeCatalog({ preset: { strudelAlias: 'tp_sine' } });
    const audit = auditTimbre(catalog, { synthNames: ['tp_sine'] });
    expect(audit.issues.some((i) => i.kind === 'alias-collision')).toBe(true);
  });

  it('alias вне неймспейса tp_ — механизм красный', () => {
    const catalog = makeCatalog({ preset: { strudelAlias: 'felt_piano' } });
    const audit = auditTimbre(catalog);
    expect(audit.issues.some((i) => i.kind === 'alias-namespace')).toBe(true);
  });

  it('два пресета с одним alias — механизм красный', () => {
    const catalog = makeCatalog();
    catalog.presets['tp-test-piano-v2'] = { ...catalog.presets['tp-test-piano-v1'], name: 'Copy' };
    catalog.zones.push({ instrument_id: 'tp-test-piano-v2', asset_id: 'asset-1', root_key: 60 });
    const audit = auditTimbre(catalog);
    expect(audit.issues.some((i) => i.kind === 'alias-duplicate')).toBe(true);
  });

  it('зона на несуществующий пресет/ассет — механизм красный', () => {
    const catalog = makeCatalog({
      zones: [{ instrument_id: 'ghost', asset_id: 'asset-1', root_key: 60 }],
    });
    const audit = auditTimbre(catalog);
    expect(audit.issues.some((i) => i.kind === 'zone-dangling')).toBe(true);
  });

  it('пресет без зон — механизм красный (пресет молчит)', () => {
    const audit = auditTimbre(makeCatalog({ zones: [] }));
    expect(audit.issues.some((i) => i.kind === 'preset-silent')).toBe(true);
  });
});

describe('каталог Timbre: атрибуция TASL', () => {
  it('CC-BY: название, автор, лицензия, источник + Changes', () => {
    const asset = makeAsset({
      name: 'Rhodes C3',
      creator: 'Jane',
      license: 'CC BY 4.0',
      licenseId: 'cc-by',
      source_url: 'https://example.org/s/123',
    });
    const line = attributionForAsset(asset, { changes: 'Converted to OGG, trimmed technical silence' });
    expect(line).toContain('«Rhodes C3» by Jane');
    expect(line).toContain('CC BY 4.0');
    expect(line).toContain('https://example.org/s/123');
    expect(line).toContain('Changes: Converted to OGG');
  });

  it('CC0: происхождение сохраняется, кредит необязателен', () => {
    const line = attributionForAsset(makeAsset());
    expect(line).toContain('CC0-1.0');
    expect(line).toContain('https://example.org/pack/c4.wav');
  });

  it('экспорт видит только пресеты, которые звучат в коде', () => {
    const catalog = makeCatalog();
    const code = 'note("c3 e3").s("tp_test_piano_v1").room(0.2)';
    expect(presetsUsedInCode(code, catalog).map((p) => p.id)).toEqual(['tp-test-piano-v1']);
    expect(presetsUsedInCode('s("bd")', catalog)).toEqual([]);
    const lines = attributionLinesForCode(code, catalog);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('происхождение (CC0)');
  });

  it('CC-BY в экспорте помечается обязательной атрибуцией', () => {
    const catalog = makeCatalog({ asset: makeAsset({ licenseId: 'cc-by', license: 'CC BY 4.0' }) });
    const lines = attributionLinesForCode('.s("tp_test_piano_v1")', catalog);
    expect(lines[0]).toContain('обязательная атрибуция');
  });

  it('отчёт каталога отдаёт публичные метаданные пресетов', () => {
    const report = timbreReport(makeCatalog());
    expect(report.ok).toBe(true);
    expect(report.presets[0].strudelAlias).toBe('tp_test_piano_v1');
    expect(report.presets[0].roles).toEqual(['chords', 'lead']);
  });
});