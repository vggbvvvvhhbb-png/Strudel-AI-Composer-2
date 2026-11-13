// Фаза 6: разнообразие на уровне спеки (best-of-N без LLM).
//
// Проверяем три вещи:
//   • спека после мутации остаётся валидной (checkSpec → ok) — property-тест
//     по всем стилям и формам библиотеки знаний;
//   • углы дают структурно ДРУГИЕ валидные спеки;
//   • кандидаты не повторяются, детерминированы по зерну и реально
//     исполняются движком Strudel.

import { describe, it, expect } from 'vitest';
import { checkSpec } from '../../server/music/spec/check.js';
import { formsForStyle } from '../../server/music/knowledge/index.js';
import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';
import { detectSpecStyle, fallbackSpec } from '../../server/music/compose/pipeline.js';
import { compile } from '../../server/music/compiler/index.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';
import {
  MIN_DISTANCE,
  distanceBreakdown,
  sameSpec,
  specDistance,
  specFingerprint,
  specFingerprintParts,
  tooSimilar,
} from '../../server/music/diversity.js';
import { ANGLE_NAMES, applyAngle } from '../../server/music/angles.js';
import { MUTATION_NAMES, applyMutation } from '../../server/music/mutations.js';
import { generateCandidateDetails, generateCandidates } from '../../server/music/best-of.js';

const STYLES = TrackSpecSchema.shape.meta.shape.style.options;
const knowledgeStyle = (style) => style === 'lo-fi' ? 'lofi' : style === 'dubstep' ? 'trap' : style;

/** Канонический запасной план использует те же формы, что приложение. */
function librarySpec(style, formIndex = 0) {
  return fallbackSpec(detectSpecStyle(style), formIndex);
}

/** Рукописная спека — чтобы property-тест не зависел только от библиотеки. */
const MANUAL_SPEC = {
  meta: { style: 'techno', bpm: 128, key: 'Cmin' },
  structure: { sections: [
    { name: 'intro', cycles: 8, energy: 0.3, harmony: 'Cm Ab Fm Gm' },
    { name: 'build', cycles: 16, energy: 0.65, harmony: 'Fm Cm Ab Gm' },
    { name: 'drop', cycles: 16, energy: 1, harmony: 'Cm Ab Fm Gm' },
    { name: 'outro', cycles: 8, energy: 0.2, harmony: 'Ab Fm Gm Cm' },
  ] },
  parts: { roles: {
    kick: { activeIn: ['intro', 'build', 'drop', 'outro'], pattern: 'bd*4', sound: 's' },
    snare: { activeIn: ['drop'], pattern: '~ sd ~ sd', sound: 's' },
    hats: { activeIn: ['build', 'drop'], pattern: 'hh*8', sound: 's' },
    bass: { activeIn: ['intro', 'build', 'drop'], pattern: '0 ~ 2 4', sound: 'sawtooth' },
    arp: { activeIn: ['drop'], pattern: '0 2 4 6', sound: 'triangle' },
    lead: { activeIn: ['drop'], pattern: '4 ~ 2 0', sound: 'sine' },
  } },
};

describe('фаза 6: отпечаток спеки', () => {
  it('одинаковые спеки дают одинаковый отпечаток', () => {
    const a = librarySpec('techno');
    const b = librarySpec('techno');
    expect(specFingerprint(a)).toBe(specFingerprint(b));
    expect(specFingerprint(a)).toMatch(/^fp-/);
  });

  it('разные спеки дают разные отпечатки', () => {
    expect(specFingerprint(librarySpec('techno'))).not.toBe(specFingerprint(librarySpec('lo-fi')));
  });

  it('отпечаток зависит от формы, строковой гармонии и рисунков ролей', () => {
    const base = librarySpec('techno');
    const parts = specFingerprintParts(base);
    expect(parts.form).toContain('drop');
    expect(checkSpec(base).ok).toBe(true);
    expect(parts.harmony).toContain(base.structure.sections[0].harmony);
    expect(parts.recipes).toContain(`kick=${base.parts.roles.kick.pattern}`);

    // Смена формы меняет отпечаток.
    const other = librarySpec('techno', 1);
    expect(specFingerprint(other)).not.toBe(specFingerprint(base));

    // Смена рисунка партии меняет отпечаток.
    const withRecipe = JSON.parse(JSON.stringify(base));
    withRecipe.parts.roles.kick.pattern = 'bd*8';
    expect(specFingerprint(withRecipe)).not.toBe(specFingerprint(base));
  });
});

