// Экспансия плана в дорожки и бюджет полифонии (фаза C).

import { describe, it, expect } from 'vitest';

import {
  GROUP_LEVEL, attacksPerBar, expandPlan, globalAttackBudget, groupOf, specFromPlan,
  thinPattern, tokenizeMini, voiceId,
} from '../../src/music/expand.js';
import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';

const plan = {
  style: 'cinematic',
  key: 'Cmin',
  bpm: 90,
  sections: [
    { name: 'intro', bars: 8, energy: 0.3, harmony: 'Cm' },
    { name: 'drop', bars: 16, energy: 0.9, harmony: 'Cm Gm' },
  ],
  groups: [
    { group: 'strings', role: 'violin', count: 8 },
    { group: 'strings', role: 'cello', count: 4 },
    { group: 'brass', role: 'horn', count: 4 },
    { group: 'keys', role: 'piano', count: 4 },
    { group: 'choir', role: 'choir_soprano', count: 4 },
    { group: 'bass', role: 'bass', count: 2 },
    { group: 'drums', role: 'kick', count: 1 },
    { group: 'drums', role: 'hats', count: 1 },
    { group: 'lead', role: 'lead', count: 2 },
  ],
};

describe('экспансия плана', () => {
  it('разворачивает план в дорожки с уникальными идентификаторами', () => {
    const { parts } = expandPlan(plan);
    const ids = Object.keys(parts);
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('VIOLIN_1');
    expect(ids).toContain('VIOLIN_8');
    expect(ids).toContain('CELLO_1');
  });

  it('детерминирована: один и тот же план -> один и тот же трек', () => {
    const a = expandPlan(plan);
    const b = expandPlan(plan);
    expect(JSON.stringify(a.parts)).toBe(JSON.stringify(b.parts));
  });

  it('роль остаётся атрибутом, идентичность — ключом', () => {
    const { parts } = expandPlan(plan);
    expect(parts.VIOLIN_1.role).toBe('violin');
    expect(parts.CELLO_1.role).toBe('cello');
    expect(parts.VIOLIN_1.activeIn).toEqual(['intro', 'drop']);
  });

  it('группа определяется по роли', () => {
    expect(groupOf('violin')).toBe('strings');
    expect(groupOf('kick')).toBe('drums');
    expect(groupOf('choir_soprano')).toBe('choir');
  });

  it('бюджет плотности на голос соблюдён', () => {
    const { parts, report } = expandPlan(plan);
    const perVoice = new Map(report.groups.map((item) => [item.group, item.perVoiceBudget]));
    for (const part of Object.values(parts)) {
      const budget = perVoice.get(groupOf(part.role)) ?? 4;
      expect(attacksPerBar(part.pattern)).toBeLessThanOrEqual(budget);
    }
    expect(report.budgetOk).toBe(true);
  });

  it('общий бюджет атак на такт соблюдён', () => {
    const { report } = expandPlan(plan);
    expect(report.totalAttacksPerBar).toBeLessThanOrEqual(globalAttackBudget(report.voices));
    expect(report.budgetOk).toBe(true);
  });

  it('громкость голоса делит уровень группы', () => {
    const { parts } = expandPlan(plan);
    const strings = Object.values(parts).filter((part) => ['violin', 'cello'].includes(part.role));
    const sum = strings.reduce((total, part) => total
      + part.effects.find((effect) => effect.name === 'gain').params[0], 0);
    // Сумма голосов группы держится у GROUP_LEVEL.
    expect(sum).toBeCloseTo(GROUP_LEVEL, 3);
  });

  it('прореживание не ломает мини-нотацию (тишины внутри групп быть не может)', () => {
    const thinned = thinPattern('<0 2 4> ~', 2);
    expect(thinned).not.toMatch(/<[^>]*~/);
    expect(attacksPerBar(thinned)).toBeLessThanOrEqual(attacksPerBar('<0 2 4> ~'));
    // Токенизация держит группу целой.
    expect(tokenizeMini('<0 2 4> ~')).toEqual(['<0 2 4>', '~']);
  });

  it('считает атаки в группах и повторах', () => {
    expect(attacksPerBar('bd*4')).toBe(4);
    expect(attacksPerBar('~ ~ ~ ~')).toBe(0);
    expect(attacksPerBar('<0 2 4>')).toBe(3);
    expect(attacksPerBar('[0 0 3 5]')).toBe(4);
    expect(attacksPerBar('0 ~ 2 ~')).toBe(2);
  });

  it('идентификатор голоса устойчив', () => {
    expect(voiceId('violin', 0)).toBe('VIOLIN_1');
    expect(voiceId('choir_soprano', 2)).toBe('CHOIR_SOPRANO_3');
  });

  it('спека из плана проходит каноническую схему', () => {
    const { spec } = specFromPlan(plan);
    const parsed = TrackSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data.parts.roles)).toHaveLength(30);
  });
});
