// Транспайлер режима «Разбор»: дескрипторы → план → Strudel-код.
//
// Проверяем не только форму, но и то, что код ИСПОЛНЯЕТСЯ в настоящем движке:
// паттерн без событий — это не двойник, а мусор.

import { describe, it, expect } from 'vitest';
import {
  descriptorsToSpec,
  chooseTempo,
  chooseKey,
  midiToNoteName,
  noteNameToMidi,
  detectStyle,
  roleToCode,
} from '../../server/deepdive/transpiler.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';
import { validateTrackSpec } from '../../src/schemas/track-spec.schema.js';
import { checkSpec } from '../../server/music/spec/check.js';

/** Дескрипторы синтетического трека: 4 секции, 140 BPM, C# minor. */
function fixture(overrides = {}) {
  const bpm = 140;
  const barSec = 240 / bpm; // ~1.714 с
  const sectionDur = barSec * 4;
  const hits = [];
  // Сетка 1/8 => 8 шагов в такте: доля 1 = шаг 0, 2 = шаг 2, 3 = шаг 4, 4 = шаг 6.
  // Кик на 1 и 3, снейр на 2 и 4, хэты на восьмых (шаги 1,3,5,7).
  for (let section = 0; section < 4; section += 1) {
    const start = section * sectionDur;
    for (let bar = 0; bar < 4; bar += 1) {
      const barStart = start + bar * barSec;
      hits.push({ time_s: barStart, gm: 36, velocity: 0.95, label: 'bd' });
      hits.push({ time_s: barStart + barSec / 2, gm: 36, velocity: 0.85, label: 'bd' });
      // Снейр с опозданием 12 мс — как в реальном lo-fi. Это измеренный
      // микротайминг, он и должен попасть в код.
      hits.push({ time_s: barStart + barSec / 4 + 0.012, gm: 38, velocity: 0.7, label: 'sd' });
      hits.push({ time_s: barStart + (3 * barSec) / 4 + 0.012, gm: 38, velocity: 0.72, label: 'sd' });
      for (const step of [1, 3, 5, 7]) {
        hits.push({ time_s: barStart + (step * barSec) / 8, gm: 42, velocity: 0.4 + step * 0.03, label: 'hh' });
      }
    }
  }
  return {
    track: { id: 'fixture', duration_s: sectionDur * 4 },
    measurements: {
      tempo: { bpm, confidence: 0.9, candidates: [{ bpm: bpm / 2, kind: 'half_time', confidence: 0.4 }] },
      key: { tonic: 'C#', mode: 'minor', confidence: 0.7 },
      loudness: { lufs_integrated: -8, true_peak_dbtp: -0.8 },
      spectral_balance: { sub: 0.3, low: 0.25, low_mid: 0.2, mid: 0.15, high_mid: 0.07, high: 0.03 },
    },
    structure: [0, 1, 2, 3].map((index) => ({
      index,
      start_s: index * sectionDur,
      end_s: (index + 1) * sectionDur,
      label: String.fromCharCode(65 + index),
      energy: index === 1 ? 0.8 : 0.45,
    })),
    stem_descriptors: {
      drums: {
        activity: { 0: 0.4, 1: 0.9, 2: 0.6, 3: 0.3 },
        onsets: {
          count: hits.length,
          grid: { step: '1/8', fit_ratio: 0.82 },
          swing: 0.56,
          hits,
        },
      },
      bass: {
        activity: { 0: 0.5, 1: 0.9, 2: 0.7, 3: 0.4 },
        pitch: {
          notes: [0, 1, 2, 3].flatMap((section) =>
            [0, 1, 2, 3].map((bar) => ({
              time_s: section * sectionDur + bar * barSec,
              duration_s: barSec / 2,
              midi: section % 2 === 0 ? 37 : 40,
              note_name: 'c#2',
              confidence: 0.8,
            })),
          ),
        },
      },
      other: {
        activity: { 0: 0.6, 1: 0.8, 2: 0.7, 3: 0.5 },
        chords: [
          { start_s: 0, end_s: sectionDur, root: 'C#', quality: 'minor', confidence: 0.6 },
          { start_s: sectionDur, end_s: sectionDur * 2, root: 'G#', quality: 'major', confidence: 0.5 },
          { start_s: sectionDur * 2, end_s: sectionDur * 3, root: 'A', quality: 'minor', confidence: 0.5 },
          { start_s: sectionDur * 3, end_s: sectionDur * 4, root: 'F#', quality: 'major', confidence: 0.5 },
        ],
      },
    },
    ...overrides,
  };
}

