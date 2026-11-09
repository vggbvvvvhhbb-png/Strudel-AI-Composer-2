// Ядро музыкального разбора: mini-нотация → события → метрики → скор.
// Тесты живут в node: движок Strudel для этого не нужен.
import { describe, it, expect } from 'vitest';
import { parseMini, euclidPattern } from '../../server/music/mini.js';
import {
  noteToMidi,
  parseKey,
  degreeToMidi,
  chordToMidi,
  pitchClass,
  notesOutsideScale,
} from '../../server/music/notes.js';
import { extractTrack, partEvents, stripCodeFences } from '../../server/music/extract.js';
import { analyzeTrack, detectKey } from '../../server/music/features.js';
import { scoreTrack } from '../../server/music/score.js';
import { PROFILES, detectStyle, resolveProfile } from '../../server/music/references.js';

const round = (n) => Math.round(n * 1000) / 1000;
const values = (events) => events.map((e) => e.value);

describe('mini-нотация', () => {
  it('последовательность делит такт поровну', () => {
    const { events } = parseMini('bd sd');
    expect(events).toHaveLength(2);
    expect(round(events[0].begin)).toBe(0);
    expect(round(events[1].begin)).toBe(0.5);
  });

  it('пауза (тильда) не даёт события, но занимает место', () => {
    const { events } = parseMini('~ sd');
    expect(events).toHaveLength(1);
    expect(round(events[0].begin)).toBe(0.5);
  });

  it('повтор *n даёт n атак внутри своей доли', () => {
    const { events } = parseMini('bd*4');
    expect(events).toHaveLength(4);
    expect(events.map((e) => round(e.begin))).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('стек через запятую кладёт паттерны параллельно', () => {
    const { events } = parseMini('bd*4, hh*8');
    expect(events).toHaveLength(12);
    expect(values(events).filter((v) => v === 'bd')).toHaveLength(4);
    expect(values(events).filter((v) => v === 'hh')).toHaveLength(8);
  });

  it('группа в скобках занимает одну долю и делится внутри', () => {
    const { events } = parseMini('[bd sd]');
    expect(events.map((e) => round(e.begin))).toEqual([0, 0.5]);
  });

  it('чередование меняет элемент от такта к такту', () => {
    const { events } = parseMini('<a b>', { cycles: 2 });
    expect(values(events)).toEqual(['a', 'b']);
  });

  it('точка делит такт на две группы', () => {
    const { events } = parseMini('bd . sd sd');
    expect(events.map((e) => round(e.begin))).toEqual([0, 0.5, 0.75]);
  });

  it('вес @ даёт терму больше места', () => {
    const { events } = parseMini('bd@3 sd');
    expect(round(events[0].end)).toBe(0.75);
    expect(round(events[1].begin)).toBe(0.75);
  });

  it('замедление /n растягивает событие на n тактов', () => {
    const { events } = parseMini('bd/2');
    expect(events).toHaveLength(1);
    expect(round(events[0].end)).toBe(2);
  });

  it('евклидов ритм даёт заданное число пульсов', () => {
    const { events } = parseMini('cp(3,8)');
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.value === 'cp')).toBe(true);
  });

  it('евклидов алгоритм совпадает с известным E(3,8)', () => {
    expect(euclidPattern(3, 8)).toEqual([false, false, true, false, false, true, false, true]);
  });

  it('незакрытая скобка не роняет разбор, а попадает в errors', () => {
    const { events, errors } = parseMini('[bd sd');
    expect(errors.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('ноты и тональности', () => {
  it('имя ноты даёт MIDI-высоту', () => {
    expect(noteToMidi('c3')).toBe(48);
    expect(noteToMidi('c4')).toBe(60);
    expect(noteToMidi('a4')).toBe(69);
    expect(noteToMidi('f#4')).toBe(66);
    expect(noteToMidi('eb2')).toBe(39);
  });

  it('тональность разбирается на корни и лад', () => {
    const key = parseKey('a:minor');
    expect(key.pc).toBe(9);
    expect(key.mode).toBe('minor');
    expect(key.intervals).toEqual([0, 2, 3, 5, 7, 8, 10]);
    expect(parseKey('c#:major').pc).toBe(1);
    expect(parseKey('не тональность')).toBeNull();
  });

  it('ступень лада даёт высоту с учётом октав', () => {
    const key = parseKey('c:major');
    expect(degreeToMidi(0, key)).toBe(48);
    expect(degreeToMidi(2, key)).toBe(52);
    expect(degreeToMidi(7, key)).toBe(60);
  });

  it('аккорд разворачивается в набор высот', () => {
    expect(chordToMidi('Am')).toEqual([57, 60, 64]);
    expect(chordToMidi('C')).toEqual([48, 52, 55]);
  });

  it('ноты вне лада считаются и перечисляются', () => {
    const key = parseKey('c:major');
    const outside = notesOutsideScale([60, 61, 64, 66], key);
    expect(outside).toEqual([{ name: 'C#', count: 1 }, { name: 'F#', count: 1 }]);
    expect(pitchClass(61)).toBe(1);
  });
});

describe('извлечение из кода', () => {
  const code = [
    'setCpm(132/4)',
    'const key = "e:minor"',
    '$BASS: note("e1 e1 <e2 g2> e1").s("sawtooth").lpf(300).gain(.8)._pianoroll()',
    '$DRUMS: s("bd*4").gain(.9)._scope()',
  ].join('\n');

  it('находит партии, темп и тональность', () => {
    const track = extractTrack(code);
    expect(track.bpm).toBe(132);
    expect(track.key.name).toBe('e:minor');
    expect(track.parts.map((p) => p.label)).toEqual(['BASS', 'DRUMS']);
  });

  it('определяет роль партии по содержимому', () => {
    const track = extractTrack(code);
    expect(track.parts[0].role).toBe('bass');
    expect(track.parts[1].role).toBe('drums');
  });

  it('ударные не попадают в высоты, но считаются в ритме', () => {
    const track = extractTrack(code);
    const drums = partEvents(track.parts[1], track.key);
    // Разбираем два такта (нужны для чередований), в такте — четыре атаки.
    expect(drums.events.filter((e) => e.begin < 1)).toHaveLength(4);
    expect(drums.notes).toHaveLength(0);
  });

  it('убирает markdown-обёртку из ответа модели', () => {
    expect(stripCodeFences('```js\nsetCpm(120/4)\n```')).toBe('setCpm(120/4)');
    expect(stripCodeFences('пояснение\nsetCpm(120/4)')).toBe('пояснение\nsetCpm(120/4)');
  });
});

describe('метрики трека', () => {
  const techno = [
    'setCpm(132/4)',
    'const key = "e:minor"',
    '$BASS: note("e1 e1 e1 g1").s("sawtooth").gain(.8)._pianoroll()',
    '$DRUMS: s("bd*4, hh*8").gain(.8)._scope()',
  ].join('\n');

  it('считает плотность, диапазон и попадание в лад', () => {
    const { metrics } = analyzeTrack(techno);
    expect(metrics.density).toBe(16); // 4 ноты баса + 4 bd + 8 hh
    expect(metrics.range).toBe(3); // e1..g1 — терция
    expect(metrics.scaleFit).toBe(1);
    expect(metrics.partCount).toBe(2);
  });

  it('определяет тональность по нотам, если она не задана', () => {
    const { key, detectedKey } = analyzeTrack('$MEL: note("c4 e4 g4")._pianoroll()');
    expect(detectedKey).toMatch(/major/);
    expect(key.declared).toBe(false);
  });

  it('находит ноты вне заявленной тональности', () => {
    const code = 'const key = "c:major"\n$MEL: note("c4 db4 e4")._pianoroll()';
    const { outsideScale } = analyzeTrack(code);
    expect(outsideScale.map((o) => o.name)).toContain('C#');
  });
});

describe('скор', () => {
  const good = [
    'setCpm(132/4)',
    'const key = "e:minor"',
    '$BASS: note("e1 e1 e1 g1").s("sawtooth").lpf(300).gain(.8)._pianoroll()',
    '$DRUMS: s("bd*4, hh*8, cp(2,8)").gain(.8)._scope()',
    '$MEL: note("e4 g4 b4 e5").s("square").gain(.5)._pianoroll()',
  ].join('\n');

  const weak = [
    'setCpm(90/4)',
    'const key = "c:major"',
    '$DRUMS: s("bd*4").gain(.8)._scope()',
    '$MEL: note("c4 c4 e4 c4").s("triangle").gain(.6)._pianoroll()',
  ].join('\n');

  it('хороший трек набирает больше баллов, чем слабый', () => {
    const goodScore = scoreTrack(analyzeTrack(good), PROFILES.techno);
    const weakScore = scoreTrack(analyzeTrack(weak), PROFILES.techno);
    expect(goodScore.total).toBeGreaterThan(weakScore.total);
    expect(goodScore.total).toBeGreaterThan(70);
  });

  it('баллы критериев складываются в итог', () => {
    const score = scoreTrack(analyzeTrack(good), PROFILES.techno);
    const sum = score.criteria.reduce((acc, c) => acc + c.points, 0);
    expect(round(sum)).toBe(round(score.total));
    expect(score.criteria.reduce((acc, c) => acc + c.weight, 0)).toBe(100);
  });

  it('слабый трек получает конкретные замечания с подсказками', () => {
    const score = scoreTrack(analyzeTrack(weak), PROFILES.techno);
    expect(score.issues.length).toBeGreaterThan(0);
    const labels = score.issues.map((i) => i.label);
    expect(labels).toContain('Темп');
    expect(score.issues.every((i) => typeof i.hint === 'string' && i.hint.length > 20)).toBe(true);
  });

  it('разные стили дают разные оценки одному треку', () => {
    const analysis = analyzeTrack(weak);
    const asTechno = scoreTrack(analysis, PROFILES.techno);
    const asLoFi = scoreTrack(analysis, PROFILES.lofi);
    expect(asTechno.total).not.toBe(asLoFi.total);
  });
});

describe('референсы стилей', () => {
  it('стиль определяется по тексту запроса', () => {
    expect(detectStyle('жёсткий техно 132 bpm')).toBe('techno');
    expect(detectStyle('спокойный lo-fi с пианино')).toBe('lofi');
    expect(detectStyle('drum and bass, жидкий бас')).toBe('dnb');
    expect(detectStyle('что-то неопределённое')).toBe('generic');
  });

  it('явный стиль важнее угаданного по тексту', () => {
    expect(resolveProfile('ambient', 'техно трек').id).toBe('ambient');
    expect(resolveProfile(null, 'techno трек').id).toBe('techno');
  });

  it('у всех профилей заполнены цели', () => {
    for (const profile of Object.values(PROFILES)) {
      for (const key of ['bpm', 'density', 'offbeat', 'range', 'parts', 'motion', 'space']) {
        expect(Array.isArray(profile[key]), `${profile.id}.${key}`).toBe(true);
        expect(profile[key][0]).toBeLessThan(profile[key][1]);
      }
      expect(profile.scaleFit).toBeGreaterThan(0);
      expect(profile.separation).toBeGreaterThan(0);
    }
  });
});
