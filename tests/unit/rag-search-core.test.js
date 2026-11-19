// Фаза D: ядро гибридного поиска — фильтры, стадии fallback, детерминизм.

import { describe, it, expect } from 'vitest';
import {
  stageFilter, hybridSearch, cosineSimilarity, lexicalScore, rankCandidates, tokenize,
} from '../../server/rag/search-core.js';

const entry = (id, tags, text = '') => ({
  id,
  title: text || id,
  description: text || id,
  rationale: text || id,
  music_tags: { genre: ['lofi'], tonic: 'a', mode: 'minor', roles: ['chords'], complexity: 'basic', bpm: 80, ...tags },
});

const A_MINOR = entry('a-minor', {});
const A_DORIAN = entry('a-dorian', { mode: 'dorian' });
const C_MAJOR = entry('c-major', { tonic: 'c', mode: 'major', genre: ['house'] });
const BASS = entry('bass-line', { roles: ['bass'], genre: ['funk'] });

describe('фильтры по стадиям', () => {
  const f = { tonic: 'a', mode: 'minor', roles: ['chords'] };

  it('exact: тоника+лад+роль должны совпасть', () => {
    expect(stageFilter(A_MINOR, f, 'exact')).toBe(true);
    expect(stageFilter(A_DORIAN, f, 'exact')).toBe(false);
    expect(stageFilter(C_MAJOR, f, 'exact')).toBe(false);
    expect(stageFilter(BASS, f, 'exact')).toBe(false);
  });

  it('tonic: родственный лад проходит (A dorian при запросе A minor)', () => {
    expect(stageFilter(A_DORIAN, f, 'tonic')).toBe(true);
    expect(stageFilter(C_MAJOR, f, 'tonic')).toBe(false);
  });

  it('genre-roles: пересечение по жанру ИЛИ роли', () => {
    const fr = { genre: ['funk'], roles: ['chords'] };
    expect(stageFilter(BASS, fr, 'genre-roles')).toBe(true);      // жанр funk
    expect(stageFilter(A_MINOR, fr, 'genre-roles')).toBe(true);   // роль chords
    expect(stageFilter(C_MAJOR, fr, 'genre-roles')).toBe(true);   // роль chords
    const neither = entry('neither', { genre: ['techno'], roles: ['bass'] });
    expect(stageFilter(neither, fr, 'genre-roles')).toBe(false);
  });

  it('диезная тоника нормализуется (f# = gb)', () => {
    const gb = entry('gb-minor', { tonic: 'gb' });
    expect(stageFilter(gb, { tonic: 'f#' }, 'exact')).toBe(true);
  });

  it('all: проходит всё', () => {
    for (const e of [A_MINOR, A_DORIAN, C_MAJOR, BASS]) {
      expect(stageFilter(e, f, 'all')).toBe(true);
    }
  });
});

describe('гибридный поиск и fallback', () => {
  const entries = [A_MINOR, A_DORIAN, C_MAJOR, BASS];

  it('точная стадия без ослабления, когда совпадений хватает', () => {
    const many = [A_MINOR, entry('a-minor-2', {}), entry('a-minor-3', {})];
    const r = hybridSearch(many, { query: 'минорные аккорды', filters: { tonic: 'a', mode: 'minor' }, topK: 3 });
    expect(r.stage).toBe('exact');
    expect(r.degraded).toBe(true); // нет эмбеддинга — лексика, честно помечено
    expect(r.reason).toContain('лексическое');
    expect(r.results).toHaveLength(3);
  });

  it('мало точных совпадений → ослабление до tonic (родственные лады)', () => {
    const withRelative = [...entries, entry('a-major', { mode: 'major' })];
    const r = hybridSearch(withRelative, { query: 'аккорды', filters: { tonic: 'a', mode: 'minor' }, topK: 3, minResults: 3 });
    expect(r.stage).toBe('tonic');
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('ослаблены');
    expect(r.results.map((x) => x.entry.id)).toContain('a-dorian');
  });

  it('совсем нет совпадений → стадия all, выдача непустая', () => {
    const r = hybridSearch(entries, {
      query: 'ударные',
      filters: { tonic: 'eb', mode: 'locrian', genre: ['zyzz'], roles: ['fx'] },
      topK: 3,
    });
    expect(r.stage).toBe('all');
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('детерминизм: одинаковый вход → одинаковая выдача, тай-брейк по id', () => {
    const q = { query: 'аккорды', filters: {}, topK: 3 };
    const r1 = hybridSearch(entries, q);
    const r2 = hybridSearch(entries, q);
    expect(r1.results.map((x) => x.entry.id)).toEqual(r2.results.map((x) => x.entry.id));
    const tied = [entry('z-same', {}, 'одинаковый текст'), entry('a-same', {}, 'одинаковый текст')];
    const r3 = hybridSearch(tied, { query: 'одинаковый текст', topK: 2 });
    expect(r3.results[0].entry.id).toBe('a-same');
  });
});

describe('ранжирование: косинус против лексики', () => {
  it('косинус совпадающих векторов = 1, ортогональных = 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('с эмбеддингом запроса векторное ранжирование сильнее лексики', () => {
    const near = { ...entry('near', {}, 'совсем другой текст'), embedding: [1, 0] };
    const far = { ...entry('far', {}, 'джазовые аккорды минор'), embedding: [0, 1] };
    const r = rankCandidates([far, near], 'джазовые аккорды минор', [1, 0]);
    expect(r[0].entry.id).toBe('near');
    expect(r[0].score).toBeCloseTo(1);
  });

  it('запись без эмбеддинга при семантическом запросе получает лексику ×0.5', () => {
    const withVec = { ...entry('vec', {}, 'текст'), embedding: [1, 0] };
    const noVec = entry('novec', {}, 'текст');
    const r = rankCandidates([noVec, withVec], 'текст', [1, 0]);
    const noVecScore = r.find((x) => x.entry.id === 'novec').score;
    expect(noVecScore).toBeCloseTo(0.5 * lexicalScore('текст', noVec));
    expect(r[0].entry.id).toBe('vec');
  });

  it('лексика: стоп-слова не считаются, кириллица работает', () => {
    expect(tokenize('и в на джаз')).toEqual(['джаз']);
    const e = entry('jazz', {}, 'джазовые аккорды');
    expect(lexicalScore('джаз аккорды', e)).toBeGreaterThan(0.5);
    expect(lexicalScore('квантовая физика', e)).toBe(0);
  });
});