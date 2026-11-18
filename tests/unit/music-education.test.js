import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateEntry, EDUCATION_DIRECTIONS } from '../../server/rag/schema.js';
import { loadDataset, DATASET_PATH } from '../../server/rag/dataset.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';
import { SupabaseKnowledgeStore } from '../../server/rag/store-supabase.js';
import { examplesBlock } from '../../server/rag/prompt.js';
import { lexicalScore } from '../../server/rag/search-core.js';
import { mockCompletion } from '../../server/llm/mock.js';
import { composeTrack } from '../../src/api/client.js';

const { entries } = loadDataset();
const guide = entries.find(e => e.id === 'edu-guide-lofi-hiphop');
const raw = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));

function withGuide(change) {
  return { ...guide, education: { ...guide.education, guide: { ...guide.education.guide, ...change } } };
}

async function onsets(id, part, cycles = 1) {
  const entry = entries.find(e => e.id === id);
  const run = await runStrudel(entry.strudel_code, { cycles });
  expect(run.ok, run.error).toBe(true);
  return run.parts[part].map(e => e.whole.begin);
}

describe('музыкальное образование: схема', () => {
  it('прежние 35 записей не изменены', () => {
    const hash = createHash('sha256').update(JSON.stringify(raw.slice(0, 35))).digest('hex');
    expect(hash).toBe('9c70eed64f80fe2af4978f472b525270e53a1b0c6e80c7afa8e7f933e1ebcf2e');
  });

  it('education не требуется для прежней записи', () => {
    const r = validateEntry(raw[0]);
    expect(r.ok).toBe(true);
    expect(r.value.education).toBeUndefined();
  });

  it('типизированные правила не теряются при Zod-валидации', () => {
    expect(validateEntry(guide).value.education).toEqual(guide.education);
  });

  it.each([
    ['обратный диапазон', { bpm_range: [90, 70] }],
    ['слишком низкий BPM', { bpm_range: [0, 90] }],
    ['слишком высокий BPM', { bpm_range: [70, 300] }],
    ['дробный BPM', { bpm_range: [70.5, 90] }],
    ['нет нижней границы', { bpm_range: [null, 90] }],
    ['неизвестная роль', { required_roles: ['drums'] }],
    ['пустой alias', { aliases: [''] }],
    ['нет aliases', { aliases: [] }],
    ['пустой жанр', { genre: '' }],
  ])('отклоняет %s', (_name, change) => {
    const r = validateEntry(withGuide(change));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path.startsWith('education.guide'))).toBe(true);
  });

  it.each([
    { direction: 'invented', rules: ['Не используй выдуманные правила.'] },
    { direction: 'rhythm', rules: [] },
    { direction: 'rhythm', rules: ['коротко'] },
  ])('отклоняет невалидный учебный блок %j', education => {
    expect(validateEntry({ ...guide, education }).ok).toBe(false);
  });

  it('свободное направление не обязано содержать гайд', () => {
    const education = { direction: guide.education.direction, rules: guide.education.rules };
    expect(validateEntry({ ...guide, education }).ok).toBe(true);
  });
});

describe('ритмические знания: измеренные позиции queryArc', () => {
  it.each([
    ['edu-son-clave-2-3', 'CLAVE', 2, [0.25, 0.5, 1, 1.375, 1.75]],
    ['edu-son-clave-3-2', 'CLAVE', 2, [0, 0.375, 0.75, 1.25, 1.5]],
    ['edu-rumba-clave-2-3', 'CLAVE', 2, [0.25, 0.5, 1, 1.375, 1.875]],
    ['edu-tresillo-332', 'PERC', 1, [0, 0.375, 0.75]],
    ['edu-habanera-3122', 'BASS', 1, [0, 0.375, 0.5, 0.75]],
    ['edu-house-fourfloor-offbeat', 'KICK', 1, [0, 0.25, 0.5, 0.75]],
    ['edu-house-fourfloor-offbeat', 'OPEN', 1, [0.125, 0.375, 0.625, 0.875]],
    ['edu-trap-halftime-hat-roll', 'SNARE', 1, [0.5]],
    ['edu-lofi-swung-eighths', 'HATS', 1, [0, 0.15, 0.25, 0.4, 0.5, 0.65, 0.75, 0.9]],
  ])('%s/%s сохраняет заявленные атаки', async (id, part, cycles, expected) => {
    const actual = await onsets(id, part, cycles);
    expect(actual.length).toBe(expected.length);
    actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 8));
  });

  it.each([
    ['edu-polyrhythm-3-4', 'THREE', 3],
    ['edu-polyrhythm-3-4', 'FOUR', 4],
    ['edu-polyrhythm-4-5', 'FIVE', 5],
    ['edu-metric-modulation-triplet', 'NEW', 6],
  ])('%s/%s делит общий цикл на %i равных интервалов', async (id, part, count) => {
    const actual = await onsets(id, part);
    expect(actual.length).toBe(count);
    actual.forEach((v, i) => expect(v).toBeCloseTo(i / count, 8));
  });

  it('ghost snare существенно тише backbeat', async () => {
    const entry = entries.find(e => e.id === 'edu-funk-ghost-snare');
    const run = await runStrudel(entry.strudel_code, { cycles: 1 });
    expect(Math.max(...run.parts.GHOST.map(e => e.value.gain))).toBeLessThan(
      Math.min(...run.parts.BACK.map(e => e.value.gain)) / 4,
    );
  });
});

