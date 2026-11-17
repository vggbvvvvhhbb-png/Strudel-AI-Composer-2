// Фаза G: детерминированное объяснение кода (D-140).

import { describe, it, expect } from 'vitest';
import { explainCode, extractChordSymbols } from '../../server/rag/explain.js';

describe('объяснение кода', () => {
  it('ii–V–I в C major распознаётся с функциями и каденцией', () => {
    const code = 'const key = "c:major"\n$CHORDS: chord("<Dm7 G7 CM7>").voicing().s("piano")';
    const r = explainCode(code);
    expect(r.ok).toBe(true);
    expect(r.progression.name).toBe('ii–V–I');
    expect(r.chords.map((c) => c.function)).toEqual(['S', 'D', 'T']);
    expect(r.chords.map((c) => c.degree)).toEqual([1, 4, 0]);
    expect(r.cadence).toBe('authentic');
    expect(r.suggestions.some((s) => s.kind === 'tritone-sub' && s.target === 'G7')).toBe(true);
    expect(r.lines.join(' ')).toContain('ii–V–I');
  });

  it('тритоновая замена предлагается для доминанты, корень +6', () => {
    const r = explainCode('const key = "c:major"\n$X: chord("<G7 CM7>").voicing()');
    const sub = r.suggestions.find((s) => s.kind === 'tritone-sub');
    expect(sub.text).toContain('Db7');
  });

  it('хроматический аккорд помечается, а не выдумывается ступень', () => {
    const r = explainCode('const key = "f:major"\n$X: chord("<FM7 Gb7>").voicing()');
    expect(r.chords[1].chromatic).toBe(true);
    expect(r.chords[1].degree).toBeNull();
    expect(r.chords[1].function).toBeNull();
  });

  it('андалузская i–VII–VI–V в миноре', () => {
    const r = explainCode('const key = "a:minor"\n$X: chord("<Am G F E>").voicing()');
    expect(r.progression.name).toBe('i–VII–VI–V');
  });

  it('без chord() и без key — честные причины, не выдумка', () => {
    expect(explainCode('$X: s("bd*4")').reason).toContain('нет chord()');
    expect(explainCode('$X: chord("Am")').reason).toContain('нет key');
  });

  it('extractChordSymbols разворачивает секвенции', () => {
    expect(extractChordSymbols('chord("<Am F C G>")')).toEqual(['Am', 'F', 'C', 'G']);
    expect(extractChordSymbols('chord("Dm9")')).toEqual(['Dm9']);
  });

  it('качества аккордов различаются', () => {
    const r = explainCode('const key = "c:major"\n$X: chord("<CM7 Dm7 G7 C6>").voicing()');
    expect(r.chords.map((c) => c.quality)).toEqual(['major7', 'minor', 'dominant7', 'sixth']);
  });
});