// Типизированные правки конкретной дорожки (D-105).
//
// Гейт C требует: правка «замени тембр виолончели и сделай её партию
// мрачнее в сцене 2» выполняется без перегенерации остальных дорожек.
// Проверяем это буквально: после правки код остальных дорожек должен быть
// побайтово тем же.

import { describe, it, expect } from 'vitest';

import { applyPartEdit, applyPartEdits, PART_OPS } from '../../src/music/part-edit.js';
import { expandPlan } from '../../src/music/expand.js';
import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { validateTrackSpec } from '../../src/schemas/track-spec.schema.js';

function specWithVoices(count = 6) {
  const { parts } = expandPlan({
    style: 'cinematic',
    key: 'Cmin',
    bpm: 90,
    sections: [
      { name: 'intro', bars: 8, energy: 0.3, harmony: 'Cm' },
      { name: 'drop', bars: 16, energy: 0.9, harmony: 'Cm Gm' },
    ],
    groups: [{ group: 'strings', role: 'violin', count }],
  });
  return validateTrackSpec({
    meta: { style: 'cinematic', key: 'Cmin', bpm: 90 },
    structure: {
      sections: [
        { name: 'intro', cycles: 8, energy: 0.3, harmony: 'Cm' },
        { name: 'drop', cycles: 16, energy: 0.9, harmony: 'Cm Gm' },
      ],
    },
    parts: { roles: parts },
  });
}

/** Строки кода, относящиеся к одной метке (метка + её константы). */
function partLines(code, label) {
  return code.split('\n').filter((line) => line.includes(`$${label}:`) || line.includes(`const ${label}_`));
}

describe('правки дорожки по id', () => {
  it('меняет только целевую дорожку: остальные идентичны', () => {
    const spec = specWithVoices();
    const result = applyPartEdit(spec, { id: 'VIOLIN_3', op: 'setSound', params: { sound: 'triangle' } });
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(['VIOLIN_3']);

    for (const id of Object.keys(spec.parts.roles)) {
      if (id === 'VIOLIN_3') continue;
      expect(result.spec.parts.roles[id]).toEqual(spec.parts.roles[id]);
    }
  });

  it('не перегенерирует код остальных дорожек', () => {
    const spec = specWithVoices();
    const before = compileTrackSpec(spec);
    const result = applyPartEdit(spec, { id: 'VIOLIN_3', op: 'setSound', params: { sound: 'triangle' } });
    const after = compileTrackSpec(result.spec);

    expect(after).not.toBe(before);
    for (const id of Object.keys(spec.parts.roles)) {
      if (id === 'VIOLIN_3') continue;
      expect(partLines(after, id)).toEqual(partLines(before, id));
    }
    expect(partLines(after, 'VIOLIN_3')).not.toEqual(partLines(before, 'VIOLIN_3'));
  });

  it('«мрачнее в сцене 2»: переопределение секции меняет только эту сцену', () => {
    const spec = specWithVoices();
    const result = applyPartEdit(spec, {
      id: 'VIOLIN_2',
      op: 'setSectionPattern',
      params: { section: 'drop', pattern: '0 ~ ~ ~' },
    });
    expect(result.ok).toBe(true);
    expect(result.spec.parts.roles.VIOLIN_2.sections.drop.pattern).toBe('0 ~ ~ ~');
    // Переопределение затрагивает только секцию drop.
    expect(result.spec.parts.roles.VIOLIN_2.sections.intro).toBeUndefined();
    // Основной рисунок дорожки не тронут.
    expect(result.spec.parts.roles.VIOLIN_2.pattern).toBe(spec.parts.roles.VIOLIN_2.pattern);
  });

  it('громкость в дБ превращается в линейный gain', () => {
    const spec = specWithVoices();
    const result = applyPartEdit(spec, { id: 'VIOLIN_1', op: 'setGain', params: { gainDb: -6 } });
    const gain = result.spec.parts.roles.VIOLIN_1.effects.find((effect) => effect.name === 'gain');
    expect(gain.params[0]).toBeCloseTo(0.5012, 3);
  });

  it('роль меняется на строчную строку', () => {
    const spec = specWithVoices();
    const ok = applyPartEdit(spec, { id: 'VIOLIN_1', op: 'setRole', params: { role: 'choir_soprano' } });
    expect(ok.ok).toBe(true);
    expect(ok.spec.parts.roles.VIOLIN_1.role).toBe('choir_soprano');
    const bad = applyPartEdit(spec, { id: 'VIOLIN_1', op: 'setRole', params: { role: 'Хор' } });
    expect(bad.ok).toBe(false);
  });

  it('неизвестная дорожка и неизвестная операция — честная ошибка', () => {
    const spec = specWithVoices();
    const missing = applyPartEdit(spec, { id: 'VIOLIN_99', op: 'setSound', params: { sound: 'x' } });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/VIOLIN_99/);
    const unknown = applyPartEdit(spec, { id: 'VIOLIN_1', op: 'explode', params: {} });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/explode/);
  });

  it('дорожку можно убрать и добавить', () => {
    const spec = specWithVoices();
    const removed = applyPartEdit(spec, { id: 'VIOLIN_4', op: 'removePart', params: {} });
    expect(removed.ok).toBe(true);
    expect(removed.spec.parts.roles.VIOLIN_4).toBeUndefined();

    const added = applyPartEdit(removed.spec, {
      id: 'VIOLIN_4',
      op: 'addPart',
      params: { part: { role: 'violin', activeIn: ['drop'], pattern: '0 ~ 2 ~', sound: 'sawtooth' } },
    });
    expect(added.ok).toBe(true);
    expect(Object.keys(added.spec.parts.roles)).toHaveLength(Object.keys(spec.parts.roles).length);
  });

  it('несколько правок применяются по очереди и остаются чистыми', () => {
    const spec = specWithVoices();
    const result = applyPartEdits(spec, [
      { id: 'VIOLIN_1', op: 'setSound', params: { sound: 'triangle' } },
      { id: 'VIOLIN_2', op: 'setGain', params: { gainDb: -3 } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(['VIOLIN_1', 'VIOLIN_2']);
    // Исходная спека не тронута.
    expect(spec.parts.roles.VIOLIN_1.sound).toBe('sawtooth');
  });

  it('набор операций объявлен явно', () => {
    expect(Object.keys(PART_OPS)).toContain('setSound');
    expect(Object.keys(PART_OPS)).toContain('setSectionPattern');
  });
});
