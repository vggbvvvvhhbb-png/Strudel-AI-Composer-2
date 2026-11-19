// Локальные жанровые гайды и bounded compose: без сети и платной модели.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataset } from '../../server/rag/dataset.js';
import { detectGenre, retrieveGenreGuide, guideBlock, checkGenreRules } from '../../server/rag/genre-guide.js';
import * as searchCore from '../../server/rag/search-core.js';
import * as samplePlan from '../../server/music/compose/sample-plan.js';
import { buildTrack, normalizeSpec, repairSpec } from '../../server/music/compose/pipeline.js';

const entries = loadDataset().entries;
const techno = retrieveGenreGuide('techno').guide;

function goodSpec(bpm = 132) {
  return {
    meta: { style: 'techno', bpm, key: 'Cmin' },
    structure: { sections: [
      { name: 'intro', cycles: 8, energy: 0.3, harmony: 'Cm Fm Gm Cm' },
      { name: 'drop', cycles: 8, energy: 0.9, harmony: 'Fm Cm Ab Gm' },
    ] },
    parts: { roles: {
      P001: { role: 'kick', activeIn: ['drop'], pattern: 'bd*4', sound: 'bd' },
      P002: { role: 'snare', activeIn: ['drop'], pattern: '~ sd ~ sd', sound: 'sd' },
      P003: { role: 'hats', activeIn: ['intro', 'drop'], pattern: 'hh*8', sound: 'hh' },
      P004: { role: 'bass', activeIn: ['drop'], pattern: '0 ~ 2 4', sound: 'sawtooth' },
      P005: { role: 'chords', activeIn: ['intro', 'drop'], pattern: '0 ~ 2 ~', sound: 'triangle' },
      P006: { role: 'lead', activeIn: ['drop'], pattern: '7 ~ 4 ~', sound: 'sine' },
      P007: { role: 'pad', activeIn: ['intro', 'drop'], pattern: '0 ~ 4 ~', sound: 'sine' },
      P008: { role: 'arp', activeIn: ['drop'], pattern: '0 2 4 6', sound: 'triangle' },
    } },
  };
}

function collector() {
  const events = [];
  return { events, onEvent: (event, payload) => events.push({ event, ...payload }) };
}

beforeEach(() => vi.restoreAllMocks());

describe('guide aliases: явный жанр без эвристического стиля', () => {
  it.each([
    ['warm LOFI beat', 'lofi'],
    ['мягкий лоу-фай', 'lofi'],
    ['boom bap groove', 'lofi'],
    ['жёсткий техно', 'techno'],
    ['deep house!', 'house'],
    ['сделай хаус', 'house'],
    ['drift phonk, not funk', 'phonk'],
    ['фонк и фанк', 'phonk'],
    ['funk then phonk', 'funk'],
    ['драм-н-бейс', 'dnb'],
    ['drum and bass', 'dnb'],
    ['DRUM & BASS', 'dnb'],
    ['dnb/jungle', 'dnb'],
    ['neo-soul', 'neo-soul'],
    ['нео-соул', 'neo-soul'],
    ['(jazz), bebop', 'jazz'],
    ['ретровейв', 'synthwave'],
    ['камерная классика', 'classical'],
    ['drone', 'ambient'],
    ['трэп', 'trap'],
  ])('%s → %s', (prompt, genre) => {
    expect(detectGenre(prompt)).toBe(genre);
    expect(retrieveGenreGuide(prompt).guide?.genre).toBe(genre);
  });

  it.each([
    'neo\u00a0soul', 'neo\u2011soul', 'neo\u2212soul', 'neo \u2014 soul',
    'neo\u2003\t soul',
  ])('нормализует Unicode: %s', (prompt) => {
    expect(detectGenre(prompt)).toBe('neo-soul');
  });

  it('нормализует Unicode в многословном dnb', () => {
    expect(detectGenre('drum\u2009and\u00a0bass')).toBe('dnb');
    expect(detectGenre('drum\u2011and\u2011bass')).toBe('dnb');
  });

  it.each(['greenhouse', 'фанклуб', 'house2', '2house', 'my_house', 'lofiction', 'postjazz', 'house\u0301'])('не находит алиас внутри слова %s', (prompt) => {
    expect(detectGenre(prompt)).toBeNull();
    expect(retrieveGenreGuide(prompt).guide).toBeNull();
  });

  it('первое упоминание побеждает порядок датасета и явный style', () => {
    expect(detectGenre('house then techno', 'ambient')).toBe('house');
    expect(detectGenre('techno then house')).toBe('techno');
    expect(detectGenre('neo soul and lofi')).toBe('neo-soul');
  });

  it('при одной позиции побеждает длинный алиас', () => {
    const base = entries.find((entry) => entry.education?.guide?.genre === 'house');
    const short = structuredClone(base);
    short.education.guide.genre = 'short';
    short.education.guide.aliases = ['deep'];
    expect(detectGenre('deep house', null, [short, base])).toBe('house');
  });

  it('без упоминания использует только явно переданный известный alias style', () => {
    expect(detectGenre('сделай бит', 'lo-fi')).toBe('lofi');
    expect(detectGenre('сделай бит', 'drum and bass')).toBe('dnb');
    expect(detectGenre('сделай бит', 'нео-соул')).toBe('neo-soul');
  });

  it.each([undefined, '', 'unknown', 'dubstep', 'rock'])('без жанра и известного style %s не навязывает гайд', (style) => {
    expect(detectGenre('что-то спокойное и уютное', style)).toBeNull();
    expect(retrieveGenreGuide('что-то спокойное и уютное', { style }).guide).toBeNull();
  });
});

