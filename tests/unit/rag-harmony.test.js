// Фаза B: машинно-проверяемые правила гармонии (D-135).

import { describe, it, expect } from 'vitest';
import {
  HARMONY_RULES, validateHarmonyRules, functionOfDegree,
  isAllowedTransition, cadenceType, strudelScaleName, MODE_INTERVALS,
} from '../../server/rag/harmony.js';

describe('правила гармонии', () => {
  it('самопроверка правил зелёная (покрытие 7 ступеней, графы целы)', () => {
    const r = validateHarmonyRules();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('сломанные правила ловятся: пересечение функций и битая каденция', () => {
    const broken = {
      ...HARMONY_RULES,
      functions: { ...HARMONY_RULES.functions, major: { T: [0, 2, 5, 5], S: [1, 3], D: [4, 6] } },
      cadences: { ...HARMONY_RULES.cadences, authentic: ['D'] },
    };
    const r = validateHarmonyRules(broken);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('в двух функциях'))).toBe(true);
    expect(r.errors.some((e) => e.includes('аутентичная') || e.includes('authentic'))).toBe(true);
  });

  it('функции ступеней: классическая раскладка в major и minor', () => {
    expect(functionOfDegree(0, 'major')).toBe('T');
    expect(functionOfDegree(1, 'major')).toBe('S');
    expect(functionOfDegree(4, 'major')).toBe('D');
    expect(functionOfDegree(5, 'minor')).toBe('T');
    expect(functionOfDegree(6, 'minor')).toBe('D');
    expect(functionOfDegree(7, 'major')).toBeNull();
    expect(functionOfDegree(0, 'klingon')).toBeNull();
  });

  it('переходы: V→I разрешён, V→ii запрещён (D→S нет в графе)', () => {
    expect(isAllowedTransition(4, 0, 'major')).toBe(true);   // V→I
    expect(isAllowedTransition(4, 5, 'major')).toBe(true);   // V→vi прерванный (T)
    expect(isAllowedTransition(1, 4, 'major')).toBe(true);   // ii→V
    expect(isAllowedTransition(4, 1, 'major')).toBe(false);  // V→ii
    expect(isAllowedTransition(0, 3, 'major')).toBe(true);   // I→IV
  });

  it('каденции распознаются по функциям последних аккордов', () => {
    expect(cadenceType(4, 0, 'major')).toBe('authentic');
    expect(cadenceType(3, 4, 'major')).toBe('half');
    expect(cadenceType(3, 0, 'major')).toBe('plagal');
    expect(cadenceType(0, 0, 'major')).toBeNull();
  });

  it('имя лада для Strudel: harmonic-minor через scale() не работает (замер) → null', () => {
    expect(strudelScaleName('c', 'minor')).toBe('c:minor');
    expect(strudelScaleName('a', 'harmonic-minor')).toBeNull();
  });

  it('интервалы ладов согласованы со Strudel (c:minor = C D Eb F G Ab Bb)', () => {
    expect(MODE_INTERVALS.minor).toEqual([0, 2, 3, 5, 7, 8, 10]);
    expect(MODE_INTERVALS.dorian).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(MODE_INTERVALS['harmonic-minor']).toEqual([0, 2, 3, 5, 7, 8, 11]);
  });

  it('замены ссылаются на существующие лады и функции', () => {
    for (const sub of HARMONY_RULES.substitutions) {
      expect(['T', 'S', 'D']).toContain(sub.fromFunction);
      expect(['T', 'S', 'D']).toContain(sub.toFunction);
      for (const mode of sub.allowedModes) expect(HARMONY_RULES.functions[mode]).toBeDefined();
    }
    const tritone = HARMONY_RULES.substitutions.find((s) => s.id === 'tritone-sub');
    expect(tritone.rootShiftSemis).toBe(6);
  });
});