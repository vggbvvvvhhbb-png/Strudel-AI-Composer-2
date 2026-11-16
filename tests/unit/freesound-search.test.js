// Поиск сэмплов в Freesound (D-114).
//
// Проверяем то, что важно по деньгам и по лицензиям: несвободное не
// проходит, ключ не течёт, ограничения соблюдаются, без ключа инструмент
// деградирует, а не падает.

import { afterEach, describe, expect, it } from 'vitest';

import {
  freesoundSearch,
  freesoundStatus,
  canonicalLicense,
  isAllowedLicense,
  checkFreesoundUrl,
  freesoundBudgetState,
  searchCacheKey,
  resetFreesoundState,
  ALLOWED_HOSTS,
} from '../../server/agent/freesound.js';
import { runTool, toolById, toolManifest } from '../../server/agent/tools.js';
import { MODES } from '../../server/agent/modes.js';
import { heuristicPlan } from '../../server/agent/navigator.js';
import { detectMode } from '../../server/agent/loop.js';

const KEY = 'test-freesound-token';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function makeFetch(payload, { status = 200, onCall } = {}) {
  return async (url, options) => {
    onCall?.(url, options);
    return jsonResponse(payload, status);
  };
}

const CC0 = 'Creative Commons 0';
const BY = 'Attribution';

afterEach(() => {
  resetFreesoundState();
});

describe('freesound: лицензии', () => {
  it('узнаёт канонические названия лицензий', () => {
    expect(canonicalLicense(CC0)).toBe('cc0');
    expect(canonicalLicense(BY)).toBe('cc-by');
  });

  it('узнаёт лицензию по URL-форме', () => {
    expect(canonicalLicense('https://creativecommons.org/publicdomain/zero/1.0/')).toBe('cc0');
    expect(canonicalLicense('http://creativecommons.org/licenses/by/4.0/')).toBe('cc-by');
  });

  it('неизвестная лицензия не разрешена (fail-closed)', () => {
    expect(isAllowedLicense('Attribution Noncommercial')).toBe(false);
    expect(isAllowedLicense('Creative Commons 0 Noncommercial')).toBe(false);
    expect(isAllowedLicense('')).toBe(false);
    expect(isAllowedLicense(null)).toBe(false);
  });
});

describe('freesound: адреса', () => {
  it('разрешены только хосты Freesound', () => {
    expect(checkFreesoundUrl('https://cdn.freesound.org/previews/x.mp3').ok).toBe(true);
    expect(checkFreesoundUrl('https://evil.example.com/x.mp3').ok).toBe(false);
  });

  it('http и локальные адреса закрыты', () => {
    expect(checkFreesoundUrl('http://freesound.org/x').ok).toBe(false);
    expect(checkFreesoundUrl('https://localhost/x').ok).toBe(false);
    expect(checkFreesoundUrl('не адрес').ok).toBe(false);
  });

  it('список разрешённых хостов конечен и известен', () => {
    expect(ALLOWED_HOSTS).toContain('freesound.org');
    expect(ALLOWED_HOSTS).not.toContain('example.com');
  });
});

