// Гармония IR: римские цифры → символы аккордов движка.
import { describe, it, expect } from 'vitest';
import {
  parseRoman,
  symbolForRoman,
  chordSymbol,
  buildChordPlan,
  degreePitchClass,
  PROGRESSIONS,
} from '../../src/ir/harmony.js';

// Движок понимает только эти суффиксы (см. комментарий в src/ir/harmony.js):
// пусто, m, madd9, add9, sus, 7, m7, m9, ^7, aug.
// Cmaj7 движок НЕ понимает, поэтому Imaj7 превращается в C^7.
const SUPPORTED = /^([A-G][#b]?)(m|madd9|add9|sus|7|m7|m9|\^7|aug)?$/;

describe('Разбор римских цифр', () => {
  it('I — первая ступень мажора', () => {
    expect(parseRoman('I')).toEqual({ degree: 1, accidental: 0, quality: 'major' });
  });

  it('bII — вторая ступень с бемолем', () => {
    expect(parseRoman('bII')).toEqual({ degree: 2, accidental: -1, quality: 'major' });
  });

  it('vi — шестая ступень минора', () => {
    expect(parseRoman('vi')).toEqual({ degree: 6, accidental: 0, quality: 'minor' });
  });

  it.each(['bogus', '', 'H', 'VIII', 'Imaj7', '9'])('некорректная цифра %s разбирается в null', (roman) => {
    expect(parseRoman(roman)).toBeNull();
  });

  it('знак «#» даёт повышение на полутон', () => {
    expect(parseRoman('#IV')).toEqual({ degree: 4, accidental: 1, quality: 'major' });
  });
});

describe('Символы аккордов', () => {
  it('тоника минора даёт минорный символ', () => {
    expect(symbolForRoman('d:minor', 'i')).toBe('Dm');
  });

  it('цвет 7 добавляет септиму', () => {
    expect(symbolForRoman('d:minor', 'i', '7')).toBe('Dm7');
  });

  it('bII в до миноре — это Db (неполитанский аккорд ♭II)', () => {
    expect(symbolForRoman('c:minor', 'bII')).toBe('Db');
    expect(degreePitchClass('c:minor', 2, -1)).toBe(1);
  });

  it('доминанта в до мажоре с септимой — G7', () => {
    expect(symbolForRoman('c:major', 'V', '7')).toBe('G7');
  });

  it('суффикс maj7 даёт форму ^7, а не Cmaj7', () => {
    expect(symbolForRoman('c:major', 'Imaj7')).toBe('C^7');
    expect(symbolForRoman('c:major', 'Imaj7')).not.toContain('maj7');
  });

  it('цвет sus и add9 дают поддерживаемые символы', () => {
    expect(chordSymbol('c:major', 'I', 'sus')).toBe('Csus');
    expect(chordSymbol('c:major', 'I', 'add9')).toBe('Cadd9');
    expect(chordSymbol('c:minor', 'i', '7')).toBe('Cm7');
  });

  it('нераспознанная цифра даёт null, а не мусор', () => {
    expect(symbolForRoman('c:minor', 'bogus')).toBeNull();
  });
});

describe('План аккордов секции', () => {
  it('доли тактов в сумме равны длине секции', () => {
    const plan = buildChordPlan('d:minor', [{ rn: 'i', bars: 2 }, { rn: 'V', bars: 2 }], 4);
    expect(plan).toHaveLength(2);
    expect(plan.reduce((sum, chord) => sum + chord.bars, 0)).toBe(4);
    expect(plan.map((chord) => chord.symbol)).toEqual(['Dm', 'A']);
  });

  it('перекос пропорций всё равно даёт секцию нужной длины', () => {
    const plan = buildChordPlan('c:minor', [{ rn: 'i', bars: 1 }, { rn: 'V', bars: 3 }], 8);
    expect(plan.reduce((sum, chord) => sum + chord.bars, 0)).toBe(8);
  });

  it('пустая гармония даёт один тонический аккорд', () => {
    const plan = buildChordPlan('c:minor', [], 4);
    expect(plan).toHaveLength(1);
    expect(plan[0].bars).toBe(4);
    expect(plan[0].symbol).toBeTruthy();
  });
});

describe('Стандартные прогрессии совместимы с движком', () => {
  const keys = ['c:major', 'c:minor', 'd:minor', 'eb:major', 'a:minor', 'g:major'];

  it('каждый символ прогрессии — непустая строка поддерживаемого вида', () => {
    for (const [mood, progression] of Object.entries(PROGRESSIONS)) {
      for (const key of keys) {
        for (const roman of progression) {
          const symbol = symbolForRoman(key, roman);
          expect(symbol, `${mood} ${key} ${roman}`).toBeTruthy();
          expect(symbol, `${mood} ${key} ${roman}`).toMatch(SUPPORTED);
        }
      }
    }
  });

  it('ни один символ не использует неподдерживаемые суффиксы sus2/dim/maj7', () => {
    for (const [mood, progression] of Object.entries(PROGRESSIONS)) {
      for (const key of keys) {
        for (const roman of progression) {
          const symbol = symbolForRoman(key, roman);
          expect(symbol.endsWith('sus2'), `${mood} ${key} ${roman}`).toBe(false);
          expect(symbol.endsWith('dim'), `${mood} ${key} ${roman}`).toBe(false);
          expect(symbol.endsWith('maj7'), `${mood} ${key} ${roman}`).toBe(false);
        }
      }
    }
  });

  it('цвет 7 и add9 тоже остаются в поддерживаемом виде', () => {
    for (const key of keys) {
      for (const color of ['7', 'add9', 'sus']) {
        for (const roman of ['I', 'IV', 'V', 'i', 'vi']) {
          const symbol = symbolForRoman(key, roman, color);
          if (!symbol) continue;
          expect(symbol, `${key} ${roman} ${color}`).toMatch(SUPPORTED);
        }
      }
    }
  });
});
