// Каденция знает гармонию (D-123).
//
// Компилятор сдвигает партию корнем текущего аккорда (.add(n("<roots>"))).
// Анализатор обязан видеть ТО, ЧТО ЗВУЧИТ: ступень + корень, — и судить
// каденцию по последнему аккорду секции, а не по глобальной тонике.
// Здесь три контракта: извлечение сдвига, метрика против последнего
// аккорда и регресс демо-оперы (все концы фраз — тоны текущего аккорда).

import { describe, it, expect } from 'vitest';

import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { analyzeTrack } from '../../server/music/features.js';
import { extractTrack, partEvents } from '../../server/music/extract.js';
import { validateTrackSpec } from '../../src/schemas/track-spec.schema.js';
import { specFromPlan } from '../../src/music/expand.js';
import { degreeToMidi, parseKey } from '../../server/music/notes.js';

function specWith(parts, sections) {
  return validateTrackSpec({
    meta: { style: 'cinematic', key: 'Cmin', bpm: 90 },
    structure: { sections },
    parts: { roles: parts },
  });
}

describe('извлечение сдвига по корням аккордов', () => {
  it('корни и slow берутся из .add(n("<...>").slow(k))', () => {
    const code = compileTrackSpec(specWith({
      LEAD: { role: 'lead', activeIn: ['verse'], pattern: '0 2 4 2', sound: 'triangle' },
    }, [{ name: 'verse', cycles: 16, energy: 0.5, harmony: 'Cm Ab' }]));
    const track = extractTrack(code);
    const source = track.parts[0].sources.find((s) => s.section === 'verse');
    expect(source.roots).toEqual([0, 5]);
    expect(source.rootSlow).toBe(8);
  });

  it('последний корень считается по длине секции: делимой и неделимой', () => {
    // 16 тактов, 2 аккорда, slow 8: последний такт — второй аккорд (Ab, 5).
    const even = compileTrackSpec(specWith({
      LEAD: { role: 'lead', activeIn: ['verse'], pattern: '0 2 4 2', sound: 'triangle' },
    }, [{ name: 'verse', cycles: 16, energy: 0.5, harmony: 'Cm Ab' }]));
    const evenPart = partEvents(extractTrack(even).parts[0], parseKey('c:minor'));
    expect(evenPart.sections[0].lastRoot).toBe(5);
    expect(evenPart.sections[0].harmony).toBe(true);
    expect(evenPart.sections[0].lastDegreeRaw).toBe(2);

    // 17 тактов, 2 аккорда, slow 1: такт 16 (индекс 16) — 16 % 2 = 0 → Cm.
    const odd = compileTrackSpec(specWith({
      LEAD: { role: 'lead', activeIn: ['verse'], pattern: '0 2 4 2', sound: 'triangle' },
    }, [{ name: 'verse', cycles: 17, energy: 0.5, harmony: 'Cm Ab' }]));
    const oddPart = partEvents(extractTrack(odd).parts[0], parseKey('c:minor'));
    expect(oddPart.sections[0].lastRoot).toBe(0);
  });

  it('высоты звучат со сдвигом: первый аккорд Ab поднимает тонику на 8 полутонов', () => {
    const code = compileTrackSpec(specWith({
      LEAD: { role: 'lead', activeIn: ['verse'], pattern: '0 2 4 2', sound: 'triangle' },
    }, [{ name: 'verse', cycles: 16, energy: 0.5, harmony: 'Ab Cm' }]));
    const track = extractTrack(code);
    const key = parseKey('c:minor');
    const parsed = partEvents(track.parts[0], key);
    const first = parsed.sections[0].notes[0];
    expect(first.midi).toBe(degreeToMidi(5, key));
    expect(first.midi - degreeToMidi(0, key)).toBe(8);
  });

  it('без гармонии сдвига нет: секция честно без гармонии', () => {
    const code = compileTrackSpec(specWith({
      LEAD: { role: 'lead', activeIn: ['verse'], pattern: '0 2 4 2', sound: 'triangle' },
    }, [{ name: 'verse', cycles: 16, energy: 0.5, harmony: 'free' }]));
    const parsed = partEvents(extractTrack(code).parts[0], parseKey('c:minor'));
    expect(parsed.sections[0].harmony).toBe(false);
    expect(parsed.sections[0].lastRoot).toBeNull();
  });
});