describe('freesound: поиск', () => {
  it('без ключа честно деградирует и не падает', async () => {
    const result = await freesoundSearch({ query: 'glass hit' }, { env: {} });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('FREESOUND_API_KEY');
  });

  it('статус службы не раскрывает значение ключа', () => {
    const status = freesoundStatus({ FREESOUND_API_KEY: KEY });
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it('отбирает только разрешённые лицензии', async () => {
    const fetchImpl = makeFetch({
      results: [
        { id: 1, name: 'free hit', license: CC0, duration: 1.2, previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/a.mp3' } },
        { id: 2, name: 'by hit', license: BY, duration: 2, previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/b.mp3' } },
        { id: 3, name: 'nc hit', license: 'Attribution Noncommercial', duration: 3 },
        { id: 4, name: 'unknown', duration: 4 },
      ],
    });
    const result = await freesoundSearch(
      { query: 'hit', license: 'cc0', numResults: 10 },
      { env: { FREESOUND_API_KEY: KEY }, fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.results.map((item) => item.id)).toEqual([1, 2]);
    expect(result.filteredOut).toBe(2);
  });

  it('превью с чужого хоста отбрасывается', async () => {
    const fetchImpl = makeFetch({
      results: [
        { id: 5, name: 'bad host', license: CC0, previews: { 'preview-hq-mp3': 'https://evil.example.com/x.mp3' } },
      ],
    });
    const result = await freesoundSearch(
      { query: 'hit' },
      { env: { FREESOUND_API_KEY: KEY }, fetchImpl },
    );
    expect(result.results).toHaveLength(0);
    expect(result.filteredOut).toBe(1);
  });

  it('фильтр лицензии уходит в запрос к сервису', async () => {
    let seen = null;
    const fetchImpl = makeFetch({ results: [] }, { onCall: (url) => { seen = url; } });
    await freesoundSearch(
      { query: 'glass', license: 'cc0', durationMax: 12 },
      { env: { FREESOUND_API_KEY: KEY }, fetchImpl },
    );
    const decoded = decodeURIComponent(String(seen).replace(/\+/g, ' '));
    expect(decoded).toContain('license:"Creative Commons 0"');
    expect(decoded).toContain('duration:[0 TO 12]');
  });

  it('ключ уходит в заголовок, а не в адрес', async () => {
    let seen = null;
    let headers = null;
    const fetchImpl = makeFetch({ results: [] }, { onCall: (url, options) => { seen = url; headers = options.headers; } });
    await freesoundSearch({ query: 'glass' }, { env: { FREESOUND_API_KEY: KEY }, fetchImpl });
    expect(seen).not.toContain(KEY);
    expect(headers.Authorization).toBe(`Token ${KEY}`);
  });

  it('повторный запрос берётся из кэша', async () => {
    let calls = 0;
    const fetchImpl = makeFetch({ results: [] }, { onCall: () => { calls += 1; } });
    const env = { FREESOUND_API_KEY: KEY };
    await freesoundSearch({ query: 'glass' }, { env, fetchImpl });
    const second = await freesoundSearch({ query: 'glass' }, { env, fetchImpl });
    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
  });

  it('ключ кэша зависит от лицензии и длительности', () => {
    const a = searchCacheKey({ query: 'x', license: 'cc0', durationMax: 30, sort: 'relevance' });
    const b = searchCacheKey({ query: 'x', license: 'by', durationMax: 30, sort: 'relevance' });
    const c = searchCacheKey({ query: 'x', license: 'cc0', durationMax: 10, sort: 'relevance' });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('лимит запросов за ночь останавливает поиск', async () => {
    const result = await freesoundSearch(
      { query: 'glass' },
      {
        env: { FREESOUND_API_KEY: KEY },
        budgetState: () => ({ exhausted: true, reason: 'лимит исчерпан', used: 300, limit: 300 }),
        fetchImpl: makeFetch({ results: [] }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('лимит');
  });

  it('состояние ночного бюджета доступно и честно', () => {
    const state = freesoundBudgetState();
    expect(state).toHaveProperty('limit');
    expect(state).toHaveProperty('used');
    expect(typeof state.exhausted).toBe('boolean');
  });

  it('ошибка провайдера не выдаёт ключ', async () => {
    const fetchImpl = async () => {
      throw new Error(`connection failed for ${KEY}`);
    };
    const result = await freesoundSearch({ query: 'glass' }, { env: { FREESOUND_API_KEY: KEY }, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain(KEY);
  });
});

describe('freesound: тулз агента', () => {
  it('тулз зарегистрирован и описан', () => {
    const tool = toolById('freesound_search');
    expect(tool).toBeTruthy();
    const manifest = toolManifest().find((item) => item.id === 'freesound_search');
    expect(manifest.description).toContain('Freesound');
  });

  it('неверные аргументы отклоняются с понятным текстом', async () => {
    const result = await runTool('freesound_search', { query: '' }, { env: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('неверные аргументы');
  });

  it('лицензия вне белого списка не проходит', async () => {
    const result = await runTool('freesound_search', { query: 'hit', license: 'nc' }, { env: {} });
    expect(result.ok).toBe(false);
  });

  it('режим «охотник» есть и включает поиск сэмплов', () => {
    expect(MODES.hunter).toBeTruthy();
    expect(MODES.hunter.tools).toContain('freesound_search');
  });

  it('запрос про редкий звук попадает в режим охотника', () => {
    expect(detectMode('найди редкий стеклянный звук и сделай бит')).toBe('hunter');
    const plan = heuristicPlan('найди редкий стеклянный удар и сделай из него бит');
    expect(plan.mode).toBe('hunter');
    expect(plan.steps.map((step) => step.tool)).toContain('freesound_search');
  });
});
