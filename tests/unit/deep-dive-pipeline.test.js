// Пайплайн режима «Разбор» целиком: файл → измерения → двойник → рендер →
// сравнение.
//
// Python-воркер и браузер подменяются заглушками: пайплайн должен собираться и
// проверяться в CI без них. Проверяем не «что-то вернулось», а честность:
// baseline зафиксирован, ограничения в отчёте, отсутствующие слои — «нет данных».

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runDeepDive } from '../../server/deepdive/pipeline.js';
import { encodeWav } from '../../src/core/wav.js';

const SR = 44100;

/** Клик-трек: 120 BPM, бочка на каждой восьмой. */
function clickTrack(seconds = 8) {
  const length = Math.round(seconds * SR);
  const signal = new Float64Array(length);
  const eighth = 0.25;
  for (let t = 0; t < seconds; t += eighth) {
    const start = Math.round(t * SR);
    for (let i = 0; i < 2000 && start + i < length; i += 1) {
      signal[start + i] += 0.8 * Math.exp(-i / 60) * Math.sin((2 * Math.PI * 150 * i) / SR);
    }
  }
  return signal;
}

function wavBuffer(seconds = 8) {
  const mono = clickTrack(seconds);
  return Buffer.from(encodeWav([mono, mono], SR));
}

let workspace;
let inputPath;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'deepdive-pipeline-'));
  inputPath = path.join(workspace, 'input.wav');
  await writeFile(inputPath, wavBuffer(8));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Заглушки внешних зависимостей. */
function makeDeps(overrides = {}) {
  return {
    convert: async (from, to) => {
      const { copyFile } = await import('node:fs/promises');
      await copyFile(from, to);
      return { ok: true, sampleRate: SR };
    },
    analyze: async () => ({
      measurements: {
        tempo: { bpm: 120, confidence: 0.9, candidates: [{ bpm: 120, kind: 'primary', confidence: 0.9 }] },
        key: { tonic: 'C', mode: 'minor', confidence: 0.8 },
        loudness: { lufs_integrated: -12, true_peak_dbtp: -1 },
      },
      structure: [
        { index: 0, start_s: 0, end_s: 4, label: 'A', energy: 0.5 },
        { index: 1, start_s: 4, end_s: 8, label: 'B', energy: 0.8 },
      ],
    }),
    analyzeStems: async () => ({
      stem_descriptors: {
        bass: { pitch: { notes: [{ time_s: 0, midi: 36, duration_s: 0.5, confidence: 0.8 }] } },
        other: { chords: [{ start_s: 0, end_s: 4, root: 'C', quality: 'minor', confidence: 0.7 }] },
      },
    }),
    separate: async (_from, outDir) => {
      await mkdir(outDir, { recursive: true });
      const stems = {};
      for (const name of ['drums', 'bass', 'other']) {
        const file = path.join(outDir, `${name}.wav`);
        await writeFile(file, wavBuffer(8));
        stems[name] = file;
      }
      return { stems, seconds: 12, model: 'htdemucs' };
    },
    render: async (code) => ({
      ok: true,
      report: {},
      wav: wavBuffer(4),
      events: null,
      sampleRate: SR,
      durationS: 4,
      renderMs: 42,
      wallMs: 50,
      fingerprint: { browser: 'test', sample_rate: SR, code_sha256: 'test' },
      code,
    }),
    ...overrides,
  };
}

