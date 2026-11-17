// Timbre Palette в компиляторе (D-128) и инвариант музыкальных событий.
//
// ГЛАВНЫЙ ИНВАРИАНТ: смена инструмента меняет ТОЛЬКО источник звука.
// Ноты, тайминги, длительности, gain-паттерны, свинг, эффекты и структура
// остаются идентичными — проверяется по событиям queryArc настоящего
// Strudel (D-001/D-003/D-004), а не по байтам аудио (D-104).

import { describe, it, expect } from 'vitest';

import { compileTrackSpec } from '../../server/music/compiler/index.js';
// Побочный эффект: регистрирует серверный загрузчик каталога в компиляторе.
import '../../server/samples/timbre.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';
import { validateTrackSpec } from '../../src/schemas/track-spec.schema.js';

const baseSpec = () => ({
  meta: { style: 'lo-fi', bpm: 84, key: 'Amin' },
  structure: {
    sections: [
      { name: 'intro', cycles: 4, energy: 0.4, harmony: 'Amin Fmin' },
      { name: 'verse', cycles: 12, energy: 0.7, harmony: 'Amin Gmin' },
    ],
  },
  parts: {
    roles: {
      PIANO_1: {
        role: 'chords',
        activeIn: ['intro', 'verse'],
        pattern: '0 2 4 6',
        sound: 'piano',
        transpose: 12,
        gainPattern: '0.8 0.5 0.6 ~',
        effects: [{ name: 'room', params: [0.2] }],
        sections: { verse: { pattern: '0 4 2 6' } },
      },
      BASS_1: {
        role: 'bass',
        activeIn: ['verse'],
        pattern: '0 ~ 3 ~',
        sound: 'sine',
        swing: 0.6,
      },
      LEAD_1: {
        role: 'lead',
        activeIn: ['intro', 'verse'],
        pattern: 'c4 e4 g4 a4',
        sound: 'triangle',
      },
    },
  },
});

/** События партии без поля источника звука: тембр — единственное, что меняется.
 * context.locations — позиции символов в коде, не музыка: длина alias другая,
 * поэтому метаданные исходника исключаются из сравнения. */
function eventsWithoutSound(events) {
  return events.map((hap) => {
    const value = { ...hap.value };
    delete value.s;
    delete value.sound;
    return { whole: hap.whole, part: hap.part, value };
  });
}

describe('компилятор: instrumentId (D-128)', () => {
  it('старая спека без instrumentId компилируется как раньше', () => {
    const code = compileTrackSpec(baseSpec());
    expect(code).toContain('.s("piano")');
    expect(code).not.toContain('tp_');
  });

  it('instrumentId подменяет sound на alias пресета', () => {
    const spec = baseSpec();
    spec.parts.roles.PIANO_1.instrumentId = 'tp-upright-soft-v1';
    const code = compileTrackSpec(spec);
    expect(code).toContain('.s("tp_upright_soft_v1")');
    expect(code).not.toContain('.s("piano")');
  });

  it('неизвестный instrumentId — ошибка компиляции, не тихая подмена', () => {
    const spec = baseSpec();
    spec.parts.roles.PIANO_1.instrumentId = 'tp-ghost-v9';
    expect(() => compileTrackSpec(spec)).toThrow(/tp-ghost-v9/);
  });

  it('секционный override.sound сильнее instrumentId', () => {
    const spec = baseSpec();
    spec.parts.roles.PIANO_1.instrumentId = 'tp-upright-soft-v1';
    spec.parts.roles.PIANO_1.sections.verse.sound = 'triangle';
    const code = compileTrackSpec(spec);
    // intro — alias пресета, verse — явный override
    const intro = code.split('\n').find((line) => line.startsWith('const PIANO_1_0'));
    const verse = code.split('\n').find((line) => line.startsWith('const PIANO_1_1'));
    expect(intro).toContain('.s("tp_upright_soft_v1")');
    expect(verse).toContain('.s("triangle")');
    expect(verse).not.toContain('tp_upright_soft_v1');
  });

  it('секции без override наследуют instrumentId', () => {
    const spec = baseSpec();
    spec.parts.roles.PIANO_1.instrumentId = 'tp-upright-soft-v1';
    const code = compileTrackSpec(spec);
    const intro = code.split('\n').find((line) => line.startsWith('const PIANO_1_0'));
    const verse = code.split('\n').find((line) => line.startsWith('const PIANO_1_1'));
    expect(intro).toContain('.s("tp_upright_soft_v1")');
    expect(verse).toContain('.s("tp_upright_soft_v1")');
  });

  it('groups-партии не трогаются: per-step сэмплы важнее instrumentId', () => {
    const spec = baseSpec();
    spec.parts.roles.DRUMS_1 = {
      role: 'kick',
      activeIn: ['intro', 'verse'],
      pattern: '~',
      sound: 's',
      instrumentId: 'tp-upright-soft-v1',
      groups: [{ sample: 'bd', steps: [0, 8], gain: 0.9 }],
    };
    const code = compileTrackSpec(spec);
    const drums = code.split('\n').filter((line) => line.startsWith('const DRUMS_1'));
    expect(drums.join('\n')).toContain('s("bd")');
    expect(drums.join('\n')).not.toContain('tp_upright_soft_v1');
  });

  it('timbreProfile не влияет на код (интерпретация, не событие)', () => {
    const spec = baseSpec();
    spec.parts.roles.PIANO_1.instrumentId = 'tp-upright-soft-v1';
    const without = compileTrackSpec(spec);
    spec.parts.roles.PIANO_1.timbreProfile = 'warm';
    expect(compileTrackSpec(spec)).toBe(without);
  });

  it('схема принимает instrumentId/timbreProfile и отклоняет мусор', () => {
    const spec = baseSpec();
    spec.parts.roles.PIANO_1.instrumentId = 'tp-upright-soft-v1';
    spec.parts.roles.PIANO_1.timbreProfile = 'warm';
    expect(() => validateTrackSpec(spec)).not.toThrow();
    spec.parts.roles.PIANO_1.instrumentId = 'piano';
    expect(() => validateTrackSpec(spec)).toThrow();
    spec.parts.roles.PIANO_1.instrumentId = 'tp-upright-soft-v1';
    spec.parts.roles.PIANO_1.timbreProfile = 'очень тёплый';
    expect(() => validateTrackSpec(spec)).toThrow();
  });
});

