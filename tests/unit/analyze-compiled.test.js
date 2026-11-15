// Анализатор должен видеть СКОМПИЛИРОВАННЫЙ трек (D-001).
//
// Компилятор выносит содержимое партии в константы и оставляет в строках
// партии только `arrange([8, P001_0], [8, P001_1])`. Анализатор, который
// не разбирает константы, находит ноль событий — и все десять критериев
// скора выдают мусор («плотность 0 атак на такт», «диапазон 0 полутонов»).

import { describe, it, expect } from 'vitest';

import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { analyzeTrack } from '../../server/music/features.js';
import { extractTrack } from '../../server/music/extract.js';
import { validateTrackSpec } from '../../src/schemas/track-spec.schema.js';

function spec(parts) {
  return validateTrackSpec({
    meta: { style: 'techno', key: 'Cmin', bpm: 120 },
    structure: {
      sections: [
        { name: 'intro', cycles: 8, energy: 0.4, harmony: 'Cm' },
        { name: 'drop', cycles: 8, energy: 0.9, harmony: 'Cm Gm' },
      ],
    },
    parts: { roles: parts },
  });
}

describe('разбор скомпилированного кода', () => {
  it('находит события в коде, собранном компилятором', () => {
    const code = compileTrackSpec(spec({
      kick: { activeIn: ['intro', 'drop'], pattern: 'bd*4', sound: 'bd' },
      bass: { activeIn: ['drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' },
    }));
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.partCount).toBe(2);
    expect(analysis.metrics.density).toBeGreaterThan(0);
    expect(analysis.metrics.scaleFit).not.toBeNull();
    expect(analysis.metrics.range).not.toBeNull();
  });

  it('плотность партии — среднее по секциям, а не сумма секций', () => {
    // Один такт по 4 атаки и девять тактов по 8 атак: среднее по треку =
    // (4*1 + 8*9) / 10 = 7.6 атак на такт. Сумма секций дала бы 76.
    const code = [
      'setCpm(120/4)',
      'const KICK_A = s("bd*4")',
      'const KICK_B = s("bd*8")',
      '$KICK: arrange([1, KICK_A], [9, KICK_B])._scope()',
    ].join('\n');
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.density).toBeCloseTo(7.6, 1);
  });

  it('роль партии читается из кода, а не угадывается по метке', () => {
    const code = compileTrackSpec(spec({
      VIOLIN_1: { role: 'violin', activeIn: ['drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' },
    }));
    const track = extractTrack(code);
    expect(track.parts[0].role).toBe('violin');
  });

  it('легаси-код без констант разбирается как раньше', () => {
    const analysis = analyzeTrack(['$KICK: s("bd*4")', '$BASS: n("0 ~ 2 ~")'].join('\n'));
    expect(analysis.metrics.density).toBe(6);
    expect(analysis.metrics.roles).toContain('drums');
  });
});
