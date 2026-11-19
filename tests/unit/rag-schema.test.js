// Фаза B: схема записи базы знаний (D-135). Невалидная запись не может
// попасть в базу; ошибки структурные (путь + текст) — годятся для фидбека модели.

import { describe, it, expect } from 'vitest';
import { validateEntry, validatePresetRefs, TONICS, MODES } from '../../server/rag/schema.js';
import { loadTimbreCatalog } from '../../server/samples/timbre.js';

const validEntry = {
  id: 'kb-test-minor-chords-001',
  version: 1,
  title: 'Тёплые минорные аккорды пианино',
  description: 'Минорная тоника с добавленной шестой ступенью в мягком пианино: устойчивая, но не мрачная краска для lofi.',
  strudel_code: '$CHORDS: n("<0 2 4 6> ~").scale("c:minor").s("piano").room(0.3)',
  music_tags: {
    genre: ['lofi'],
    tonic: 'c',
    mode: 'minor',
    roles: ['chords'],
    complexity: 'basic',
    bpm: 80,
  },
  cc0_preset_ids: ['tp-upright-soft-v1'],
  rationale: 'Шестая ступень (add6) смягчает минорное трезвучие: нет полутонового трения с квинтой, краска остаётся устойчивой.',
  source: { origin: 'own', license: 'CC0-1.0' },
};

describe('схема записи знания', () => {
  it('валидная запись проходит', () => {
    const r = validateEntry(validEntry);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('пустой description не проходит (эмбеддить нечего)', () => {
    const r = validateEntry({ ...validEntry, description: 'коротко' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'description')).toBe(true);
  });

  it('неизвестная тоника и лад отклоняются', () => {
    const r = validateEntry({
      ...validEntry,
      music_tags: { ...validEntry.music_tags, tonic: 'h', mode: 'locrian' },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'music_tags.tonic')).toBe(true);
    expect(TONICS).toHaveLength(12);
    expect(MODES).toContain('dorian');
  });

  it('bpm: null допустим (темп не применим), 0 — нет («нет данных» ≠ 0)', () => {
    expect(validateEntry({ ...validEntry, music_tags: { ...validEntry.music_tags, bpm: null } }).ok).toBe(true);
    expect(validateEntry({ ...validEntry, music_tags: { ...validEntry.music_tags, bpm: 0 } }).ok).toBe(false);
    expect(validateEntry({ ...validEntry, music_tags: { ...validEntry.music_tags, bpm: 300 } }).ok).toBe(false);
  });

  it('роли только из канонических 12', () => {
    const r = validateEntry({ ...validEntry, music_tags: { ...validEntry.music_tags, roles: ['violin_1'] } });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.startsWith('music_tags.roles'))).toBe(true);
  });

  it('external без reference не проходит (происхождение обязательно)', () => {
    const r = validateEntry({ ...validEntry, source: { origin: 'external', license: 'CC-BY-4.0' } });
    expect(r.ok).toBe(false);
    const ok = validateEntry({
      ...validEntry,
      source: { origin: 'external', license: 'CC-BY-4.0', reference: 'https://example.org/pattern' },
    });
    expect(ok.ok).toBe(true);
  });

  it('id не kebab-case и выдуманный формат пресета отклоняются', () => {
    expect(validateEntry({ ...validEntry, id: 'KB Test 001' }).ok).toBe(false);
    expect(validateEntry({ ...validEntry, cc0_preset_ids: ['cc0_rhodes_warm'] }).ok).toBe(false);
  });

  it('cc0_preset_ids по умолчанию пустой массив (синт-сниппет без пресетов)', () => {
    const { cc0_preset_ids, ...rest } = validEntry;
    const r = validateEntry(rest);
    expect(r.ok).toBe(true);
    expect(r.value.cc0_preset_ids).toEqual([]);
  });
});

describe('сверка пресетов с каталогом', () => {
  const fakeCatalog = {
    presets: { 'tp-good-v1': { id: 'tp-good-v1' }, 'tp-bad-v1': { id: 'tp-bad-v1' } },
    assets: {
      'a-ok': { id: 'a-ok', license: 'CC0-1.0', rights_status: 'approved' },
      'a-pending': { id: 'a-pending', license: 'CC0-1.0', rights_status: 'pending' },
    },
    zones: [
      { instrument_id: 'tp-good-v1', asset_id: 'a-ok' },
      { instrument_id: 'tp-bad-v1', asset_id: 'a-pending' },
    ],
  };

  it('существующий CC0-пресет проходит', () => {
    expect(validatePresetRefs({ cc0_preset_ids: ['tp-good-v1'] }, fakeCatalog).ok).toBe(true);
  });

  it('несуществующий пресет — структурная ошибка', () => {
    const r = validatePresetRefs({ cc0_preset_ids: ['tp-ghost-v1'] }, fakeCatalog);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('tp-ghost-v1');
  });

  it('неapproved ассет пресета — ошибка (fail-closed)', () => {
    const r = validatePresetRefs({ cc0_preset_ids: ['tp-bad-v1'] }, fakeCatalog);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('не CC0/approved');
  });

  it('все 10 реальных пресетов каталога проходят сверку', () => {
    const catalog = loadTimbreCatalog();
    const ids = Object.keys(catalog.presets);
    expect(ids.length).toBe(10);
    const r = validatePresetRefs({ cc0_preset_ids: ids }, catalog);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});