describe('инвариант событий: смена инструмента не меняет музыку (D-001)', () => {
  it('события идентичны до/после смены инструмента (transpose, gainPattern, swing, effects, sections)', async () => {
    const before = baseSpec();
    const after = baseSpec();
    after.parts.roles.PIANO_1.instrumentId = 'tp-upright-soft-v1';
    after.parts.roles.LEAD_1.instrumentId = 'tp-solo-violin-v1';
    after.parts.roles.BASS_1.instrumentId = 'tp-contrabass-pizz-v1';

    const runBefore = await runStrudel(compileTrackSpec(before), { cycles: 6 });
    const runAfter = await runStrudel(compileTrackSpec(after), { cycles: 6 });
    expect(runBefore.ok).toBe(true);
    expect(runAfter.ok).toBe(true);
    expect(runAfter.order).toEqual(runBefore.order);

    for (const name of runBefore.order) {
      const a = eventsWithoutSound(runBefore.parts[name]);
      const b = eventsWithoutSound(runAfter.parts[name]);
      expect(b, `партия ${name}: события изменились`).toEqual(a);
      expect(a.length).toBeGreaterThan(0);
    }
    // Источник звука при этом действительно сменился.
    const pianoBefore = runBefore.parts.PIANO_1[0].value.s;
    const pianoAfter = runAfter.parts.PIANO_1[0].value.s;
    expect(pianoBefore).toBe('piano');
    expect(pianoAfter).toBe('tp_upright_soft_v1');
  }, 30_000);

  it('инвариант держится в другом стиле и форме (techno, build/drop)', async () => {
    const spec = {
      meta: { style: 'techno', bpm: 128, key: 'Fmin' },
      structure: {
        sections: [
          { name: 'build', cycles: 4, energy: 0.5, harmony: 'Fmin Cmin' },
          { name: 'drop', cycles: 12, energy: 0.9, harmony: 'Fmin Gmin' },
        ],
      },
      parts: {
        roles: {
          PAD_1: {
            role: 'pad', activeIn: ['build', 'drop'], pattern: '0 3 5', sound: 'sawtooth',
            effects: [{ name: 'lpf', params: [800] }, { name: 'gain', params: [0.7] }],
          },
          ARP_1: {
            role: 'arp', activeIn: ['drop'], pattern: '0 2 4 7', sound: 'square',
            transpose: 12, gainPattern: '0.9 0.6 0.8 0.5',
          },
        },
      },
    };
    const swapped = JSON.parse(JSON.stringify(spec));
    swapped.parts.roles.PAD_1.instrumentId = 'tp-viola-section-v1';
    swapped.parts.roles.ARP_1.instrumentId = 'tp-harp-v1';

    const a = await runStrudel(compileTrackSpec(spec), { cycles: 6 });
    const b = await runStrudel(compileTrackSpec(swapped), { cycles: 6 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    for (const name of a.order) {
      expect(eventsWithoutSound(b.parts[name]), `партия ${name}`).toEqual(eventsWithoutSound(a.parts[name]));
    }
  }, 30_000);
});