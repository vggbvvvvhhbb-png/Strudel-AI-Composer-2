// Timbre Resolver v1 (D-128): каскад фильтров и детерминированный скор.
//
// Главное: «басовый one-shot вместо пианино» невозможен — роль и диапазон
// это жёсткие фильтры; неapproved не предлагается; скор воспроизводим.

import { describe, it, expect } from 'vitest';

import { resolveTimbre } from '../../server/samples/timbre-resolver.js';
import { loadTimbreCatalog } from '../../server/samples/timbre.js';

const catalog = loadTimbreCatalog();

describe('resolveTimbre: жёсткие фильтры', () => {
  it('роль keys не предлагает басовые пресеты', () => {
    const candidates = resolveTimbre({ role: 'chords', range: [48, 72], profile: 'warm' }, catalog);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.roles).toContain('chords');
      expect(candidate.family).not.toBe('bass');
    }
  });

  it('басовый one-shot не предлагается вместо пианино (диапазон + роль)', () => {
    const candidates = resolveTimbre({ role: 'chords', range: [60, 72] }, catalog);
    const ids = candidates.map((candidate) => candidate.id);
    expect(ids).not.toContain('tp-contrabass-pizz-v1');
    expect(ids).not.toContain('tp-contrabass-sus-v1');
    expect(ids).toContain('tp-upright-soft-v1');
  });

  it('роль bass предлагает контрабас и виолончели, но не пианино', () => {
    const candidates = resolveTimbre({ role: 'bass', range: [24, 40] }, catalog);
    const ids = candidates.map((candidate) => candidate.id);
    expect(ids).toContain('tp-contrabass-pizz-v1');
    expect(ids).not.toContain('tp-upright-piano-v1');
  });

  it('диапазон вне покрытия пресета отсекает его', () => {
    // скрипка покрывает ~55..74; запрос 20..30 не должен её предложить
    const candidates = resolveTimbre({ role: 'lead', range: [20, 30] }, catalog);
    const ids = candidates.map((candidate) => candidate.id);
    expect(ids).not.toContain('tp-solo-violin-v1');
  });

  it('неapproved ассеты исключают пресет из кандидатов (fail-closed)', () => {
    const mutated = JSON.parse(JSON.stringify(catalog));
    const zone = mutated.zones.find((z) => z.instrument_id === 'tp-upright-soft-v1');
    mutated.assets[zone.asset_id].rights_status = 'pending';
    const candidates = resolveTimbre({ role: 'chords', range: [48, 72] }, mutated);
    expect(candidates.map((candidate) => candidate.id)).not.toContain('tp-upright-soft-v1');
  });

  it('несуществующая роль — честный пустой список', () => {
    expect(resolveTimbre({ role: 'kazoo_solo' }, catalog)).toEqual([]);
  });
});

describe('resolveTimbre: ранжирование и обоснование', () => {
  it('для «warm» мягкое пианино выше яркого', () => {
    const candidates = resolveTimbre({ role: 'chords', range: [48, 72], profile: 'warm', style: 'lo-fi' }, catalog);
    const soft = candidates.find((candidate) => candidate.id === 'tp-upright-soft-v1');
    const bright = candidates.find((candidate) => candidate.id === 'tp-upright-piano-v1');
    expect(soft).toBeTruthy();
    expect(bright).toBeTruthy();
    expect(soft.score).toBeGreaterThan(bright.score);
    expect(candidates[0].id).toBe('tp-upright-soft-v1');
  });

  it('кандидаты несут обоснование с числами', () => {
    const candidates = resolveTimbre({ role: 'chords', range: [48, 72], profile: 'warm' }, catalog);
    for (const candidate of candidates) {
      expect(candidate.reasons.length).toBeGreaterThan(0);
      expect(candidate.reasons.join(' ')).toMatch(/диапазон|роль/);
    }
    const withCentroid = candidates.find((candidate) => candidate.descriptor?.centroidHz !== null);
    expect(withCentroid.reasons.join(' ')).toMatch(/центроид \d+ Гц/);
  });

  it('скор детерминирован: два вызова дают идентичный результат', () => {
    const query = { role: 'lead', range: [55, 72], profile: 'bright', style: 'cinematic' };
    expect(resolveTimbre(query, catalog)).toEqual(resolveTimbre(query, catalog));
  });

  it('limit ограничивает выдачу 3–5 кандидатами', () => {
    const candidates = resolveTimbre({ role: 'pad', limit: 3 }, catalog);
    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(candidates.length).toBeGreaterThan(0);
  });
});