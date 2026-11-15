// Идентичность партии и роль (D-100, фаза C).
//
// До фазы C ключ записи в `parts.roles` был ролью, а список ролей —
// enum'ом из 12 значений. Трек из 100 дорожек был физически невозможен.
// Теперь ключ — идентификатор партии, роль — атрибут.

import { describe, it, expect } from 'vitest';

import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';
import {
  ROLES, labelIndex, listParts, partLabel, roleOf, transposeFor,
} from '../../src/schemas/parts.js';
import { StudioSpecSchema, projectFromSpec, safeValidateProjectModel } from '../../src/studio/model.js';
import { compileProject } from '../../src/studio/compile.js';
import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { parseParts } from '../../src/core/code-model.js';

function spec(parts, overrides = {}) {
  return {
    meta: { style: 'techno', key: 'Cmin', bpm: 120 },
    structure: {
      sections: [
        { name: 'intro', cycles: 8, energy: 0.4, harmony: 'Cm' },
        { name: 'drop', cycles: 8, energy: 0.9, harmony: 'Cm Gm' },
      ],
    },
    parts: { roles: parts },
    ...overrides,
  };
}

const legacy = {
  kick: { activeIn: ['intro', 'drop'], pattern: 'bd*4', sound: 'bd' },
  bass: { activeIn: ['drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' },
};

describe('роль — атрибут, идентичность — ключ', () => {
  it('легаси-спека (ключ = роль) принимается без изменений', () => {
    const parsed = TrackSpecSchema.parse(spec(legacy));
    expect(Object.keys(parsed.parts.roles).sort()).toEqual(['bass', 'kick']);
    expect(roleOf('kick', parsed.parts.roles.kick)).toBe('kick');
    expect(roleOf('bass', parsed.parts.roles.bass)).toBe('bass');
  });

  it('легаси-спека компилируется в прежние метки', () => {
    const code = compileTrackSpec(spec(legacy));
    expect(code).toMatch(/\$KICK:/);
    expect(code).toMatch(/\$BASS:/);
  });

  it('100 дорожек принимаются схемой (было: физически невозможно)', () => {
    const parts = Object.fromEntries(Array.from({ length: 100 }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      return [`P${n}`, { role: 'pad', activeIn: ['intro', 'drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' }];
    }));
    expect(TrackSpecSchema.safeParse(spec(parts)).success).toBe(true);
    expect(StudioSpecSchema.safeParse(spec(parts)).success).toBe(true);
  });

  it('100 дорожек компилируются в 100 разных меток', () => {
    const parts = Object.fromEntries(Array.from({ length: 100 }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      return [`P${n}`, { role: 'pad', activeIn: ['drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' }];
    }));
    const code = compileTrackSpec(spec(parts));
    const labels = code.split('\n').filter((line) => /^\$[A-Z][A-Z0-9_]*:/.test(line));
    expect(labels).toHaveLength(100);
    expect(parseParts(code)).toHaveLength(100);
  });

  it('две партии одной роли получают разные идентичности и метки', () => {
    const parts = {
      VIOLIN_1: { role: 'violin', activeIn: ['drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' },
      VIOLIN_2: { role: 'violin', activeIn: ['drop'], pattern: '4 ~ 5 ~', sound: 'sawtooth' },
    };
    const parsed = TrackSpecSchema.parse(spec(parts));
    const list = listParts(parsed.parts);
    expect(list.map((item) => item.id)).toEqual(['VIOLIN_1', 'VIOLIN_2']);
    expect(list.map((item) => item.label)).toEqual(['VIOLIN_1', 'VIOLIN_2']);
    expect(list.map((item) => item.role)).toEqual(['violin', 'violin']);
    const code = compileTrackSpec(parsed);
    expect(code).toMatch(/\$VIOLIN_1:/);
    expect(code).toMatch(/\$VIOLIN_2:/);
  });

  it('роль, которой нет в библиотеке, разрешена (роль — строка, не enum)', () => {
    const parts = {
      CHOIR: { role: 'choir_soprano', activeIn: ['drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' },
    };
    const parsed = TrackSpecSchema.safeParse(spec(parts));
    expect(parsed.success).toBe(true);
    expect(roleOf('CHOIR', parsed.data.parts.roles.CHOIR)).toBe('choir_soprano');
  });

  it('партия без определяемой роли отклоняется', () => {
    const parts = { kazoo: { activeIn: ['drop'], pattern: 'x', sound: 's' } };
    const result = TrackSpecSchema.safeParse(spec(parts));
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/роль партии не определена/);
  });

  it('метки, различающиеся только регистром, отклоняются', () => {
    const parts = {
      VIOLIN_1: { role: 'violin', activeIn: ['drop'], pattern: '0', sound: 'sawtooth' },
      violin_1: { role: 'violin', activeIn: ['drop'], pattern: '0', sound: 'sawtooth' },
    };
    const result = TrackSpecSchema.safeParse(spec(parts));
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/метка партии не уникальна/);
  });

  it('идентификатор партии не может быть мусором', () => {
    const parts = { 'плохой id': { role: 'pad', activeIn: ['drop'], pattern: '0', sound: 's' } };
    expect(TrackSpecSchema.safeParse(spec(parts)).success).toBe(false);
  });

  it('библиотека ролей — один источник, и роли не потолок', () => {
    expect(ROLES).toContain('kick');
    expect(ROLES).toHaveLength(12);
    // Роль не обязана быть в библиотеке: потолок ролей снят (D-100).
    expect(transposeFor('violin')).toBe(0);
    expect(transposeFor('bass')).toBe(-24);
  });

  it('карта меток ведёт к идентификатору', () => {
    const parts = { VIOLIN_1: { role: 'violin', activeIn: [], pattern: '0', sound: 's' } };
    const index = labelIndex({ roles: parts });
    expect(index.get('VIOLIN_1')).toBe('VIOLIN_1');
    expect(partLabel('violin_1')).toBe('VIOLIN_1');
  });
});

describe('микс и автоматизация адресуют партию, а не роль', () => {
  it('микс строится по идентификаторам партий', () => {
    const model = projectFromSpec(spec(legacy), { id: 'mix-test' });
    expect(Object.keys(model.mix.parts).sort()).toEqual(['bass', 'kick']);
  });

  it('микс с неизвестной партией отклоняется', () => {
    const model = projectFromSpec(spec(legacy), { id: 'mix-test' });
    model.mix.parts.guitar = { ...model.mix.parts.kick };
    const result = safeValidateProjectModel(model);
    expect(result.ok).toBe(false);
    expect(result.error.issues[0].message).toMatch(/неизвестная партия/);
  });

  it('автоматизация на несуществующую партию отклоняется', () => {
    const model = projectFromSpec(spec(legacy), { id: 'auto-test' });
    model.automation.push({
      id: 'auto-1',
      target: { kind: 'part', id: 'VIOLIN_9' },
      param: 'gain',
      curve: { type: 'ramp', from: 0, to: 1, bars: 4 },
    });
    const result = safeValidateProjectModel(model);
    expect(result.ok).toBe(false);
    expect(result.error.issues[0].message).toMatch(/неизвестная партия/);
  });

  it('план проекта несёт и идентичность, и роль, и метку', () => {
    const model = projectFromSpec(spec({
      VIOLIN_1: { role: 'violin', activeIn: ['drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' },
    }), { id: 'plan-test' });
    const { plan } = compileProject(model);
    expect(plan.parts[0]).toMatchObject({ id: 'VIOLIN_1', role: 'violin', label: 'VIOLIN_1' });
  });
});
