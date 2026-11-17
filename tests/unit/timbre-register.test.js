// Регистрация и прогрев пресетов в браузере (D-128): чистые хелперы +
// ensureTimbreForCode на мок-адаптере. Отказ прогрева — ошибка, не тихий
// синтезатор; прогрев только звучащих пресетов, не всей коллекции.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { timbreAliasesInCode, timbreUrlsForAlias } from '../../src/timbre/register.js';

const catalog = {
  presets: [
    { id: 'tp-upright-piano-v1', strudelAlias: 'tp_upright_piano_v1' },
    { id: 'tp-cello-section-v1', strudelAlias: 'tp_cello_section_v1' },
  ],
  sampleMap: {
    _base: '/timbre-audio/',
    tp_upright_piano_v1: { 'c#3': 'tp_upright_piano_v1/cs3.ogg', c4: 'tp_upright_piano_v1/c4.ogg' },
    tp_cello_section_v1: { c2: 'tp_cello_section_v1/c2.ogg' },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('timbreAliasesInCode', () => {
  it('находит только alias в кавычках, сортирует', () => {
    const code = `$PIANO_1: s("tp_cello_section_v1").note("c2")\n// tp_upright_piano_v1 в комментарии\ns('tp_upright_piano_v1')`;
    expect(timbreAliasesInCode(code, catalog)).toEqual(['tp_cello_section_v1', 'tp_upright_piano_v1']);
  });

  it('не путает похожие имена и не ловит без кавычек', () => {
    expect(timbreAliasesInCode('s(tp_upright_piano_v1)', catalog)).toEqual([]);
    expect(timbreAliasesInCode('s("tp_upright_piano_v10")', catalog)).toEqual([]);
    expect(timbreAliasesInCode('', catalog)).toEqual([]);
    expect(timbreAliasesInCode('s("tp_upright_piano_v1")', null)).toEqual([]);
  });
});

describe('timbreUrlsForAlias', () => {
  it('разворачивает карту в URL с базой', () => {
    expect(timbreUrlsForAlias('tp_upright_piano_v1', catalog)).toEqual([
      '/timbre-audio/tp_upright_piano_v1/cs3.ogg',
      '/timbre-audio/tp_upright_piano_v1/c4.ogg',
    ]);
  });

  it('абсолютные URL не трогаются, неизвестный alias — пустой список', () => {
    const abs = { sampleMap: { tp_x_v1: { c4: 'https://cdn.example/x.ogg' } } };
    expect(timbreUrlsForAlias('tp_x_v1', abs)).toEqual(['https://cdn.example/x.ogg']);
    expect(timbreUrlsForAlias('tp_ghost_v1', catalog)).toEqual([]);
  });
});

describe('ensureTimbreForCode', () => {
  async function freshModule() {
    vi.resetModules();
    return import('../../src/timbre/register.js');
  }

  function stubCatalog() {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => catalog })));
  }

  it('код без пресетов — ничего не грузит', async () => {
    stubCatalog();
    const { ensureTimbreForCode } = await freshModule();
    const adapter = { loadSamples: vi.fn(), warmSamples: vi.fn() };
    const result = await ensureTimbreForCode('s("bd")', adapter);
    expect(result).toEqual({ ok: true, used: [], warmed: 0, errors: [] });
    expect(adapter.loadSamples).not.toHaveBeenCalled();
    expect(adapter.warmSamples).not.toHaveBeenCalled();
  });

  it('регистрирует карту и прогревает только звучащий пресет', async () => {
    stubCatalog();
    const { ensureTimbreForCode } = await freshModule();
    const adapter = {
      loadSamples: vi.fn(async () => ({ ok: true, total: 1, failed: 0, errors: [] })),
      warmSamples: vi.fn(async (urls) => ({ ok: true, total: urls.length, failed: 0, errors: [] })),
    };
    const result = await ensureTimbreForCode('s("tp_upright_piano_v1")', adapter);
    expect(result.ok).toBe(true);
    expect(result.used).toEqual(['tp_upright_piano_v1']);
    expect(result.warmed).toBe(2);
    expect(adapter.warmSamples).toHaveBeenCalledWith([
      '/timbre-audio/tp_upright_piano_v1/cs3.ogg',
      '/timbre-audio/tp_upright_piano_v1/c4.ogg',
    ]);
    // Второй вызов с той же картой — повторная регистрация не нужна.
    await ensureTimbreForCode('s("tp_upright_piano_v1")', adapter);
    expect(adapter.loadSamples).toHaveBeenCalledTimes(1);
  });

  it('отказ прогрева — ошибка, не тихая подмена', async () => {
    stubCatalog();
    const { ensureTimbreForCode } = await freshModule();
    const adapter = {
      loadSamples: vi.fn(async () => ({ ok: true, total: 1, failed: 0, errors: [] })),
      warmSamples: vi.fn(async (urls) => ({ ok: false, total: urls.length, failed: urls.length, errors: ['HTTP 404'] })),
    };
    const result = await ensureTimbreForCode('s("tp_upright_piano_v1")', adapter);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('HTTP 404');
  });

  it('недоступный каталог — честная ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
    const { ensureTimbreForCode } = await freshModule();
    const adapter = { loadSamples: vi.fn(), warmSamples: vi.fn() };
    await expect(ensureTimbreForCode('s("tp_upright_piano_v1")', adapter)).rejects.toThrow('HTTP 503');
  });
});