describe('транспайлер: дескрипторы → план → код', () => {
  it('строит валидный план', () => {
    const { spec } = descriptorsToSpec(fixture());
    expect(() => validateTrackSpec(spec)).not.toThrow();
    const checked = checkSpec(spec);
    expect(checked.errors).toEqual([]);
    expect(checked.ok).toBe(true);
  });

  it('форма укладывается в 16..96 тактов', () => {
    const { spec, report } = descriptorsToSpec(fixture());
    const total = spec.structure.sections.reduce((sum, section) => sum + section.cycles, 0);
    expect(total).toBeGreaterThanOrEqual(16);
    expect(total).toBeLessThanOrEqual(96);
    expect(report.bars).toBe(total);
  });

  it('темп и лад берутся из измерений, а не выдумываются', () => {
    const { spec } = descriptorsToSpec(fixture());
    expect(spec.meta.bpm).toBe(140);
    expect(spec.meta.key).toBe('C#min');
  });

  it('половинный темп подставляется, только если основной вне диапазона схемы', () => {
    const slow = fixture();
    slow.measurements.tempo = {
      bpm: 45,
      confidence: 0.6,
      candidates: [{ bpm: 90, kind: 'double_time', confidence: 0.8 }],
    };
    const { spec, report } = descriptorsToSpec(slow);
    expect(spec.meta.bpm).toBe(90);
    expect(report.decisions.tempo.shifted).toBe('double_time');
  });

  it('ударные раскладываются по измеренной сетке (группы шагов)', () => {
    const { spec } = descriptorsToSpec(fixture());
    const kick = spec.parts.roles.kick;
    expect(kick).toBeTruthy();
    // Кик на 1 и 3 доли => шаги 0 и 8 в сетке 1/16.
    const kickSteps = kick.sections ? Object.values(kick.sections)[0].groups.flatMap((g) => g.steps) : [];
    expect(kickSteps.sort((a, b) => a - b)).toEqual([0, 8]);
    const snare = spec.parts.roles.snare;
    const snareSteps = Object.values(snare.sections)[0].groups.flatMap((g) => g.steps);
    expect(snareSteps.sort((a, b) => a - b)).toEqual([4, 12]);
    const hats = spec.parts.roles.hats;
    const hatSteps = Object.values(hats.sections)[0].groups.flatMap((g) => g.steps);
    expect(hatSteps.sort((a, b) => a - b)).toEqual([2, 6, 10, 14]);
  });

  it('velocity измерений попадает в динамику групп', () => {
    const { spec } = descriptorsToSpec(fixture());
    const kick = spec.parts.roles.kick;
    const groups = Object.values(kick.sections)[0].groups;
    expect(groups.length).toBeGreaterThan(0);
    const gains = groups.map((g) => g.gain);
    expect(Math.max(...gains)).toBeGreaterThan(0.8); // измеренный кик громкий
    expect(Math.min(...gains)).toBeGreaterThan(0);
  });

  it('микротайминг из измерений выражен сдвигом, а не параметром свинга', () => {
    const { code } = descriptorsToSpec(fixture());
    // swingBy в Strudel 1.3.0 дублирует события — использовать нельзя.
    expect(code).not.toMatch(/swingBy\(/);
    expect(code).toMatch(/\.beat\("/);
    // Измеренный сдвиг (снейр позади на 12 мс) попадает в .late(ms(...)).
    expect(code).toMatch(/\.late\(ms\(/);
  });

  it('ровные удары не получают лишнего сдвига', () => {
    const even = fixture();
    even.stem_descriptors.drums.onsets.hits = even.stem_descriptors.drums.onsets.hits.map((hit) => (
      hit.gm === 38 ? { ...hit, time_s: hit.time_s - 0.012 } : hit
    ));
    const { code } = descriptorsToSpec(even);
    // Ровные удары лежат точно на сетке — сдвига в коде быть не должно.
    expect(code).not.toMatch(/\.late\(ms\(/);
  });

  it('код исполняется в настоящем движке и даёт события', async () => {
    const { code } = descriptorsToSpec(fixture());
    const run = await runStrudel(code, { cycles: 8 });
    expect(run.ok).toBe(true);
    expect(run.order.length).toBeGreaterThan(0);
    for (const part of run.order) {
      expect(run.parts[part].length).toBeGreaterThan(0);
    }
    // Ударные должны дать события с нотой сэмпла.
    const drumPart = run.order.find((name) => name === 'KICK');
    expect(drumPart).toBeTruthy();
    const events = run.parts[drumPart];
    expect(events.length).toBeGreaterThan(4);
    expect(events[0].value?.s ?? events[0].s).toBeTruthy();
  });

  it('слой можно отрендерить отдельно (для честного сравнения слоёв)', async () => {
    const { spec } = descriptorsToSpec(fixture());
    const bassCode = roleToCode(spec, 'bass');
    expect(bassCode).toMatch(/\$BASS:/);
    expect(bassCode).not.toMatch(/\$KICK:/);
    const run = await runStrudel(bassCode, { cycles: 8 });
    expect(run.ok).toBe(true);
    expect(run.order).toContain('BASS');
  });

  it('честные ограничения попадают в отчёт', () => {
    const { report } = descriptorsToSpec(fixture());
    expect(report.honesty.not_reproduced).toContain('вокал');
    expect(report.honesty.caveats.join(' ')).toMatch(/portamento|глайд/i);
    expect(['low', 'medium', 'high']).toContain(report.honesty.overall_confidence);
  });

  it('без измерений стемов не выдумывает роли', () => {
    const empty = fixture();
    empty.stem_descriptors = {};
    const { spec, report } = descriptorsToSpec(empty);
    expect(Object.keys(spec.parts.roles)).toHaveLength(0);
    expect(report.honesty.overall_confidence).toBe('low');
  });

  it('редкие удары не выбивают роль из плана: пустой такт не побеждает', () => {
    const base = fixture();
    const barSec = 240 / 140;
    // Удары только в первом такте каждой секции: три такта из четырёх пустые.
    // Раньше «доминирующим» выбирался пустой такт (их просто больше), роль
    // выпадала, а вместе с ней обрывалась сборка всего плана.
    const sparse = base.stem_descriptors.drums.onsets.hits.filter(
      (hit) => Math.floor(hit.time_s / barSec) % 4 === 0,
    );
    expect(sparse.length).toBeGreaterThan(0);

    const { spec } = descriptorsToSpec(fixture({
      stem_descriptors: {
        ...base.stem_descriptors,
        drums: {
          ...base.stem_descriptors.drums,
          onsets: { ...base.stem_descriptors.drums.onsets, hits: sparse },
        },
      },
    }));

    const roles = Object.keys(spec.parts.roles ?? {});
    expect(roles).toContain('kick');
  });

  it('без стемов, но с запасным ритмом из микса, двойник всё равно строится', () => {
    const base = fixture();
    const rhythm = base.stem_descriptors.drums;
    const { spec } = descriptorsToSpec(fixture({
      stem_descriptors: {},
      rhythm: { source: 'mix', activity: rhythm.activity, onsets: rhythm.onsets },
    }));

    const roles = Object.keys(spec.parts.roles ?? {});
    expect(roles).toContain('kick');
    // Бас без измеренного питч-трека не выдумывается.
    expect(roles).not.toContain('bass');
  });
});

describe('вспомогательные функции транспайлера', () => {
  it('MIDI ↔ имя ноты ходят туда-обратно', () => {
    expect(midiToNoteName(60)).toBe('c4');
    expect(midiToNoteName(37)).toBe('c#2');
    expect(noteNameToMidi('c#2')).toBe(37);
    expect(noteNameToMidi('a4')).toBe(69);
    expect(noteNameToMidi('не нота')).toBeNull();
  });

  it('выбор темпа уважает диапазон схемы', () => {
    expect(chooseTempo({ bpm: 120 }).bpm).toBe(120);
    expect(chooseTempo({ bpm: 200, candidates: [{ bpm: 100, kind: 'half_time' }] }).bpm).toBe(100);
    expect(chooseTempo({ bpm: 30 }).bpm).toBe(60);
  });

  it('выбор лада даёт строку, которую понимает компилятор', () => {
    expect(chooseKey({ tonic: 'C#', mode: 'minor' }).key).toBe('C#min');
    expect(chooseKey({ tonic: 'F', mode: 'major' }).key).toBe('Fmajor');
  });

  it('стиль выводится из измерений, а не из названия', () => {
    const trap = fixture();
    trap.measurements.tempo.bpm = 92;
    expect(detectStyle(trap)).toBe('trap');

    const dubstep = fixture();
    dubstep.measurements.tempo.bpm = 150;
    dubstep.measurements.spectral_balance = { sub: 0.36, low: 0.24, low_mid: 0.15, mid: 0.15, high_mid: 0.06, high: 0.04 };
    expect(detectStyle(dubstep)).toBe('dubstep');

    const techno = fixture();
    techno.measurements.tempo.bpm = 128;
    techno.measurements.spectral_balance = { sub: 0.12, low: 0.2, low_mid: 0.24, mid: 0.24, high_mid: 0.12, high: 0.08 };
    expect(detectStyle(techno)).toBe('techno');

    const lofi = fixture();
    lofi.measurements.tempo.bpm = 78;
    expect(detectStyle(lofi)).toBe('lo-fi');
  });
});