describe('фаза 6: расстояние между спеками', () => {
  it('одинаковые спеки: расстояние 0', () => {
    const spec = librarySpec('house');
    expect(specDistance(spec, spec)).toBe(0);
    expect(specDistance(spec, JSON.parse(JSON.stringify(spec)))).toBe(0);
  });

  it('разные спеки: расстояние больше нуля и в диапазоне 0..1', () => {
    for (const style of STYLES) {
      const a = librarySpec(style);
      const b = librarySpec(style === 'lo-fi' ? 'techno' : 'lo-fi');
      const distance = specDistance(a, b);
      expect(distance, style).toBeGreaterThan(0);
      expect(distance, style).toBeLessThanOrEqual(1);
    }
  });

  it('расстояние симметрично', () => {
    const a = librarySpec('techno');
    const b = librarySpec('jazz');
    expect(specDistance(a, b)).toBeCloseTo(specDistance(b, a), 10);
  });

  it('чем больше различие, тем больше расстояние', () => {
    const base = librarySpec('techno');

    const oneRecipe = JSON.parse(JSON.stringify(base));
    oneRecipe.parts.roles.kick.pattern = 'bd*8';

    const otherProgression = JSON.parse(JSON.stringify(base));
    otherProgression.structure.sections.forEach((section) => { section.harmony = 'Cm Db Cm Db'; });

    const otherForm = librarySpec('techno', 1);

    const near = specDistance(base, oneRecipe);
    const mid = specDistance(base, otherProgression);
    const far = specDistance(base, otherForm);
    expect(near).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(near);
    expect(far).toBeGreaterThan(near);
  });

  it('разложение расстояния объясняет, чем именно различаются спеки', () => {
    const base = librarySpec('techno');
    const other = JSON.parse(JSON.stringify(base));
    other.structure.sections.forEach((section) => { section.harmony = 'Cm Db Cm Db'; });
    const parts = distanceBreakdown(base, other);
    expect(parts.harmony).toBeGreaterThan(0);
    expect(parts.form).toBe(0);
    expect(parts.total).toBeCloseTo(specDistance(base, other), 10);
  });

  it('одноимённые секции различаются позицией, а не схлопываются по имени', () => {
    const base = librarySpec('techno');
    const drops = base.structure.sections.map((section, index) => section.name === 'drop' ? index : -1)
      .filter((index) => index >= 0);
    expect(drops).toHaveLength(2);
    const other = JSON.parse(JSON.stringify(base));
    other.structure.sections[drops[1]].harmony = 'Cm Db Cm Db';
    expect(other.structure.sections[drops[0]]).toEqual(base.structure.sections[drops[0]]);
    expect(checkSpec(other).ok).toBe(true);
    expect(specFingerprint(other)).not.toBe(specFingerprint(base));
    const parts = distanceBreakdown(base, other);
    expect(parts.harmony).toBeGreaterThan(0);
    expect(parts.form).toBe(0);
    expect(parts.roles).toBe(0);
    expect(parts.total).toBeGreaterThan(0);
  });

  it('порог отсечения отличает «тот же трек» от другого', () => {
    const base = librarySpec('techno');
    const near = JSON.parse(JSON.stringify(base));
    near.parts.roles.kick.pattern = 'bd*8';
    expect(tooSimilar(base, near)).toBe(true);

    const other = JSON.parse(JSON.stringify(base));
    other.structure.sections.forEach((section) => { section.harmony = 'Cm Db Cm Db'; });
    expect(tooSimilar(base, other)).toBe(false);
  });
});

describe('фаза 6: углы дают структурно другой вариант', () => {
  it.each(STYLES)('стиль %s: каждый угол даёт валидную и отличную спеку', (style) => {
    const spec = librarySpec(style);
    for (const angle of ANGLE_NAMES) {
      const result = applyAngle(spec, angle, 3);
      const checked = checkSpec(result);
      expect(checked.ok, `${style}/${angle}: ${checked.errors.join('; ')}`).toBe(true);
      expect(result).toEqual(checked.spec);
      expect(sameSpec(checked.spec, spec), `${style}/${angle}: каноническая спека не изменилась`).toBe(false);
    }
  });

  it('углы дают не одинаковые спеки', () => {
    const spec = librarySpec('techno');
    const results = ANGLE_NAMES.map((angle) => applyAngle(spec, angle, 3));
    const distinct = new Set(results.map((spec2) => specFingerprint(spec2)));
    // Отпечаток покрывает форму, прогрессию и рецепты — этого мало,
    // чтобы поймать различия мотива и энергии, поэтому сравниваем целиком.
    const whole = new Set(results.map((spec2) => JSON.stringify(spec2)));
    expect(whole.size).toBeGreaterThanOrEqual(3);
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });

  it('ручная спека тоже проходит через углы без потери валидности', () => {
    for (const angle of ANGLE_NAMES) {
      const result = applyAngle(MANUAL_SPEC, angle, 5);
      const checked = checkSpec(result);
      expect(checked.ok, `${angle}: ${checked.errors.join('; ')}`).toBe(true);
      expect(result).toEqual(checked.spec);
      expect(sameSpec(checked.spec, MANUAL_SPEC)).toBe(false);
    }
  });
});