describe('actual local RAG retrieval', () => {
  it('hybridSearch получает только выбранные гайды и не получает embedding', () => {
    const search = vi.spyOn(searchCore, 'hybridSearch');
    const result = retrieveGenreGuide('драм-н-бейс', { entries });
    expect(search).toHaveBeenCalledOnce();
    const [candidates, options] = search.mock.calls[0];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((entry) => entry.education?.guide?.genre === 'dnb')).toBe(true);
    expect(options).toMatchObject({ queryEmbedding: null, topK: 1, minResults: 1 });
    expect(result).toMatchObject({ mode: 'lexical', semantic: false, degraded: true, stage: 'exact' });
    expect(result.reason).toContain('лексическое');
    expect(result.guide.id).toBe('edu-guide-dnb');
  });

  it('ранжирует несколько гайдов жанра, не выбирает первый id вручную', () => {
    const base = entries.find((entry) => entry.id === 'edu-guide-techno');
    const a = structuredClone(base);
    const b = structuredClone(base);
    a.id = 'a-guide';
    b.id = 'z-guide';
    b.title = 'Techno crystalline signature';
    const result = retrieveGenreGuide('techno crystalline signature', { entries: [a, b] });
    expect(result.guide.id).toBe('z-guide');
    expect(result.score).toBeGreaterThan(0);
  });

  it('извлечение не меняет датасет и не отдаёт ссылки на его массивы', () => {
    const before = structuredClone(entries);
    const result = retrieveGenreGuide('techno', { entries });
    result.guide.rules.push('локальная правка');
    result.guide.bpm_range[0] = 1;
    result.guide.aliases.push('test');
    expect(entries).toEqual(before);
    expect(retrieveGenreGuide('techno', { entries }).guide.bpm_range).toEqual([120, 150]);
  });
});

