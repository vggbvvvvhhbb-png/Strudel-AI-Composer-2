// Фаза 6 в API: варианты спеки и детерминированные мутации.
//
// Проверяем не только модули (это делает tests/unit/diversity.test.js),
// но и то, что маршруты отдают исполняемый код и не ломают валидность.

import { describe, it, expect } from 'vitest';
import { generateCandidateDetails, pickBest } from '../../server/music/best-of.js';
import { specDistance, tooSimilar } from '../../server/music/diversity.js';
import { applyMutation, MUTATION_NAMES, mutateSpec } from '../../server/music/mutations.js';
import { checkSpec, progressionForSection } from '../../server/music/spec/check.js';
import { compile, compileTrackSpec } from '../../server/music/compiler/index.js';
import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

function goodSpec() {
  return {
    meta: { style: 'techno', bpm: 132, key: 'Fmin' },
    structure: { sections: [
      { name: 'intro', cycles: 8, energy: 0.25, harmony: 'Fm Db Bbm Cm' },
      { name: 'build', cycles: 8, energy: 0.6, harmony: 'Bbm Fm Db Cm' },
      { name: 'drop', cycles: 16, energy: 1, harmony: 'Fm Db Bbm Cm' },
      { name: 'outro', cycles: 8, energy: 0.2, harmony: 'Db Bbm Cm Fm' },
    ] },
    parts: { roles: {
      kick: { activeIn: ['build', 'drop'], pattern: 'bd*4', sound: 's' },
      snare: { activeIn: ['drop'], pattern: '~ sd ~ sd', sound: 's' },
      hats: { activeIn: ['intro', 'build', 'drop', 'outro'], pattern: 'hh*8', sound: 's' },
      bass: { activeIn: ['intro', 'build', 'drop'], pattern: '0 ~ 2 4', sound: 'sawtooth' },
      arp: { activeIn: ['drop'], pattern: '0 2 4 6', sound: 'triangle' },
      texture: { activeIn: ['outro'], pattern: '0 ~ ~ ~', sound: 'sine' },
    } },
  };
}
describe('канонический контракт компиляции', () => {
  it('повторное имя активирует партию в обеих секциях, но не между ними', async () => {
    const spec = goodSpec();
    spec.structure.sections = [
      { name: 'intro', cycles: 4, energy: 0.2, harmony: 'Fm Db Bbm Cm' },
      { name: 'drop', cycles: 4, energy: 1, harmony: 'Fm Db Bbm Cm' },
      { name: 'breakdown', cycles: 4, energy: 0.3, harmony: 'Bbm Db Cm Fm' },
      { name: 'drop', cycles: 8, energy: 0.9, harmony: 'Db Bbm Cm Fm' },
      { name: 'outro', cycles: 4, energy: 0.2, harmony: 'Fm Db Bbm Cm' },
    ];
    spec.parts.roles = {
      kick: { activeIn: ['drop'], pattern: 'bd*4', sound: 's' },
      pad: { activeIn: ['intro', 'breakdown', 'outro'], pattern: '0,2,4', sound: 'sine' },
    };
    const before = JSON.parse(JSON.stringify(spec));
    expect(TrackSpecSchema.safeParse(spec).success).toBe(true);
    const checked = checkSpec(spec);
    expect(checked.ok, checked.errors.join('; ')).toBe(true);
    const code = compileTrackSpec(spec);
    expect(typeof code).toBe('string');
    expect(compileTrackSpec(spec)).toBe(code);
    const compiled = compile(spec);
    expect(compiled).toEqual({
      code,
      parts: expect.any(Array), sections: expect.any(Array),
      warnings: expect.any(Array), trace: expect.any(Array),
    });
    expect(compiled.sections.map((section) => [section.kind, section.bars, section.startBar, section.endBar]))
      .toEqual([['intro', 4, 0, 4], ['drop', 4, 4, 8], ['breakdown', 4, 8, 12], ['drop', 8, 12, 20], ['outro', 4, 20, 24]]);
    expect(compiled.sections.map((section) => section.roles.includes('kick')))
      .toEqual([false, true, false, true, false]);
    const run = await runStrudel(code, { cycles: 24 });
    expect(run.ok, run.error).toBe(true);
    const kick = run.parts.KICK;
    expect(kick).toBeDefined();
    const onsetsIn = (start, end) => kick.filter((event) => event.whole.begin >= start && event.whole.begin < end);
    expect(onsetsIn(4, 8)).toHaveLength(16);
    expect(onsetsIn(12, 20)).toHaveLength(32);
    expect(onsetsIn(0, 4)).toHaveLength(0);
    expect(onsetsIn(8, 12)).toHaveLength(0);
    expect(onsetsIn(20, 24)).toHaveLength(0);
    expect(spec).toEqual(before);
  });
});