describe('фаза 6: мутации без LLM', () => {
  it('есть не меньше четырёх мутаций', () => {
    expect(MUTATION_NAMES.length).toBeGreaterThanOrEqual(4);
  });

  it.each(STYLES)('стиль %s: мутация меняет спеку и сохраняет валидность', (style) => {
    const spec = librarySpec(style);
    for (const mutation of MUTATION_NAMES) {
      const result = applyMutation(mutation, spec, 5);
      const checked = checkSpec(result);
      expect(checked.ok, `${style}/${mutation}: ${checked.errors.join('; ')}`).toBe(true);
      expect(sameSpec(result, spec), `${style}/${mutation}: спека не изменилась`).toBe(false);
    }
  });

  it.each(STYLES)('стиль %s: property — любая валидная спека остаётся валидной после мутации', (style) => {
    const forms = formsForStyle(knowledgeStyle(style));
    expect(forms.length).toBeGreaterThan(0);
    for (let formIndex = 0; formIndex < forms.length; formIndex += 1) {
      const base = librarySpec(style, formIndex);
      const checkedBase = checkSpec(base);
      expect(checkedBase.ok, `${style}#${formIndex}: ${checkedBase.errors.join('; ')}`).toBe(true);

      for (const mutation of MUTATION_NAMES) {
        for (const seed of [0, 1, 17, 2024]) {
          const result = applyMutation(mutation, base, seed);
          const checked = checkSpec(result);
          expect(checked.ok, `${style}#${formIndex}/${mutation}/${seed}: ${checked.errors.join('; ')}`).toBe(true);
        }
      }
    }
  });

  it('property — мутации сохраняют валидность и на ручной спеке', () => {
    expect(checkSpec(MANUAL_SPEC).ok).toBe(true);
    for (const mutation of MUTATION_NAMES) {
      for (const seed of [0, 5, 99]) {
        const result = applyMutation(mutation, MANUAL_SPEC, seed);
        const checked = checkSpec(result);
        expect(checked.ok, `${mutation}/${seed}: ${checked.errors.join('; ')}`).toBe(true);
        expect(sameSpec(result, MANUAL_SPEC)).toBe(false);
      }
    }
  });

  it('мутации детерминированы по зерну', () => {
    const spec = librarySpec('techno');
    for (const mutation of MUTATION_NAMES) {
      const a = applyMutation(mutation, spec, 12);
      const b = applyMutation(mutation, spec, 12);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('разные зёрна дают разные мутации', () => {
    const spec = librarySpec('techno');
    const a = applyMutation('recipe', spec, 1);
    const b = applyMutation('recipe', spec, 2);
    expect(sameSpec(a, b)).toBe(false);
  });
});

describe('фаза 6: кандидаты best-of-N', () => {
  it.each(STYLES)('стиль %s: кандидатов ровно столько, сколько просили', (style) => {
    const spec = librarySpec(style);
    const candidates = generateCandidates(spec, { count: 4, seed: 11 });
    expect(candidates.length).toBe(4);
    for (const candidate of candidates) {
      const checked = checkSpec(candidate);
      expect(checked.ok, checked.errors.join('; ')).toBe(true);
      expect(sameSpec(candidate, spec)).toBe(false);
    }
  });

  it.each(STYLES)('стиль %s: кандидаты попарно не слишком похожи', (style) => {
    const spec = librarySpec(style);
    const candidates = generateCandidates(spec, { count: 4, seed: 11 });
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const distance = specDistance(candidates[i], candidates[j]);
        expect(distance, `${style}: ${i}↔${j}`).toBeGreaterThanOrEqual(MIN_DISTANCE);
      }
    }
  });

  it('кандидаты не повторяются: отпечатки разные', () => {
    const spec = librarySpec('techno');
    const details = generateCandidateDetails(spec, { count: 6, seed: 3 });
    const fingerprints = details.map((item) => item.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('генерация детерминирована по зерну', () => {
    const spec = librarySpec('house');
    const a = generateCandidates(spec, { count: 4, seed: 21 });
    const b = generateCandidates(spec, { count: 4, seed: 21 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('разные зёрна дают разные наборы кандидатов', () => {
    const spec = librarySpec('house');
    const a = generateCandidates(spec, { count: 4, seed: 21 });
    const b = generateCandidates(spec, { count: 4, seed: 22 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('подробные детали содержат угол и расстояние', () => {
    const spec = librarySpec('techno');
    const details = generateCandidateDetails(spec, { count: 4, seed: 11 });
    expect(details.length).toBe(4);
    for (const item of details) {
      expect(ANGLE_NAMES).toContain(item.angle);
      expect(item.distance).toBeGreaterThanOrEqual(MIN_DISTANCE);
      expect(item.fingerprint).toMatch(/^fp-/);
    }
  });

  it('кандидаты компилируются и исполняются движком', async () => {
    const spec = librarySpec('techno');
    const candidates = generateCandidates(spec, { count: 3, seed: 7 });
    for (const candidate of candidates) {
      const { code } = compile(candidate);
      const result = await runStrudel(code, { cycles: 32 });
      expect(result.ok, result.error).toBe(true);
      expect(Object.keys(result.parts).length).toBeGreaterThan(2);
    }
  });

  it('кандидат из другого стиля тоже исполняется', async () => {
    const spec = librarySpec('jazz');
    const candidates = generateCandidates(spec, { count: 2, seed: 4 });
    for (const candidate of candidates) {
      const { code } = compile(candidate);
      const result = await runStrudel(code, { cycles: 32 });
      expect(result.ok, result.error).toBe(true);
    }
  });
});
