// Фаза C: гейт золотого датасета (D-136). Каждая запись проходит реальный
// парсинг Strudel, queryArc даёт события, звучащие ноты принадлежат
// заявленному ладу (кроме осознанной хроматики), пресеты существуют и CC0.
// Невалидная запись не может попасть в базу — loadDataset её отсекает.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, DATASET_PATH } from '../../server/rag/dataset.js';
import { staticValidate } from '../../src/core/validator.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';
import { checkScaleMembership } from '../../server/rag/music-check.js';

const { entries, errors } = loadDataset();

describe('золотой датасет: целостность', () => {
  it('все записи проходят схему и сверку пресетов с каталогом', () => {
    expect(errors).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(30);
  });

  it('id уникальны', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('loadDataset отсекает невалидную запись (не молча)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-dataset-'));
    try {
      const bad = [{ ...entries[0], id: 'kb-bad', music_tags: { ...entries[0].music_tags, tonic: 'h' } }];
      const p = join(dir, 'bad.json');
      writeFileSync(p, JSON.stringify(bad));
      const r = loadDataset(p);
      expect(r.entries).toEqual([]);
      expect(r.errors[0].id).toBe('kb-bad');
      const dup = [entries[0], entries[0]];
      writeFileSync(p, JSON.stringify(dup));
      expect(loadDataset(p).errors[0].errors[0].message).toContain('дубликат');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('золотой датасет: каждая запись звучит и теоретически честна', () => {
  it.each(entries.map((e) => [e.id, e]))('%s', async (_id, entry) => {
    const stat = staticValidate(entry.strudel_code);
    expect(stat.ok, JSON.stringify(stat.error)).toBe(true);

    const run = await runStrudel(entry.strudel_code, { cycles: 4 });
    expect(run.ok, run.error || '').toBe(true);
    expect(run.order.length).toBeGreaterThan(0);
    for (const part of run.order) {
      expect(run.parts[part].length, `партия ${part} пуста`).toBeGreaterThan(0);
    }

    const check = checkScaleMembership(run.parts, entry.music_tags.tonic, entry.music_tags.mode);
    if (entry.music_tags.chromatic) {
      // Осознанная хроматика обязана реально выходить за лад — иначе флаг лжёт.
      expect(check.offenders.length, 'chromatic=true, но хроматики нет').toBeGreaterThan(0);
    } else {
      expect(check.offenders, `ноты вне лада: ${JSON.stringify(check.offenders)}`).toEqual([]);
    }
  });
});

describe('золотой датасет: каждый аккордовый символ реально звучит', () => {
  // Регресс на класс дефекта: voicing() молча роняет неизвестные символы
  // (Fmaj7/Cmaj7 → 0 событий, замер 18.11.2026; рабочие — FM7/CM7).
  const symbols = new Set();
  for (const e of entries) {
    for (const m of e.strudel_code.matchAll(/chord\("([^"]+)"\)/g)) {
      for (const s of m[1].replace(/[<>]/g, ' ').split(/\s+/).filter(Boolean)) symbols.add(s);
    }
  }

  it.each([...symbols])('chord("%s").voicing() даёт события', async (sym) => {
    const r = await runStrudel(`$X: chord("${sym}").voicing()`, { cycles: 1 });
    expect(r.ok).toBe(true);
    expect((r.parts.X || []).length, `символ ${sym} молча выпал`).toBeGreaterThan(0);
  });
});

describe('золотой датасет: покрытие', () => {
  const tag = (k) => entries.map((e) => e.music_tags[k]);

  it('жанры: не меньше 8 разных', () => {
    const genres = new Set(tag('genre').flat());
    expect(genres.size).toBeGreaterThanOrEqual(8);
    for (const g of ['lofi', 'house', 'techno', 'trap', 'dnb', 'ambient', 'jazz', 'rock', 'phonk', 'funk']) {
      expect(genres.has(g), `жанр ${g} не покрыт`).toBe(true);
    }
  });

  it('лады: не меньше 5, включая dorian/mixolydian/phrygian/lydian/harmonic-minor', () => {
    const modes = new Set(tag('mode'));
    expect(modes.size).toBeGreaterThanOrEqual(5);
    for (const m of ['major', 'minor', 'dorian', 'mixolydian', 'phrygian', 'lydian', 'harmonic-minor']) {
      expect(modes.has(m), `лад ${m} не покрыт`).toBe(true);
    }
  });

  it('роли: аккорды, бас, арпеджио, ударные, пэды, мелодия', () => {
    const roles = new Set(tag('roles').flat());
    for (const r of ['chords', 'bass', 'arp', 'kick', 'snare', 'hats', 'pad', 'lead']) {
      expect(roles.has(r), `роль ${r} не покрыта`).toBe(true);
    }
  });

  it('сложности: все три уровня', () => {
    expect(new Set(tag('complexity'))).toEqual(new Set(['basic', 'intermediate', 'advanced']));
  });

  it('пресеты: не меньше 5 записей с реальными CC0-пресетами, все 10 каталога задействованы', () => {
    const withPresets = entries.filter((e) => e.cc0_preset_ids.length > 0);
    expect(withPresets.length).toBeGreaterThanOrEqual(5);
    const used = new Set(withPresets.flatMap((e) => e.cc0_preset_ids));
    expect(used.size).toBe(10);
  });

  it('bpm null встречается (темп не применим — честно)', () => {
    expect(entries.some((e) => e.music_tags.bpm === null)).toBe(true);
  });

  it('хроматика: хотя бы одна запись с осознанным выходом за лад', () => {
    expect(entries.some((e) => e.music_tags.chromatic)).toBe(true);
  });

  it('каждая запись имеет rationale и происхождение', () => {
    for (const e of entries) {
      expect(e.rationale.length).toBeGreaterThanOrEqual(20);
      expect(['own', 'library', 'external']).toContain(e.source.origin);
    }
  });
});