describe('checkGenreRules: BPM и реальные атрибуты role', () => {
  it.each([120, 132, 150])('принимает BPM %s, включая границы', (bpm) => {
    expect(checkGenreRules(goodSpec(bpm), techno)).toEqual({ ok: true, errors: [] });
  });

  it.each([119, 151, null, undefined, NaN, Infinity, -Infinity, '132'])('отвергает BPM %s на границе валидатора', (bpm) => {
    const spec = goodSpec();
    spec.meta.bpm = bpm;
    const result = checkGenreRules(spec, techno);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'bpm_range', path: 'meta.bpm', expected: [120, 150] });
  });

  it('отсутствующий meta — BPM нет данных, а не подставленные 120', () => {
    const spec = goodSpec();
    delete spec.meta;
    expect(checkGenreRules(spec, techno).errors[0]).toMatchObject({ path: 'meta.bpm', actual: null });
  });

  it('роль берётся из атрибута, не из идентификатора партии', () => {
    const spec = goodSpec();
    spec.parts.roles = {
      kick: { role: 'pad' }, hats: { role: 'pad' }, bass: { role: 'pad' },
    };
    const result = checkGenreRules(spec, techno);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.expected)).toEqual(['kick', 'hats', 'bass']);
  });

  it('произвольные id и дубликаты ролей не мешают проверке', () => {
    const spec = goodSpec();
    spec.parts.roles.VIOLIN_1 = { ...spec.parts.roles.P004 };
    expect(checkGenreRules(spec, techno).ok).toBe(true);
  });

  it('возвращает структурированную ошибку каждой отсутствующей роли', () => {
    const spec = goodSpec();
    delete spec.parts.roles.P004;
    expect(checkGenreRules(spec, techno)).toMatchObject({
      ok: false, errors: [{ code: 'required_role', path: 'parts.roles', expected: 'bass' }],
    });
  });

  it('без гайда ничего не ограничивает даже на пустом входе', () => {
    expect(checkGenreRules(null, null)).toEqual({ ok: true, errors: [] });
    expect(checkGenreRules(goodSpec(180), undefined)).toEqual({ ok: true, errors: [] });
    expect(guideBlock(null)).toBe('');
  });

  it('не мутирует спеку и гайд', () => {
    const spec = goodSpec(151);
    const beforeSpec = structuredClone(spec);
    const beforeGuide = structuredClone(techno);
    checkGenreRules(spec, techno);
    guideBlock(techno);
    expect(spec).toEqual(beforeSpec);
    expect(techno).toEqual(beforeGuide);
  });

  it('не выдаёт рекомендации по аккордам/ритму/форме за численный гейт', () => {
    const spec = goodSpec();
    spec.structure.sections = [];
    for (const part of Object.values(spec.parts.roles)) part.pattern = 'arbitrary';
    expect(checkGenreRules(spec, techno).ok).toBe(true);
    expect(guideBlock(techno)).toContain('рекомендации, не результаты');
  });
});