describe('фаза 6: кандидаты спеки', () => {
  it('даёт запрошенное число кандидатов, все валидны', () => {
    const candidates = generateCandidateDetails(goodSpec(), { count: 4, seed: 7 });
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) {
      expect(checkSpec(candidate.spec).ok).toBe(true);
      expect(candidate.spec).toEqual(TrackSpecSchema.parse(candidate.spec));
      expect(candidate.fingerprint).toMatch(/^fp-/);
      expect(candidate.distance).toBeGreaterThan(0);
      expect(typeof candidate.angle).toBe('string');
      expect(candidate.mutation === null || MUTATION_NAMES.includes(candidate.mutation)).toBe(true);
    }
  });

  it('выбор лучшего использует оценки, а не порядок кандидатов', () => {
    const candidates = generateCandidateDetails(goodSpec(), { count: 3, seed: 7 });
    expect(candidates).toHaveLength(3);
    const specs = candidates.map((candidate) => candidate.spec);
    const before = JSON.parse(JSON.stringify(specs));
    expect(pickBest(specs, (_, index) => [63, 91, 72][index])).toBe(specs[1]);
    expect(pickBest(specs, (_, index) => [NaN, 0, -1][index])).toBe(specs[1]);
    expect(pickBest([], () => 100)).toBeNull();
    expect(specs).toEqual(before);
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
  it('все мутации и сравнение выдерживают повторяющиеся имена секций', () => {
    const spec = goodSpec();
    spec.structure.sections.splice(3, 0, {
      name: 'drop', cycles: 8, energy: 0.8, harmony: 'Db Bbm Cm Fm',
    });
    const before = structuredClone(spec);
    const code = compileTrackSpec(spec);
    for (const name of MUTATION_NAMES) {
      const mutated = applyMutation(name, spec, 5);
      expect(checkSpec(mutated).ok, name).toBe(true);
      expect(typeof compileTrackSpec(mutated), name).toBe('string');
      expect(Number.isFinite(specDistance(spec, mutated)), name).toBe(true);
      expect(spec, name).toEqual(before);
    }
    const shifted = structuredClone(spec);
    shifted.structure.sections[3].harmony = 'Fm Db Bbm Cm';
    expect(specDistance(spec, shifted)).toBeGreaterThan(0);
    expect(compileTrackSpec(shifted)).not.toBe(code);
  });

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

  it('все мутации и их результаты не меняют вложенные данные исходной спеки', () => {
    for (const name of [...MUTATION_NAMES, 'auto']) {
      const spec = goodSpec();
      const before = JSON.parse(JSON.stringify(spec));
      const mutated = name === 'auto' ? mutateSpec(spec, 3).spec : applyMutation(name, spec, 3);
      expect(spec, name).toEqual(before);
      expect(mutated, name).not.toBe(spec);
      expect(checkSpec(mutated).ok, name).toBe(true);
      // Ловим также неглубокую копию: правка результата не должна затронуть вход.
      mutated.structure.sections[0].harmony = 'Cm';
      mutated.parts.roles.bass.activeIn.push('outro');
      mutated.parts.roles.bass.pattern = '6 ~';
      expect(spec, `${name}: результат разделяет вложенные данные с входом`).toEqual(before);
    }
  });

  it('мутация меняет гармонию — бас и аккорды идут по другой прогрессии', () => {
    const spec = goodSpec();
    const mutated = applyMutation('progression', spec, 3);
    const before = spec.structure.sections.map((section) => section.harmony);
    const after = mutated.structure.sections.map((section) => section.harmony);
    expect(after).not.toEqual(before);
    expect(checkSpec(mutated).ok).toBe(true);
    expect(compileTrackSpec(mutated)).not.toBe(compileTrackSpec(spec));
    // Перестановка аккордов не добавляет чужих высот; пустой цикл не пройдёт.
    for (let index = 0; index < after.length; index += 1) {
      expect(typeof progressionForSection(mutated, index)).toBe('string');
      expect(progressionForSection(mutated, index)).toBe(after[index]);
      expect(after[index].split(/\s+/).sort()).toEqual(before[index].split(/\s+/).sort());
    }
  });

  it('нераспознаваемая гармония сохраняется без выдуманных объектных прогрессий', () => {
    const spec = goodSpec();
    spec.structure.sections.forEach((section) => { section.harmony = 'педальная гармония'; });
    const before = JSON.parse(JSON.stringify(spec));
    for (const name of ['progression', 'transpose']) {
      const mutated = applyMutation(name, spec, 5);
      expect(mutated).toEqual(before);
      expect(mutated).not.toBe(spec);
      expect(checkSpec(mutated).ok).toBe(true);
    }
    expect(spec).toEqual(before);
  });

  it('локальная вариация меняет одну секцию, сохраняя аккорды в исходном ладу', () => {
    const spec = goodSpec();
    const mutated = applyMutation('transpose', spec, 5);
    const changed = mutated.structure.sections.filter((section, index) =>
      section.harmony !== spec.structure.sections[index].harmony);
    expect(changed).toHaveLength(1);
    expect(checkSpec(mutated).ok).toBe(true);
    mutated.structure.sections.forEach((section, index) => {
      expect(progressionForSection(mutated, index)).toBe(section.harmony);
      expect(section.harmony.split(/\s+/).sort())
        .toEqual(spec.structure.sections[index].harmony.split(/\s+/).sort());
    });
    expect(compileTrackSpec(mutated)).not.toBe(compileTrackSpec(spec));
  });
});
