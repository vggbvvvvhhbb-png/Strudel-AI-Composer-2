// Правила линтера Strudel (P2.2). Для каждого правила —
// минимум один положительный и один отрицательный случай.
// Плюс автофиксы и проверка, что правила не цепляются к живому коду проекта.

import { describe, it, expect } from 'vitest';
import {
  checkRules, applyFixes, splitParts, RULES,
  MEASURED_MODES, MEASURED_NAMES,
} from '../../src/core/rules.js';
import { PRESETS } from '../../src/presets/index.js';

const ids = (code) => checkRules(code).findings.map((f) => f.id);
const errorsOf = (code) => checkRules(code).errors;
const warningsOf = (code) => checkRules(code).warnings;

describe('реестр правил', () => {
  it('все восемь правил на месте и с уровнями', () => {
    expect(RULES.map((r) => r.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);
    for (const rule of RULES) {
      expect(['error', 'warn']).toContain(rule.level);
      expect(rule.title.length).toBeGreaterThan(0);
    }
  });

  it('splitParts находит партии и их строки', () => {
    const parts = splitParts('setCpm(120/4)\n$BASS: note("c1")\n$DRUMS: s("bd*4")');
    expect(parts.map((p) => p.label)).toEqual(['BASS', 'DRUMS']);
    expect(parts[0].startLine).toBe(2);
    expect(parts[1].startLine).toBe(3);
  });
});

describe('R1 — написание лада', () => {
  it('ловит пробел в названии лада', () => {
    const res = checkRules('$MEL: n("0 2 4").scale("A harmonic minor")');
    expect(res.errors.map((e) => e.id)).toContain('R1');
    expect(res.errors[0].message).toMatch(/двоеточи/);
  });

  it('ловит подчёркивание в названии лада', () => {
    expect(ids('$MEL: n("0 2 4").scale("A:harmonic_minor")')).toContain('R1');
  });

  it('ловит неполное название лада', () => {
    expect(ids('$MEL: n("0 2 4").scale("A:harmonic")')).toContain('R1');
  });

  it('не цепляется к измеренно правильному ладу', () => {
    expect(ids('$MEL: n("0 2 4").scale("A:harmonic:minor")')).not.toContain('R1');
    expect(ids('$MEL: n("0 2 4").scale("c:minor:pentatonic")')).not.toContain('R1');
    expect(ids('$MEL: n("0 2 4").scale("a:mixolydian")')).not.toContain('R1');
  });

  it('автофикс приводит название к рабочему', () => {
    const { code, applied } = applyFixes(
      '$MEL: n("0 2 4").scale("A harmonic minor")',
      checkRules('$MEL: n("0 2 4").scale("A harmonic minor")').findings,
    );
    expect(code).toContain('.scale("A:harmonic:minor")');
    expect(applied.map((a) => a.id)).toEqual(['R1']);
    expect(ids(code)).not.toContain('R1');
  });

  it('автофикс чинит подчёркивание и слитное написание', () => {
    for (const [bad, good] of [['A:harmonic_minor', 'A:harmonic:minor'], ['A:harmonicminor', 'A:harmonic:minor']]) {
      const code = `$MEL: n("0 2 4").scale("${bad}")`;
      const fixed = applyFixes(code, checkRules(code).findings).code;
      expect(fixed).toContain(`.scale("${good}")`);
    }
  });
});

describe('R2 — аккорд без .voicing()', () => {
  it('ловит chord() без .voicing()', () => {
    const res = checkRules('$CHORDS: chord("Am").slow(2)');
    expect(res.errors.map((e) => e.id)).toContain('R2');
    expect(res.errors[0].message).toMatch(/voicing/);
  });

  it('ловит неизвестное написание аккорда', () => {
    const res = checkRules('$CHORDS: chord("Fmaj7").voicing()');
    expect(res.errors.map((e) => e.id)).toContain('R2');
    expect(res.errors[0].message).toMatch(/FM7|рабочее написание/i);
  });

  it('ловит написание с двоеточием', () => {
    expect(ids('$CHORDS: chord("A:min").voicing()')).toContain('R2');
  });

  it('не цепляется к аккорду с .voicing()', () => {
    expect(ids('$CHORDS: chord("Am").voicing().slow(2)')).not.toContain('R2');
    expect(ids('$CHORDS: chord("F^7").voicing()')).not.toContain('R2');
    expect(ids('$CHORDS: chord("FM7").voicing()')).not.toContain('R2');
  });

  it('автофикс добавляет .voicing()', () => {
    const code = '$CHORDS: chord("Am").slow(2)';
    const fixed = applyFixes(code, checkRules(code).findings).code;
    expect(fixed).toContain('chord("Am").voicing()');
    expect(ids(fixed)).not.toContain('R2');
  });

  it('автофикс чинит написание аккорда', () => {
    const code = '$CHORDS: chord("Fmaj7").voicing()';
    const fixed = applyFixes(code, checkRules(code).findings).code;
    expect(fixed).toContain('chord("FM7")');
  });

  it('ловит chord() со списком нот: партия остаётся без высот', () => {
    const res = checkRules('$CHORDS: chord("<a3 c4 e4> <f3 a3 c4>")');
    expect(res.errors.map((e) => e.id)).toContain('R2');
    expect(res.errors[0].message).toMatch(/note\(\)|скобках/);
  });

  it('автофикс списка нот переводит в note() с одновременными нотами', () => {
    const code = '$CHORDS: chord("<a3 c4 e4> <f3 a3 c4>")';
    const fixed = applyFixes(code, checkRules(code).findings).code;
    expect(fixed).toContain('note("<[a3,c4,e4] [f3,a3,c4]>")');
    expect(ids(fixed)).not.toContain('R2');
  });

  it('НЕ ругается на последовательность символов аккордов (D-161)', () => {
    // Замер: chord("<Cm Ab>").voicing() → 9 событий, 9 нот; движок понимает.
    expect(ids('$CHORDS: chord("<Cm Ab>").voicing()')).not.toContain('R2');
    expect(ids('$CHORDS: chord("<Am7 FM7 CM7 G6>").voicing()')).not.toContain('R2');
    expect(ids('$CHORDS: chord("Cm").voicing()')).not.toContain('R2');
  });
});

describe('R3 — регистр имени функции', () => {
  it('ловит duckOrBit', () => {
    const res = checkRules('$KICK: s("bd*4").duckOrBit(2)');
    expect(res.errors.map((e) => e.id)).toContain('R3');
    expect(res.errors[0].message).toMatch(/duckorbit/);
  });

  it('ловит duckAttack с заглавной', () => {
    expect(ids('$KICK: s("bd*4").duckorbit(2).duckAttack(0.2)')).toContain('R3');
  });

  it('не цепляется к правильному регистру', () => {
    expect(ids('$KICK: s("bd*4").duckorbit(2).duckattack(0.2).duckdepth(1)')).not.toContain('R3');
  });

  it('не судит о незнакомых именах вне списка', () => {
    expect(ids('$KICK: s("bd*4").someUnknownMethod(2)')).not.toContain('R3');
  });

  it('автофикс приводит имя к измеренному', () => {
    const code = '$KICK: s("bd*4").duckOrBit(2)';
    const fixed = applyFixes(code, checkRules(code).findings).code;
    expect(fixed).toContain('.duckorbit(2)');
    expect(ids(fixed)).not.toContain('R3');
  });
});

describe('R4 — duck приглушает сам себя', () => {
  it('ловит .orbit(N) вместе с .duckorbit(N) в одной партии', () => {
    const res = checkRules('$KICK: s("bd*4").orbit(2).duckorbit(2).duckattack(0.2)');
    expect(warningsOf('$KICK: s("bd*4").orbit(2).duckorbit(2).duckattack(0.2)').map((w) => w.id)).toContain('R4');
    expect(res.warnings[0].level).toBe('warn');
  });

  it('не ловит разные орбиты', () => {
    expect(ids('$KICK: s("bd*4").orbit(1).duckorbit(2)')).not.toContain('R4');
  });
});

describe('R5 — слишком короткий duckattack', () => {
  it('ловит duckattack меньше 0.01', () => {
    expect(warningsOf('$KICK: s("bd*4").duckorbit(2).duckattack(0.001)').map((w) => w.id)).toContain('R5');
  });

  it('не ловит обычный возврат', () => {
    expect(ids('$KICK: s("bd*4").duckorbit(2).duckattack(0.2)')).not.toContain('R5');
  });
});

describe('R6 — сигнал без .seg()', () => {
  it('ловит сигнал в фильтре', () => {
    const res = warningsOf('$MEL: note("c4").lpf(sine.range(200,2000))');
    expect(res.map((w) => w.id)).toContain('R6');
    expect(res[0].message).toMatch(/seg/);
  });

  it('не ловит сигнал с .seg()', () => {
    expect(ids('$MEL: note("c4").lpf(sine.range(200,2000)).seg(16)')).not.toContain('R6');
  });

  it('не ловит обычное число в фильтре', () => {
    expect(ids('$MEL: note("c4").lpf(1200)')).not.toContain('R6');
  });
});

describe('R7 — duck без жертвы на орбите', () => {
  it('ловит duckorbit без партии на орбите', () => {
    const res = warningsOf('$KICK: s("bd*4").duckorbit(2).duckattack(0.2)');
    expect(res.map((w) => w.id)).toContain('R7');
    expect(res[0].message).toMatch(/orbit/);
  });

  it('не ловит duckorbit при наличии жертвы', () => {
    const code = '$KICK: s("bd*4").duckorbit(2).duckattack(0.2)\n$BASS: note("c2").s("sine").orbit(2)';
    expect(ids(code)).not.toContain('R7');
  });
});

describe('R8 — колебательный сигнал вместо рампы', () => {
  it('ловит быстрый sine.range в фильтре', () => {
    const res = warningsOf('$MEL: note("c4").s("sawtooth").lpf(sine.range(200,4000))');
    expect(res.map((w) => w.id)).toContain('R8');
    expect(res.find((w) => w.id === 'R8').message).toMatch(/time\.range/);
  });

  it('ловит perlin.range в фильтре', () => {
    expect(ids('$MEL: note("c4").s("sawtooth").lpf(perlin.range(300,4000))')).toContain('R8');
  });

  it('не ловит настоящий рамп time.range', () => {
    expect(ids('$MEL: note("c4").s("sawtooth").lpf(time.range(200,4000))')).not.toContain('R8');
  });

  it('не ловит осознанно замедленный сигнал .slow()', () => {
    expect(ids('$MEL: note("c4").s("sawtooth").lpf(sine.slow(8).range(200,4000)).seg(16)')).not.toContain('R8');
  });

  it('не ловит обычное число в фильтре', () => {
    expect(ids('$MEL: note("c4").lpf(1200)')).not.toContain('R8');
  });

  it('не ловит сигнал в gain (там колебание — законный приём)', () => {
    expect(ids('$MEL: note("c4").gain(sine.range(0.2,0.8))')).not.toContain('R8');
  });
});

describe('правила не ломают живой код проекта', () => {
  it('пресеты студии проходят без ошибок', () => {
    for (const preset of PRESETS) {
      const res = errorsOf(preset.code);
      expect(res, `${preset.name}: ${res.map((e) => e.message).join('; ')}`).toEqual([]);
    }
  });

  it('измеренные лады и имена не пусты', () => {
    expect(MEASURED_MODES.size).toBeGreaterThan(8);
    expect(MEASURED_NAMES.has('duckorbit')).toBe(true);
    expect(MEASURED_NAMES.has('voicing')).toBe(true);
  });
});