describe('контрапункт и ошибки протокола: регресс', () => {
  it('пауза верхнего голоса открывает звучащий бас, а не совпадает с его паузой', async () => {
    const run = await runStrudel(entries.find(e => e.id === 'edu-counterpoint-rhythmic-independence').strudel_code, { cycles: 1 });
    expect(run.parts.LOW.some(e => e.whole.begin === 0.5)).toBe(true);
    expect(run.parts.HIGH.some(e => e.whole.begin === 0.5)).toBe(false);
    expect(run.parts.HIGH.some(e => e.whole.begin === 0.625)).toBe(true);
  });

  it('API-клиент передаёт error в трейс и отклоняет результат без применения кода', async () => {
    const error = { type: 'error', message: 'Жанровый гайд не выполнен после 3 попыток' };
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify(error)}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    try {
      await expect(composeTrack({ prompt: 'dnb', onEvent })).rejects.toThrow(error.message);
      expect(onEvent).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith(error);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('мок композитора не выбирает первый стиль из списка enum', () => {
  it.each(['techno', 'house', 'lo-fi'])('%s берётся из маркера выбранного стиля', style => {
    const result = JSON.parse(mockCompletion({
      messages: [
        { role: 'system', content: `Верни JSON. style: lo-fi, techno, house. Стиль запроса: ${style}.` },
        { role: 'user', content: 'Запрос: бит' },
      ],
      responseFormat: { type: 'json_object' },
    }));
    expect(result.meta.style).toBe(style);
  });
});

describe('учебные правила проходят контур хранения и промпта', () => {
  it('Supabase сохраняет education в существующей JSONB-колонке без миграции', async () => {
    let params;
    const store = new SupabaseKnowledgeStore({ query: async (_sql, p) => { params = p; return { rows: [] }; } });
    await store.upsert(guide);
    expect(JSON.parse(params[5]).education).toEqual(guide.education);
    expect(JSON.parse(params[5]).genre).toEqual(guide.music_tags.genre);
    expect(guide.music_tags.education).toBeUndefined();
  });

  it('Supabase возвращает education на верхнем уровне, теги без дублирования', async () => {
    const stored = { ...guide, music_tags: { ...guide.music_tags, education: guide.education }, embedding: null };
    const store = new SupabaseKnowledgeStore({ query: async () => ({ rows: [stored] }) });
    const [entry] = await store.all();
    expect(entry.education).toEqual(guide.education);
    expect(entry.music_tags).toEqual(guide.music_tags);
    expect(validateEntry(entry).ok).toBe(true);
  });

  it('прежние Supabase-записи без education по-прежнему читаются', async () => {
    const stored = { ...entries[0], embedding: null };
    const store = new SupabaseKnowledgeStore({ query: async () => ({ rows: [stored] }) });
    const [entry] = await store.all();
    expect(entry.music_tags).toEqual(entries[0].music_tags);
    expect(entry.education).toBeUndefined();
  });

  it('правила реально подшиваются к найденному примеру', () => {
    const block = examplesBlock([{ entry: guide }]);
    for (const rule of guide.education.rules) expect(block).toContain(rule);
    expect(block).toContain(guide.strudel_code);
  });

  it('лексический поиск видит правила, а не только название', () => {
    const entry = { ...guide, education: { direction: 'arrangement', rules: ['Уникальныйконтрапункт требуется здесь.'] } };
    expect(lexicalScore('уникальныйконтрапункт', entry)).toBeGreaterThan(0);
    expect(lexicalScore('уникальныйконтрапункт', { ...entry, education: undefined })).toBe(0);
  });
});

describe('покрытие учебного корпуса', () => {
  it('добавлено не менее 100 авторских записей', () => {
    expect(entries.length).toBeGreaterThanOrEqual(135);
    for (const e of entries.filter(e => e.education)) expect(e.source).toEqual({ origin: 'own', license: 'CC0-1.0' });
  });

  it.each(EDUCATION_DIRECTIONS)('направление %s представлено', direction => {
    expect(entries.some(e => e.education?.direction === direction)).toBe(true);
  });

  it('не менее десяти гайдов и двадцати ритмических записей', () => {
    expect(entries.filter(e => e.education?.guide).length).toBeGreaterThanOrEqual(10);
    expect(entries.filter(e => e.education?.direction === 'rhythm').length).toBeGreaterThanOrEqual(20);
  });
});
