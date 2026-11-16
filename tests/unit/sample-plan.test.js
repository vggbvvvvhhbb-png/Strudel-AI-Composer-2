// Паспорт → план (D-119): измеренные признаки становятся музыкальными решениями,
// неизмеренное остаётся «нет данных», а не выдуманным числом.
import { describe, it, expect } from 'vitest';

import {
  TEMPO_CONFIDENCE_MIN,
  VOICED_RATIO_MIN,
  passportHints,
  sampleSoundName,
  rhythmPattern,
  rerootHarmony,
  attacksFromDensity,
  applySamplePlan,
} from '../../server/music/compose/sample-plan.js';
import { fallbackSpec, buildTrack } from '../../server/music/compose/pipeline.js';
import { checkSpec } from '../../server/music/spec/check.js';
import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { poolAudioFile } from '../../server/deepdive/render/render-worker.mjs';
import { runTool } from '../../server/agent/tools.js';

const tonalPassport = {
  tonal: { f0Hz: 233.08, note: 'A#', voicedRatio: 0.7 },
  tempo: { bpm: 129.2, confidence: 0.8 },
  transients: { count: 40, densityPerSec: 4 },
  spectral: { centroidHz: 3600 },
  character: ['яркий'],
};

describe('passportHints: измеренное и «нет данных»', () => {
  it('надёжный тон становится тональностью, лад — осознанное допущение', () => {
    const hints = passportHints(tonalPassport);
    expect(hints.key).toBe('A#min');
    expect(hints.sources.key).toContain('измеренный тон A#');
    expect(hints.sources.key).toContain('допущение');
  });

  it('ненадёжный тон — это «нет данных», а не выдуманная тональность', () => {
    const hints = passportHints({ tonal: { note: 'A#', voicedRatio: VOICED_RATIO_MIN - 0.01 } });
    expect(hints.key).toBeNull();
    expect(hints.sources.key).toContain('нет данных');
  });

  it('уверенный темп берётся и приводится к диапазону схемы', () => {
    expect(passportHints({ tempo: { bpm: 129.2, confidence: TEMPO_CONFIDENCE_MIN } }).bpm).toBe(129);
    expect(passportHints({ tempo: { bpm: 200, confidence: 0.9 } }).bpm).toBe(100);
    expect(passportHints({ tempo: { bpm: 45, confidence: 0.9 } }).bpm).toBe(90);
  });

  it('неуверенный темп — «нет данных» с причиной', () => {
    const hints = passportHints({ tempo: { bpm: 129.2, confidence: TEMPO_CONFIDENCE_MIN - 0.01 } });
    expect(hints.bpm).toBeNull();
    expect(hints.sources.bpm).toContain('нет данных');
    expect(hints.sources.bpm).toContain('129.2');
  });

  it('плотность атак превращается в атаки на такт', () => {
    const hints = passportHints(tonalPassport);
    // 4 атаки/с × (240/129) с/такт ≈ 7.44 → 7
    expect(hints.attacksPerBar).toBe(7);
    expect(hints.sources.rhythm).toContain('измеренная плотность');
  });

  it('пустой паспорт не падает и ничего не выдумывает', () => {
    const hints = passportHints(null);
    expect(hints.key).toBeNull();
    expect(hints.bpm).toBeNull();
    expect(hints.attacksPerBar).toBeNull();
    expect(Object.values(hints.sources).every((text) => text.includes('нет данных'))).toBe(true);
  });
});

describe('ритм и гармония из паспорта', () => {
  it('имя сэмпла пула пригоден для компилятора', () => {
    expect(sampleSoundName('406350')).toBe('hunter_406350');
    expect(sampleSoundName('a/b c')).toMatch(/^[\w]+$/);
  });

  it('рисунок расставляет N атак равномерно по 16 долям', () => {
    const pattern = rhythmPattern('hunter_x', 4);
    const tokens = pattern.split(' ');
    expect(tokens.length).toBe(16);
    expect(tokens.filter((t) => t === 'hunter_x').length).toBe(4);
    expect(tokens[0]).toBe('hunter_x');
    expect(rhythmPattern('hunter_x', null).split(' ').filter((t) => t === 'hunter_x').length).toBe(4);
    expect(rhythmPattern('hunter_x', 99).split(' ').every((t) => t === 'hunter_x')).toBe(true);
  });

  it('прогрессия переносится в тональность сэмпла с сохранением качеств', () => {
    expect(rerootHarmony('Cm Fm Gm Cm', 'A#min')).toBe('A#m D#m Fm A#m');
    expect(rerootHarmony('Ab Bb Cm Gm', 'A#min')).toBe('A# C Dm Am');
    expect(rerootHarmony('Cm Fm Gm Cm', 'Cmin')).toBe('Cm Fm Gm Cm');
    expect(rerootHarmony('Cm Fm Gm Cm', 'не тональность')).toBe('Cm Fm Gm Cm');
  });

  it('attacksFromDensity: нет плотности — нет числа', () => {
    expect(attacksFromDensity(null, 120)).toBeNull();
    expect(attacksFromDensity(4, 120)).toBe(8);
    expect(attacksFromDensity(100, 120)).toBe(16);
  });
});