describe('compose with retrieved genre guide', () => {
  it('хороший первый ответ, настоящий гайд в system, lexical knowledge до модели', async () => {
    const { events, onEvent } = collector();
    const completeChat = vi.fn(async ({ messages }) => {
      expect(events.map((event) => event.event)).toEqual(['style', 'knowledge']);
      const system = messages[0].content;
      expect(system).toContain(techno.id);
      for (const rule of techno.rules) expect(system).toContain(rule);
      expect(system).toContain('120..150');
      expect(system).toContain('kick, hats, bass');
      expect(system).toContain(techno.chord_vocabulary.join(', '));
      return JSON.stringify(goodSpec());
    });
    const result = await buildTrack({ prompt: 'techno', seed: 7, completeChat, onEvent });
    expect(completeChat).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ attempts: 1, usedFallback: false, guide: { id: techno.id, genre: 'techno' }, seed: 7 });
    expect(result.compiled.code).toContain('$P001:');
    expect(events.find((event) => event.event === 'knowledge')).toMatchObject({ mode: 'lexical', semantic: false, degraded: true });
    expect(events.find((event) => event.event === 'genre-validation')).toMatchObject({ attempt: 1, ok: true, errors: [] });
  });

  it('не превращает dnb в новый enum TrackSpec', async () => {
    const result = await buildTrack({ prompt: 'drum and bass', seed: 7, completeChat: async () => JSON.stringify(goodSpec(174)) });
    expect(result.style).toBe('techno');
    expect(result.spec.meta.style).toBe('techno');
    expect(result.guide.genre).toBe('dnb');
    expect(result.attempts).toBe(1);
  });

  it('bad BPM → good: второй вызов получает repaired JSON и структурированные ошибки', async () => {
    const bad = goodSpec(110);
    bad.meta.schemaVersion = 1.2;
    bad.meta.key = 'C minor';
    const { events, onEvent } = collector();
    const completeChat = vi.fn().mockResolvedValueOnce(JSON.stringify(bad)).mockResolvedValueOnce(JSON.stringify(goodSpec()));
    const result = await buildTrack({ prompt: 'techno', seed: 7, completeChat, onEvent });
    expect(result.attempts).toBe(2);
    const first = completeChat.mock.calls[0][0];
    const second = completeChat.mock.calls[1][0];
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(second.messages[1].content).toContain(JSON.stringify(repairSpec(normalizeSpec(bad, 'techno'), 'techno')));
    expect(second.messages[1].content).toContain('"code":"bpm_range"');
    expect(second.messages[1].content).toContain('"path":"meta.bpm"');
    expect(second.temperature).toBe(0.2);
    expect(events.filter((event) => event.event === 'genre-validation').map(({ attempt, ok }) => ({ attempt, ok })))
      .toEqual([{ attempt: 1, ok: false }, { attempt: 2, ok: true }]);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.every((error) => typeof error === 'string')).toBe(true);
  });

  it('bad → bad → good: третий вызов получает последнюю, не первую спеку', async () => {
    const first = goodSpec(110);
    const second = goodSpec(151);
    const completeChat = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(first))
      .mockResolvedValueOnce(JSON.stringify(second))
      .mockResolvedValueOnce(JSON.stringify(goodSpec()));
    const result = await buildTrack({ prompt: 'techno', seed: 7, completeChat });
    expect(result.attempts).toBe(3);
    expect(result.usedFallback).toBe(false);
    expect(completeChat.mock.calls[2][0].messages[1].content).toContain(JSON.stringify(repairSpec(second, 'techno')));
    expect(completeChat.mock.calls[2][0].messages[0]).toEqual(completeChat.mock.calls[0][0].messages[0]);
  });

  it('три нарушения гайда → Error, без fallback/spec/compiled событий', async () => {
    const { events, onEvent } = collector();
    const completeChat = vi.fn(async () => JSON.stringify(goodSpec(110)));
    await expect(buildTrack({ prompt: 'techno', seed: 7, completeChat, onEvent })).rejects.toThrow(/после 3 попыток.*meta\.bpm/);
    expect(completeChat).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.event === 'genre-validation')).toHaveLength(3);
    expect(events.some((event) => ['fallback', 'spec', 'compiled'].includes(event.event))).toBe(false);
  });

  it('отсутствующая обязательная role исправляется моделью, не выдумывается кодом', async () => {
    const bad = goodSpec();
    delete bad.parts.roles.P004;
    const completeChat = vi.fn().mockResolvedValueOnce(JSON.stringify(bad)).mockResolvedValueOnce(JSON.stringify(goodSpec()));
    const result = await buildTrack({ prompt: 'techno', seed: 7, completeChat });
    expect(result.attempts).toBe(2);
    expect(completeChat.mock.calls[1][0].messages[1].content).toContain('"code":"required_role"');
    expect(result.spec.parts.roles.P004.role).toBe('bass');
  });

  it('сначала schema/compile validation; жанровый validator не маскирует её ошибки', async () => {
    const bad = goodSpec(110);
    bad.parts.roles.P001.effects = [{ name: 'unknown', params: [1] }];
    const completeChat = vi.fn().mockResolvedValueOnce(JSON.stringify(bad)).mockResolvedValueOnce(JSON.stringify(goodSpec()));
    const { events, onEvent } = collector();
    const result = await buildTrack({ prompt: 'techno', seed: 7, completeChat, onEvent });
    expect(result.attempts).toBe(2);
    expect(events.find((event) => event.event === 'genre-validation').errors[0].code).toBe('track_spec');
    expect(completeChat.mock.calls[1][0].messages[1].content).not.toContain('"code":"bpm_range"');
  });

  it('неразбираемый JSON: две попытки, затем только проверенный по жанру fallback', async () => {
    const completeChat = vi.fn(async () => 'not JSON');
    const { events, onEvent } = collector();
    const result = await buildTrack({ prompt: 'techno', seed: 7, completeChat, onEvent });
    expect(result.usedFallback).toBe(true);
    expect(completeChat).toHaveBeenCalledTimes(2);
    expect(completeChat.mock.calls[1][0].messages[1].content).toContain('"code":"json"');
    expect(completeChat.mock.calls[1][0].messages[1].content).toContain('\nnull\n');
    expect(checkGenreRules(result.spec, techno).ok).toBe(true);
    expect(events.find(e => e.phase === 'fallback')).toMatchObject({ ok: true, errors: [] });
  });

  it.each(['not JSON', JSON.stringify({ meta: {}, form: [] })])('без жанра legacy fallback, максимум два вызова: %s', async (text) => {
    const completeChat = vi.fn(async () => text);
    const result = await buildTrack({ prompt: 'сделай бит', seed: 7, completeChat });
    expect(completeChat).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ guide: null, attempts: 2, usedFallback: true });
    expect(result.compiled.code.length).toBeGreaterThan(0);
  });

  it('явный известный style выбирает гайд, без него настроение не выбирает', async () => {
    const completeChat = vi.fn(async () => JSON.stringify(goodSpec()));
    const explicit = await buildTrack({ prompt: 'сделай бит', style: 'techno', seed: 7, completeChat });
    expect(explicit.guide.genre).toBe('techno');
    const inferred = await buildTrack({ prompt: 'спокойное медитативное', seed: 7, completeChat });
    expect(inferred.guide).toBeNull();
    expect(inferred.style).toBe('ambient');
  });

  it('ошибка LLM с гайдом честно выходит без silent fallback', async () => {
    const error = new Error('provider unavailable');
    const completeChat = vi.fn(async () => { throw error; });
    const { events, onEvent } = collector();
    await expect(buildTrack({ prompt: 'techno', seed: 7, completeChat, onEvent })).rejects.toBe(error);
    expect(completeChat).toHaveBeenCalledOnce();
    expect(events.some((event) => event.event === 'fallback' || event.event === 'compiled')).toBe(false);
  });

  it('без гайда ошибка LLM сохраняет legacy fallback', async () => {
    const completeChat = vi.fn(async () => { throw new Error('provider unavailable'); });
    const result = await buildTrack({ prompt: 'бит', seed: 7, completeChat });
    expect(result.usedFallback).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it.each(['techno', 'бит'])('abort останавливает вызовы без fallback: %s', async (prompt) => {
    const controller = new AbortController();
    const error = new Error('aborted');
    const completeChat = vi.fn(async () => { controller.abort(); throw error; });
    const { events, onEvent } = collector();
    await expect(buildTrack({ prompt, seed: 7, signal: controller.signal, completeChat, onEvent })).rejects.toBe(error);
    expect(completeChat).toHaveBeenCalledOnce();
    expect(events.some((event) => ['fallback', 'spec', 'compiled'].includes(event.event))).toBe(false);
  });

  it('сэмпл сохраняется в system и повторной проверке при допустимом BPM', async () => {
    const sampleEntry = { id: 'genre-test', name: 'Glass', licenseId: 'cc0', passport: { tempo: { bpm: 129, confidence: 0.8 } } };
    const completeChat = vi.fn(async () => JSON.stringify(goodSpec()));
    const { events, onEvent } = collector();
    const result = await buildTrack({ prompt: 'techno', seed: 7, sampleEntry, completeChat, onEvent });
    expect(completeChat.mock.calls[0][0].messages[0].content).toContain('Трек строится вокруг сэмпла «Glass»');
    expect(completeChat.mock.calls[0][0].messages[0].content).toContain(techno.id);
    expect(result.spec.meta.bpm).toBe(129);
    expect(result.sample.bpm).toBe(129);
    expect(events.find((event) => event.phase === 'sample')).toMatchObject({ event: 'genre-validation', attempt: 1, ok: true });
  });

  it('BPM после applySamplePlan вне диапазона → Error до публикации спеки/кода', async () => {
    const sampleEntry = { id: 'genre-test', name: 'Glass', licenseId: 'cc0', passport: { tempo: { bpm: 100, confidence: 0.8 } } };
    const completeChat = vi.fn(async () => JSON.stringify(goodSpec()));
    const { events, onEvent } = collector();
    await expect(buildTrack({ prompt: 'techno', seed: 7, sampleEntry, completeChat, onEvent })).rejects.toThrow(/сэмпла нарушает гайд.*meta\.bpm/);
    expect(completeChat).toHaveBeenCalledOnce();
    expect(events.find((event) => event.phase === 'sample')).toMatchObject({ ok: false, errors: [{ code: 'bpm_range' }] });
    expect(events.some((event) => ['fallback', 'spec', 'compiled'].includes(event.event))).toBe(false);
  });

  it('role override после applySamplePlan также не обходит гайд', async () => {
    vi.spyOn(samplePlan, 'applySamplePlan').mockImplementation((spec) => {
      const next = structuredClone(spec);
      next.parts.roles.P004.role = 'pad';
      return { spec: next, applied: {} };
    });
    const { events, onEvent } = collector();
    await expect(buildTrack({
      prompt: 'techno', seed: 7, sampleEntry: { id: 'genre-test' }, onEvent,
      completeChat: async () => JSON.stringify(goodSpec()),
    })).rejects.toThrow(/сэмпла нарушает гайд.*bass/);
    expect(events.find((event) => event.phase === 'sample').errors[0].code).toBe('required_role');
    expect(events.some((event) => event.event === 'compiled')).toBe(false);
  });
});