describe('пайплайн разбора', () => {
  it('собирает результат по контракту и не выдумывает лишнего', async () => {
    const jobDir = path.join(workspace, 'job-1');
    const { result } = await runDeepDive({
      workspaceDir: jobDir,
      inputPath,
      fileName: 'test.wav',
      separate: true,
      deps: makeDeps(),
    });

    expect(result.schema_version).toBe('0.1');
    expect(result.track.duration_s).toBeGreaterThan(0);
    // Темп взят из измерений, а не придуман.
    expect(result.measurements.tempo.bpm).toBe(120);
    expect(result.measurements.key.tonic).toBe('C');
    expect(result.measurements.loudness.lufs_integrated).toBeTypeOf('number');
    // Спектральный баланс — доли, в сумме единица.
    const balance = Object.values(result.measurements.spectral_balance).reduce((a, b) => a + b, 0);
    expect(balance).toBeCloseTo(1, 2);
    // Структура пришла из измерений.
    expect(result.structure).toHaveLength(2);
    expect(result.structure[0].label).toBe('A');
    // Слои измерены.
    expect(result.stem_descriptors.drums.onsets.count).toBeGreaterThan(0);
    expect(result.stem_descriptors.bass.pitch.notes.length).toBeGreaterThan(0);
    // Код-двойник собран и содержит темп из измерений.
    expect(result.code_twin.code).toContain('setCpm(120/4)');
    // Baseline зафиксирован ДО улучшений.
    expect(result.code_twin.metrics[0].iteration).toBe(0);
    expect(result.code_twin.metrics[0].label).toBe('baseline');
    // Ограничения записаны — это обязательная часть отчёта.
    expect(result.code_twin.honesty.caveats).toContain('вокал не воспроизводится');
    expect(result.code_twin.honesty.caveats).toContain('точное сведение и мастеринг не воспроизводятся');
    // Итераций самоулучшения ещё не было.
    expect(result.code_twin.iterations).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('без стемов разбор продолжается, а метрика не выдумывается', async () => {
    const jobDir = path.join(workspace, 'job-2');
    const { result } = await runDeepDive({
      workspaceDir: jobDir,
      inputPath,
      fileName: 'test.wav',
      separate: false,
      deps: makeDeps(),
    });

    expect(result.stems.drums.available).toBe(false);
    expect(result.stem_descriptors.drums).toBeUndefined();
    // Слой не измерен — метрики слоя не должно быть, но общий замер есть.
    expect(result.code_twin.metrics.length).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('без разделения ритм двойника берётся из микса, и это сказано в отчёте', async () => {
    const jobDir = path.join(workspace, 'job-2b');
    const { result } = await runDeepDive({
      workspaceDir: jobDir,
      inputPath,
      fileName: 'test.wav',
      separate: false,
      deps: makeDeps(),
    });

    // Слой ударных не измерен — в контракте его быть не должно. Ритм из микса
    // не выдаётся за измерение стема.
    expect(result.stem_descriptors.drums).toBeUndefined();
    // Но двойник без ритма бессмысленен: хотя бы одна роль ударных должна быть.
    const drumRoles = ['kick', 'snare', 'hats', 'perc'];
    const roles = Object.keys(result.code_twin.plan.parts.roles ?? {});
    expect(drumRoles.some((role) => roles.includes(role))).toBe(true);
    // Деградация — это оговорка, а не ошибка: разбор-то прошёл.
    expect(result.errors).toEqual([]);
    expect(
      result.code_twin.honesty.caveats.some((caveat) => caveat.includes('извлечён из микса')),
    ).toBe(true);
  });

  it('запасной ритм доступен экспорту MIDI, даже когда стемов нет', async () => {
    const jobDir = path.join(workspace, 'job-2c');
    const { artifacts } = await runDeepDive({
      workspaceDir: jobDir,
      inputPath,
      fileName: 'test.wav',
      separate: false,
      deps: makeDeps(),
    });

    expect(artifacts.rhythm).not.toBeNull();
    expect(artifacts.rhythm.source).toBe('mix');
    expect(artifacts.rhythm.onsets.hits.length).toBeGreaterThan(0);
  });

  it('падение разделения не роняет разбор, а попадает в errors', async () => {    const jobDir = path.join(workspace, 'job-3');
    const deps = makeDeps({
      separate: async () => {
        throw new Error('Demucs: не хватило памяти');
      },
    });
    const { result } = await runDeepDive({
      workspaceDir: jobDir,
      inputPath,
      fileName: 'test.wav',
      separate: true,
      deps,
    });

    expect(result.errors.some((error) => error.stage === 'separate')).toBe(true);
    expect(result.stems.drums.available).toBe(false);
    // Код-двойник всё равно построен.
    expect(result.code_twin.code.length).toBeGreaterThan(0);
  });

  it('этапы отчёта идут в правильном порядке', async () => {
    const jobDir = path.join(workspace, 'job-4');
    const stages = [];
    await runDeepDive({
      workspaceDir: jobDir,
      inputPath,
      fileName: 'test.wav',
      separate: true,
      deps: makeDeps(),
      onStage: (event) => stages.push(event.stage),
    });
    expect(stages[0]).toBe('analyze');
    expect(stages).toContain('separate');
    expect(stages).toContain('stems');
    expect(stages).toContain('twin');
    expect(stages).toContain('render');
    expect(stages).toContain('compare');
    // Порядок этапов — возрастающий.
    const order = ['analyze', 'separate', 'stems', 'twin', 'render', 'compare'];
    const positions = order.map((name) => stages.indexOf(name));
    expect(positions.every((position, index) => index === 0 || position > positions[index - 1])).toBe(true);
  });
});
