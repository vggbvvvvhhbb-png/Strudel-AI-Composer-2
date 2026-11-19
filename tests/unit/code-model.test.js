import { describe, expect, it } from 'vitest';
import {
  parseParts, setPartMuted, setPartSolo, unsoloAll, setPartGain, getPartGain,
  getPartSound, setPartSound,
  getBpm, setCpm, getKey, setKey, changedRegions, diffLines,
} from '../../src/core/code-model.js';

const CODE = [
  'setCpm(120/4)',
  'const key = "c:major"',
  '$MEL: note("c4 e4 g4").s("piano").gain(0.5)._pianoroll()',
  '  .room(0.4)',
  '$BASS: note("c2 g2").s("sawtooth").gain(0.3)',
  '$DRUMS: s("bd sd").bank("RolandTR909")._scope()',
].join('\n');

describe('parseParts', () => {
  it('находит партии и их регионы', () => {
    const parts = parseParts(CODE);
    expect(parts.map((p) => p.label)).toEqual(['MEL', 'BASS', 'DRUMS']);
    expect(parts[0].startLine).toBe(2);
    expect(parts[0].endLine).toBe(3); // цепочка на следующей строке
    expect(parts[1].startLine).toBe(4);
  });
});

describe('setPartMuted', () => {
  it('ставит и снимает префикс _', () => {
    const muted = setPartMuted(CODE, 'BASS', true);
    expect(muted).toContain('_$BASS:');
    expect(parseParts(muted).find((p) => p.label === 'BASS').muted).toBe(true);
    const restored = setPartMuted(muted, 'BASS', false);
    expect(restored).toContain('$BASS:');
    expect(restored).toBe(CODE);
  });

  it('не трогает соседние партии', () => {
    const muted = setPartMuted(CODE, 'MEL', true);
    expect(muted).toContain('$BASS:');
    expect(muted).toContain('$DRUMS:');
  });
});

describe('setPartSolo', () => {
  it('глушит всех кроме солиста и восстанавливает', () => {
    const { code, previous } = setPartSolo(CODE, 'DRUMS');
    expect(code).toContain('_$MEL:');
    expect(code).toContain('_$BASS:');
    expect(code).toMatch(/\$DRUMS:/);
    expect(previous).toEqual([]);
    const restored = unsoloAll(code, previous);
    expect(restored).toBe(CODE);
  });

  it('учитывает ранее заглушённые партии', () => {
    const once = setPartMuted(CODE, 'MEL', true);
    const { code, previous } = setPartSolo(once, 'BASS');
    expect(previous).toEqual(['MEL']);
    expect(code).toContain('_$MEL:');
    expect(code).toMatch(/\$BASS:/);
    const restored = unsoloAll(code, previous);
    expect(restored).toBe(once);
  });
});

describe('setPartGain', () => {
  it('заменяет существующий .gain() в регионе партии', () => {
    const next = setPartGain(CODE, 'MEL', 0.9);
    expect(next).toContain('$MEL: note("c4 e4 g4").s("piano").gain(0.9)._pianoroll()');
    expect(next).toContain('$BASS: note("c2 g2").s("sawtooth").gain(0.3)');
  });

  it('дописывает .gain() в конец строки партии, сохраняя комментарий', () => {
    const next = setPartGain(CODE, 'BASS', 0.75);
    expect(next).toContain('$BASS: note("c2 g2").s("sawtooth").gain(0.75)');
    expect(getPartGain(next, 'BASS')).toBe(0.75);
  });

  it('не лезет в чужие регионы', () => {
    const next = setPartGain(CODE, 'DRUMS', 0.1);
    expect(getPartGain(next, 'MEL')).toBe(0.5);
  });
});

describe('BPM и key', () => {
  it('читает и переписывает setCpm', () => {
    expect(getBpm(CODE)).toBe(120);
    expect(getBpm(setCpm(CODE, 95))).toBe(95);
    expect(setCpm(CODE, 95)).toContain('setCpm(95/4)');
  });

  it('добавляет setCpm, если его не было', () => {
    expect(getBpm('$MEL: note("c")')).toBe(null);
    expect(setCpm('$MEL: note("c")', 80).startsWith('setCpm(80/4)')).toBe(true);
  });

  it('читает и переписывает key', () => {
    expect(getKey(CODE)).toBe('c:major');
    expect(setKey(CODE, 'a:minor')).toContain('const key = "a:minor"');
    expect(getKey(setKey(CODE, 'f#:dorian'))).toBe('f#:dorian');
  });

  it('добавляет key, если его не было', () => {
    expect(setKey('$MEL: note("c")', 'e:minor').startsWith('const key = "e:minor"')).toBe(true);
  });
});

describe('changedRegions', () => {
  it('видит изменения только в заданной партии (кейс «бас погромче»)', () => {
    const improved = CODE.replace('.gain(0.3)', '.gain(0.8)');
    const changed = changedRegions(CODE, improved);
    expect(changed.parts).toEqual(['BASS']);
    expect(changed.bpm).toBe(false);
    expect(changed.key).toBe(false);
  });
});

