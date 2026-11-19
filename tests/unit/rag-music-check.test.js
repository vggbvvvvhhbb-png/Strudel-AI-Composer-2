// Фаза B: музыкальные проверки по реальным событиям Strudel (D-135).
// Принадлежность нот ладу проверяется по queryArc, а не по тексту кода.

import { describe, it, expect } from 'vitest';
import {
  normalizeTonic, pitchClassOfNote, scalePitchClasses, checkScaleMembership,
} from '../../server/rag/music-check.js';
import { loadStrudel, runStrudel } from '../../server/music/strudel-runtime.mjs';

describe('нормализация тоники и питч-классы', () => {
  it('диезы приводятся к бемолям, регистр не важен', () => {
    expect(normalizeTonic('C#')).toBe('db');
    expect(normalizeTonic(' A ')).toBe('a');
    expect(normalizeTonic('F#')).toBe('gb');
    expect(normalizeTonic('h')).toBeNull();
    expect(normalizeTonic('')).toBeNull();
  });

  it('питч-класс ноты с октавой', () => {
    expect(pitchClassOfNote('C3')).toBe(0);
    expect(pitchClassOfNote('eb4')).toBe(3);
    expect(pitchClassOfNote('F#2')).toBe(6);
    expect(pitchClassOfNote('Bb3')).toBe(10);
    expect(pitchClassOfNote('bd')).toBeNull();   // сэмпл, не нота
    expect(pitchClassOfNote('c')).toBeNull();    // без октавы
  });

  it('питч-классы лада: a minor и c major (параллельные — одни классы)', () => {
    expect(scalePitchClasses('a', 'minor').sort((x, y) => x - y)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scalePitchClasses('c', 'major').sort((x, y) => x - y)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scalePitchClasses('c', 'minor')).toContain(3);
    expect(scalePitchClasses('c', 'minor')).not.toContain(4);
    expect(scalePitchClasses('b', 'locrian')).toEqual([11, 0, 2, 4, 5, 7, 9]);
  });
});

describe('принадлежность нот ладу на настоящем Strudel', () => {
  it('c:minor трезвучие проходит, мажорная терция в миноре — нарушение', async () => {
    const api = await loadStrudel();
    const okHaps = api.note('c4 eb4 g4').queryArc(0, 1).map((h) => ({ value: h.value }));
    const ok = checkScaleMembership({ MEL: okHaps }, 'c', 'minor');
    expect(ok.ok).toBe(true);
    expect(ok.checked).toBe(3);

    const badHaps = api.note('c4 e4 g4').queryArc(0, 1).map((h) => ({ value: h.value }));
    const bad = checkScaleMembership({ MEL: badHaps }, 'c', 'minor');
    expect(bad.ok).toBe(false);
    expect(bad.offenders).toEqual([{ part: 'MEL', note: 'e4', pitchClass: 4 }]);
  });

  it('n().scale() проверяется по звучащим высотам', async () => {
    const r = await runStrudel('$MEL: n("0 2 4 6").scale("c:minor").s("piano")', { cycles: 2 });
    expect(r.ok).toBe(true);
    const check = checkScaleMembership(r.parts, 'c', 'minor');
    expect(check.ok).toBe(true);
    expect(check.checked).toBe(8);
  });

  it('ударные без высоты пропускаются, а не считаются нарушением', async () => {
    const r = await runStrudel('$DRUMS: s("bd sd hh sd")', { cycles: 1 });
    expect(r.ok).toBe(true);
    const check = checkScaleMembership(r.parts, 'c', 'minor');
    expect(check.ok).toBe(true);
    expect(check.checked).toBe(0);
  });

  it('родственный лад: A dorian принимает f#, A minor — нет', async () => {
    const api = await loadStrudel();
    const haps = api.note('a3 c4 e4 f#4').queryArc(0, 1).map((h) => ({ value: h.value }));
    expect(checkScaleMembership({ MEL: haps }, 'a', 'dorian').ok).toBe(true);
    const minor = checkScaleMembership({ MEL: haps }, 'a', 'minor');
    expect(minor.ok).toBe(false);
    expect(minor.offenders[0].note).toBe('f#4');
  });
});

describe('факты движка @strudel/web 1.3.0, зафиксированные замером (18.11.2026)', () => {
  it('scale("a:harmonicminor") пуст — harmonic-minor сниппеты пишутся через note()', async () => {
    const r = await runStrudel('$X: n("0 1 2 3 4 5 6").scale("a:harmonicminor")', { cycles: 1 });
    expect((r.parts.X || []).length).toBe(0);
  });

  it('chord() без voicing() не даёт высот, с voicing() — даёт', async () => {
    const bare = await runStrudel('$X: chord("Am")', { cycles: 1 });
    expect(bare.parts.X[0].value.note).toBeUndefined();
    const voiced = await runStrudel('$X: chord("Am").voicing()', { cycles: 1 });
    expect(voiced.parts.X.length).toBeGreaterThan(0);
    expect(typeof voiced.parts.X[0].value.note).toBe('string');
    const check = checkScaleMembership(voiced.parts, 'a', 'minor');
    expect(check.ok).toBe(true);
    expect(check.checked).toBeGreaterThan(0);
  });
});