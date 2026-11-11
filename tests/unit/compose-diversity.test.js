// Фаза 6 в API: варианты спеки и детерминированные мутации.
//
// Проверяем не только модули (это делает tests/unit/diversity.test.js),
// но и то, что маршруты отдают исполняемый код и не ломают валидность.

import { describe, it, expect } from 'vitest';
import { generateCandidateDetails } from '../../server/music/best-of.js';
import { specDistance, tooSimilar } from '../../server/music/diversity.js';
import { applyMutation, MUTATION_NAMES, mutateSpec } from '../../server/music/mutations.js';
import { checkSpec } from '../../server/music/spec/check.js';
import { compile } from '../../server/music/compiler/index.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

function goodSpec() {
  return {
    meta: { style: 'techno', bpm: 132, key: 'f:minor', seed: 42 },
    harmony: { progressionId: 'techno-minor-i-vi-iv-v', barsPerChord: 2 },
    form: [
      { kind: 'intro', bars: 8, energy: 0.25, roles: { hats: { recipe: 'sparse' }, bass: { recipe: 'sparse' } } },
      {
        kind: 'build',
        bars: 8,
        energy: 0.6,
        roles: { kick: { recipe: 'default' }, hats: { recipe: 'default' }, bass: { recipe: 'default' } },
        transition: { into: 'drop', type: 'riser' },
      },
      {
        kind: 'drop',
        bars: 16,
        energy: 1.0,
        roles: {
          kick: { recipe: 'busy' },
          snare: { recipe: 'busy' },
          hats: { recipe: 'busy' },
          bass: { recipe: 'busy' },
          arp: { recipe: 'busy' },
        },
      },
      { kind: 'outro', bars: 8, energy: 0.2, roles: { hats: { recipe: 'sparse' }, texture: { recipe: 'sparse' } } },
    ],
    motif: { degrees: [4, 2, 0, 2], rhythm: 'x ~ x x' },
  };
}

describe('фаза 6: кандидаты спеки', () => {
  it('даёт запрошенное число кандидатов, все валидны', () => {
    const candidates = generateCandidateDetails(goodSpec(), { count: 4, seed: 7 });
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) {
      expect(checkSpec(candidate.spec).ok).toBe(true);
    }
  });

  it('кандидаты попарно не слишком похожи', () => {
    const candidates = generateCandidateDetails(goodSpec(), { count: 4, seed: 7 });
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        expect(tooSimilar(candidates[i].spec, candidates[j].spec)).toBe(false);
      }
    }
  });

  it('детерминирован по зерну', () => {
    const a = generateCandidateDetails(goodSpec(), { count: 3, seed: 11 });
    const b = generateCandidateDetails(goodSpec(), { count: 3, seed: 11 });
    expect(a.map((c) => c.fingerprint)).toEqual(b.map((c) => c.fingerprint));
  });

  it('кандидаты компилируются и исполняются', async () => {
    const candidates = generateCandidateDetails(goodSpec(), { count: 3, seed: 5 });
    for (const candidate of candidates) {
      const code = compile(candidate.spec).code;
      const run = await runStrudel(code, { cycles: 16 });
      expect(run.ok).toBe(true);
      expect(run.order.length).toBeGreaterThan(2);
    }
  });
});

describe('фаза 6: мутации', () => {
  it('каждая мутация сохраняет валидность', () => {
    const spec = goodSpec();
    for (const name of MUTATION_NAMES) {
      const mutated = applyMutation(name, spec, 3);
      const check = checkSpec(mutated);
      expect(check.ok, `${name}: ${check.errors.join('; ')}`).toBe(true);
    }
  });

  it('мутация меняет спеку', () => {
    const spec = goodSpec();
    for (const name of MUTATION_NAMES) {
      const mutated = applyMutation(name, spec, 3);
      expect(specDistance(spec, mutated)).toBeGreaterThan(0);
    }
  });

  it('мутация не трогает исходную спеку', () => {
    const spec = goodSpec();
    const before = JSON.stringify(spec);
    mutateSpec(spec, 3);
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('мутация меняет гармонию — бас и аккорды идут по другой прогрессии', () => {
    const spec = goodSpec();
    const mutated = applyMutation('progression', spec, 3);
    expect(JSON.stringify(mutated.harmony)).not.toBe(JSON.stringify(spec.harmony));
    // Гармония остаётся в ладу.
    for (const d of mutated.harmony.degrees || []) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(6);
    }
  });

  it('транспозиция секции не выводит степени за пределы лада', () => {
    const spec = goodSpec();
    const mutated = applyMutation('transpose', spec, 5);
    const overrides = mutated.form.filter((s) => s.progressionOverride?.degrees);
    for (const section of overrides) {
      for (const d of section.progressionOverride.degrees) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(6);
      }
    }
  });
});