describe('diffLines', () => {
  it('помечает добавленные и удалённые строки', () => {
    const d = diffLines('a\nb\nc', 'a\nX\nc');
    expect(d.filter((x) => x.type === 'del').map((x) => x.text)).toEqual(['b']);
    expect(d.filter((x) => x.type === 'add').map((x) => x.text)).toEqual(['X']);
    expect(d.filter((x) => x.type === 'same').length).toBe(2);
  });
});

describe('getPartSound / setPartSound (этап 4, D-131)', () => {
  // Код из спеки: тело партии вынесено компилятором в секционные константы.
  const SPEC_CODE = [
    '// lo-fi — 84 BPM, c:minor',
    'setCpm(84/4)',
    'const PIANO_1_0 = n("0 2 4 6").scale("c:minor").s("piano").room(0.2)',
    'const PIANO_1_1 = n("0 4 2 6").scale("c:minor").s("piano")',
    'const BASS_1_0 = n("0 ~").scale("c:minor").s("sine").gain(0.4)',
    '',
    '$PIANO_1: arrange([4, PIANO_1_0], [12, PIANO_1_1])._pianoroll() // role=chords',
    '$BASS_1: arrange([16, BASS_1_0])._pianoroll() // role=bass',
  ].join('\n');

  it('читает звук партии в свободном коде', () => {
    expect(getPartSound(CODE, 'MEL')).toBe('piano');
    expect(getPartSound(CODE, 'BASS')).toBe('sawtooth');
  });

  it('партии с groups/без .s() звука не имеют — чипа в таймлайне нет', () => {
    expect(getPartSound(CODE, 'DRUMS')).toBeNull();
    expect(getPartSound(CODE, 'NOPE')).toBeNull();
  });

  it('читает звук из секционных констант кода спеки', () => {
    expect(getPartSound(SPEC_CODE, 'PIANO_1')).toBe('piano');
    expect(getPartSound(SPEC_CODE, 'BASS_1')).toBe('sine');
  });

  it('заменяет только .s() своей партии: ноты, ритм и чужие партии целы', () => {
    const next = setPartSound(CODE, 'MEL', 'tp_upright_soft_v1');
    expect(next).toContain('.s("tp_upright_soft_v1")');
    expect(next).toContain('note("c4 e4 g4")');
    expect(next).toContain('.gain(0.5)');
    expect(getPartSound(next, 'BASS')).toBe('sawtooth');
    expect(getPartSound(next, 'MEL')).toBe('tp_upright_soft_v1');
  });

  it('в коде спеки заменяет звук во всех секционных константах партии', () => {
    const next = setPartSound(SPEC_CODE, 'PIANO_1', 'tp_upright_soft_v1');
    expect(getPartSound(next, 'PIANO_1')).toBe('tp_upright_soft_v1');
    expect(next).toContain('const PIANO_1_1 = n("0 4 2 6").scale("c:minor").s("tp_upright_soft_v1")');
    // Чужая партия и музыкальные события не тронуты.
    expect(getPartSound(next, 'BASS_1')).toBe('sine');
    expect(next).toContain('n("0 2 4 6")');
    expect(next).toContain('.room(0.2)');
    expect(next).toContain('$PIANO_1: arrange([4, PIANO_1_0], [12, PIANO_1_1])');
  });

  it('секционный override звука при коде-правке заменяется тоже (ограничение MVP, D-131)', () => {
    const withOverride = SPEC_CODE.replace(
      'const PIANO_1_1 = n("0 4 2 6").scale("c:minor").s("piano")',
      'const PIANO_1_1 = n("0 4 2 6").scale("c:minor").s("triangle")',
    );
    const next = setPartSound(withOverride, 'PIANO_1', 'tp_harp_v1');
    expect(next).not.toContain('.s("triangle")');
    expect(next).not.toContain('.s("piano")');
  });

  it('невалидное имя звука и неизвестная партия — код не меняется', () => {
    expect(setPartSound(CODE, 'MEL', 'bad name')).toBe(CODE);
    expect(setPartSound(CODE, 'MEL', '../escape')).toBe(CODE);
    expect(setPartSound(CODE, 'NOPE', 'piano')).toBe(CODE);
    expect(setPartSound(SPEC_CODE, 'PIANO_1', '')).toBe(SPEC_CODE);
  });

  it('mute и gain партии переживают смену звука', () => {
    const muted = setPartMuted(SPEC_CODE, 'PIANO_1', true);
    const next = setPartSound(muted, 'PIANO_1', 'tp_harp_v1');
    expect(parseParts(next).find((p) => p.label === 'PIANO_1').muted).toBe(true);
    expect(getPartGain(next, 'BASS_1')).toBeNull(); // gain в константе, не в регионе партии
    expect(next).toContain('.gain(0.4)');
  });
});