describe('каденция судится по последнему аккорду секции', () => {
  it('конец на корне ПОСЛЕДНЕГО аккорда — разрешение, даже не тоника лада', () => {
    // Секция целиком на Ab (ступень 5): паттерн кончается на 0 до сдвига,
    // звучит корень Ab. Глобальная тоника C тут ни при чём.
    const code = compileTrackSpec(specWith({
      LEAD: { role: 'lead', activeIn: ['verse'], pattern: '2 4 4 0', sound: 'triangle' },
    }, [{ name: 'verse', cycles: 16, energy: 0.5, harmony: 'Ab' }]));
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.cadenceClarity).toBe(1);
    expect(analysis.metrics.resolution).toBe(1);
  });

  it('конец не на тоне последнего аккорда — каденции нет', () => {
    // Ступень 1 + корень 5 = 6: не входит в трезвучие Ab {5, 0, 2}.
    const code = compileTrackSpec(specWith({
      LEAD: { role: 'lead', activeIn: ['verse'], pattern: '2 4 4 1', sound: 'triangle' },
    }, [{ name: 'verse', cycles: 16, energy: 0.5, harmony: 'Ab' }]));
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.cadenceClarity).toBe(0);
    expect(analysis.metrics.resolution).toBe(0);
  });

  it('без гармонии — прежняя проверка по тонике лада', () => {
    const code = compileTrackSpec(specWith({
      LEAD: { role: 'lead', activeIn: ['verse'], pattern: '2 4 4 0', sound: 'triangle' },
    }, [{ name: 'verse', cycles: 16, energy: 0.5, harmony: 'free' }]));
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.cadenceClarity).toBe(1);
    expect(analysis.metrics.resolution).toBe(1);
  });
});

describe('регресс демо-оперы: концы фраз разрешаются в текущий аккорд', () => {
  const plan = {
    style: 'cinematic',
    key: 'Cmin',
    bpm: 90,
    sections: [
      { name: 'intro', bars: 8, energy: 0.35, harmony: 'Cm' },
      { name: 'verse', bars: 8, energy: 0.55, harmony: 'Cm Ab' },
      { name: 'drop', bars: 16, energy: 0.9, harmony: 'Cm Gm Ab Bb' },
    ],
    groups: [
      { group: 'strings', role: 'violin', count: 10 },
      { group: 'strings', role: 'viola', count: 4 },
      { group: 'strings', role: 'cello', count: 4 },
      { group: 'brass', role: 'horn', count: 4 },
      { group: 'woodwinds', role: 'flute', count: 4 },
      { group: 'keys', role: 'piano', count: 4 },
      { group: 'choir', role: 'choir_soprano', count: 4 },
      { group: 'lead', role: 'lead', count: 2 },
    ],
  };
  // Роли, которые несут тему (дивизи): их концы фраз — каденции.
  const THEMED = new Set(['violin', 'viola', 'cello', 'horn', 'flute', 'piano', 'choir_soprano', 'lead']);

  it('каждый конец фразы — тон трезвучия последнего аккорда секции', () => {
    const { spec: rawSpec } = specFromPlan(plan);
    const code = compileTrackSpec(validateTrackSpec(rawSpec));
    const track = extractTrack(code);
    const key = track.key;
    let checked = 0;
    let resolved = 0;
    for (const part of track.parts) {
      if (!THEMED.has(part.role)) continue;
      const parsed = partEvents(part, key);
      for (const section of parsed.sections) {
        if (!section.harmony || !Number.isFinite(section.lastDegreeRaw)) continue;
        const root = section.lastRoot;
        const sounding = (((section.lastDegreeRaw + root) % 7) + 7) % 7;
        const tones = new Set([root, (root + 2) % 7, (root + 4) % 7]);
        expect(tones.has(sounding)).toBe(true);
        if (sounding === root) resolved += 1;
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
    // Вариант A'' (полное разрешение) реально встречается: не все концы
    // половинные каденции.
    expect(resolved).toBeGreaterThan(0);
  });

  it('метрики оперы: каденция видна, диапазон измерен по звучащим высотам', () => {
    const { spec: rawSpec } = specFromPlan(plan);
    const code = compileTrackSpec(validateTrackSpec(rawSpec));
    const analysis = analyzeTrack(code);
    expect(analysis.metrics.cadenceClarity).toBeGreaterThan(0.9);
    expect(analysis.metrics.resolution).toBeGreaterThan(0.2);
    // Анализатор берёт ноты первого такта секции; в демо-опере все секции
    // начинаются с тоники (корень 0), поэтому сдвиг диапазон не меняет:
    // 20 полутонов и с гармонией, и без (замер 16.11.2026).
    expect(analysis.metrics.melodyRange).toBe(20);

    // Если секция начинается с нетонического аккорда, сдвиг ВИДЕН в
    // диапазоне: intro на Ab поднимает первый такт на 8 полутонов → 29.
    const planAb = { ...plan, sections: plan.sections.map((s, i) => (i === 0 ? { ...s, harmony: 'Ab' } : s)) };
    const shifted = analyzeTrack(compileTrackSpec(validateTrackSpec(specFromPlan(planAb).spec)));
    expect(shifted.metrics.melodyRange).toBe(29);
  });
});