describe('applySamplePlan: сэмпл в спеке', () => {
  const entry = { id: '406350', name: 'Glass', licenseId: 'cc0', passport: tonalPassport };

  it('партия HUNTER_1 играет сэмпл, спека проходит проверку и компиляцию', () => {
    const base = fallbackSpec('techno', 1);
    const { spec, applied } = applySamplePlan(base, { entry });
    expect(applied.sound).toBe('hunter_406350');
    const part = spec.parts.roles.HUNTER_1;
    expect(part.role).toBe('perc');
    expect(part.sound).toBe('hunter_406350');
    expect(part.pattern).toContain('hunter_406350');
    // activeIn без дублей: форма содержит повторяющиеся имена секций.
    expect(new Set(part.activeIn).size).toBe(part.activeIn.length);
    const checked = checkSpec(spec);
    expect(checked.errors ?? []).toEqual([]);
    expect(checked.ok).toBe(true);
    const code = compileTrackSpec(spec);
    expect(code).toContain('hunter_406350');
  });

  it('измеренные тон и темп переопределяют мету, гармония переносится', () => {
    const base = fallbackSpec('techno', 1);
    const { spec, applied } = applySamplePlan(base, { entry });
    expect(spec.meta.key).toBe('A#min');
    expect(spec.meta.bpm).toBe(129);
    expect(applied.harmonyRerooted).toBe(true);
    for (const section of spec.structure.sections) {
      // Первый аккорд — тоника A#; качество аккорда сохраняется (мажор остаётся мажором).
      expect(section.harmony.split(' ')[0]).toMatch(/^A#(m|$)/);
    }
  });

  it('неизмеренные тон и темп НЕ переопределяют мету', () => {
    const base = fallbackSpec('techno', 1);
    const weak = { id: '1', passport: { tonal: { note: 'C', voicedRatio: 0.1 }, tempo: { bpm: 100, confidence: 0.05 } } };
    const { spec, applied } = applySamplePlan(base, { entry: weak });
    expect(spec.meta.key).toBe(base.meta.key);
    expect(spec.meta.bpm).toBe(base.meta.bpm);
    expect(applied.key).toBeNull();
    expect(applied.bpm).toBeNull();
  });

  it('плотность атак пересчитывается под итоговый темп трека', () => {
    const base = fallbackSpec('techno', 1);
    const { spec, applied } = applySamplePlan(base, { entry });
    // 4 атаки/с × 240/129 ≈ 7.44 → 7, а не 8 при дефолтных 120.
    expect(applied.attacksPerBar).toBe(attacksFromDensity(4, spec.meta.bpm));
    expect(spec.reasoning).toContain(`${spec.meta.bpm} BPM`);
  });
});

describe('buildTrack с сэмплом пула', () => {
  it('без модели план собирается из библиотеки, но сэмпл и паспорт остаются', async () => {
    const entry = { id: '406350', name: 'Glass', licenseId: 'cc0', passport: tonalPassport };
    const result = await buildTrack({
      prompt: 'бит вокруг стеклянного звука',
      seed: 7,
      sampleEntry: entry,
      completeChat: async () => { throw new Error('модель недоступна'); },
    });
    expect(result.usedFallback).toBe(true);
    expect(result.sample).not.toBeNull();
    expect(result.spec.parts.roles.HUNTER_1.sound).toBe('hunter_406350');
    expect(result.compiled.code).toContain('hunter_406350');
  });

  it('compose_spec с несуществующим sampleId честно отказывает', async () => {
    const result = await runTool('compose_spec', { prompt: 'бит', sampleId: 'нет-такого-в-пуле' }, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('не найден в локальном пуле');
  });
});

describe('раздача WAV пула в рендер', () => {
  it('пути и обход каталога отвергаются', () => {
    expect(poolAudioFile('../pool.json')).toBeNull();
    expect(poolAudioFile('..\\evil.wav')).toBeNull();
    expect(poolAudioFile('a/b.wav')).toBeNull();
    expect(poolAudioFile('evil.mp3')).toBeNull();
    expect(poolAudioFile('')).toBeNull();
    expect(poolAudioFile(null)).toBeNull();
  });

  it('несуществующий файл — null, а не ошибка', () => {
    expect(poolAudioFile('net-takogo-999999999.wav')).toBeNull();
  });
});