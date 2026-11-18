import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  readWav: vi.fn(), analyzeFile: vi.fn(), separateStems: vi.fn(), analyzeStems: vi.fn(), buildPassport: vi.fn(),
}));
vi.mock('../../server/deepdive/pipeline/helpers.js', async (importOriginal) => ({
  ...await importOriginal(), readWav: mocks.readWav,
}));
vi.mock('../../server/deepdive/analysis/client.js', () => ({
  analyzeFile: mocks.analyzeFile, separateStems: mocks.separateStems, analyzeStems: mocks.analyzeStems,
}));
vi.mock('../../server/samples/passport.js', () => ({ buildPassport: mocks.buildPassport }));

import { analyzeReferenceFile } from '../../local/reference.mjs';
import { createTaskRegistry, probeAnalysisWorker } from '../../local/tasks.mjs';

const LAYERS = ['drums', 'bass', 'other', 'vocals'];
const source = 'C:/private/owner/reference.wav';
const stemPaths = Object.fromEntries(LAYERS.map((layer) => [layer, `C:/private/stems/${layer}.wav`]));
const section = { index: 0, start_s: 0, end_s: 24, energy: 0.7 };
let outDir;
let calls;

function audio(seconds = 24) {
  const sampleRate = 1000;
  const frames = Math.round(seconds * sampleRate);
  return { sampleRate, frames, channels: [new Float64Array(frames), new Float64Array(frames)] };
}

beforeEach(async () => {
  vi.resetAllMocks();
  calls = [];
  outDir = await mkdtemp(path.join(tmpdir(), 'reference-p5-'));
  mocks.readWav.mockImplementation(async (file) => {
    calls.push(file === source ? 'read:source' : `read:${path.basename(file, '.wav')}`);
    return audio();
  });
  mocks.analyzeFile.mockImplementation(async () => {
    calls.push('analyzeFile');
    return {
      measurements: {
        tempo: { bpm: 120, confidence: 0.8, candidates: [60, 240], path: source },
        key: { tonic: 'D', mode: 'minor', confidence: 0.7, alternatives: ['A'], notes: [60, 61, 62] },
        loudness: { lufs_integrated: -16, lufs_max: -12, lufs_range: 4, true_peak_dbtp: -1, peak_dbfs: -2, crest_db: 6 },
        raw: { notes: [60, 61, 62], wav: source },
      },
      structure: [{ ...section, label: 'A', notes: [60, 61, 62], path: source }],
      methods: { loudness: `fallback ${source}`, path: source },
    };
  });
  mocks.separateStems.mockImplementation(async () => {
    calls.push('separateStems');
    return { stems: { ...stemPaths, unexpected: source }, model: 'htdemucs', seconds: 2.3, path: source };
  });
  mocks.analyzeStems.mockImplementation(async () => {
    calls.push('analyzeStems');
    return {
      stem_descriptors: Object.fromEntries(LAYERS.map((layer) => [layer, {
        activity: { 0: 0.5, 1: 1 }, energy: [{ time_s: 0, value: 0.2 }, { time_s: 1, value: 0.6 }],
        pitch: { notes: [{ midi: 60, time_s: 0 }], median_f0_hz: 220 }, chords: ['Dm', 'A'], path: source,
      }])),
      methods: { path: source, 'bass.pitch': source },
    };
  });
  mocks.buildPassport.mockImplementation(() => {
    calls.push('buildPassport');
    return {
      name: source, source, wav: Buffer.from('raw-audio'), channels: [new Float64Array(3)],
      loudness: { lufsI: -16, peakDbfs: -2, crestDb: 6 },
      spectral: { centroidHz: 1200, rolloffHz: 3000, flatness: 0.1, bands: { sub: -20, low: -10, lowMid: -15, mid: -8, highMid: -20, high: -25, path: source } },
      transients: { count: 6, densityPerSec: 0.5, timesS: [0, 1, 2] },
      tonal: { voicedRatio: 0.6, note: 'A', f0Hz: 220, notes: [60, 61, 62] },
      tempo: { bpm: 120, confidence: 0.9 }, character: ['тёмный', source],
      rawPitches: [220, 221, 222],
    };
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(outDir, { recursive: true, force: true });
});

describe('P5 reference aggregates', () => {
  it('calls read → analyze → htdemucs → analyzeStems → descriptors for four layers', async () => {
    const progress = vi.fn();
    const result = await analyzeReferenceFile(source, { outDir, progress });
    expect(calls).toEqual([
      'read:source', 'analyzeFile', 'separateStems', 'analyzeStems',
      ...LAYERS.flatMap((layer) => [`read:${layer}`, 'buildPassport']),
    ]);
    expect(mocks.separateStems).toHaveBeenCalledWith(source, outDir, { model: 'htdemucs', stage: 'separate' });
    expect(mocks.analyzeStems).toHaveBeenCalledWith(stemPaths, [section], { stage: 'analyze_stems' });
    expect(result.durationS).toBe(24);
    expect(result.measurements.tempo.bpm).toBe(120);
    expect(result.structure).toEqual([section]);
    expect(result.model).toBe('htdemucs');
    expect(result.separationSeconds).toBe(2.3);
    expect(Object.keys(result.stems)).toEqual(LAYERS);
    for (const layer of LAYERS) {
      expect(result.stems[layer]).toMatchObject({ available: true, analyzedSeconds: 12, reason: null, activityMean: 0.75, energyMean: 0.4 });
      expect(result.stems[layer].descriptor.spectral.centroidHz).toBe(1200);
    }
    expect(progress.mock.calls.map(([event]) => event.stage)).toEqual([
      'read', 'analyze', 'separate', 'analyze_stems', ...LAYERS.map(() => 'descriptor'),
    ]);
    expect(result.caveats.join(' ')).toMatch(/Ориентир не клон/);
    expect(result.caveats.join(' ')).toMatch(/Вокал не воспроизводится/);
  });

  it('whitelists all nesting: no paths, WAV, pitches, note sequences or onset times', async () => {
    const result = await analyzeReferenceFile(source, { outDir });
    function check(value) {
      if (value && typeof value === 'object') {
        expect(ArrayBuffer.isView(value)).toBe(false);
        for (const [key, nested] of Object.entries(value)) {
          expect(key).not.toMatch(/^(path|wav|source|name|channels|notes|pitch|rawPitches|f0Hz|note|timesS|chords|candidates|alternatives)$/);
          check(nested);
        }
      } else if (typeof value === 'string') {
        expect(value).not.toContain('C:/private');
      }
    }
    check(result);
    expect(result.measurements.key).toEqual({ tonic: 'D', mode: 'minor', confidence: 0.7 });
    expect(result.stems.drums.descriptor.character).toEqual(['тёмный']);
    expect(mocks.buildPassport.mock.calls.every((args) => args.length === 2)).toBe(true);
  });

  it('bounds both descriptor channels to the first 12 seconds', async () => {
    await analyzeReferenceFile(source, { outDir });
    for (const [channels, sampleRate] of mocks.buildPassport.mock.calls) {
      expect(sampleRate).toBe(1000);
      expect(channels.map((channel) => channel.length)).toEqual([12000, 12000]);
    }
  });

  it('uses actual shorter source/stem durations, not an invented 12 seconds', async () => {
    mocks.readWav.mockImplementation(async (file) => audio(file === source ? 7.25 : file === stemPaths.bass ? 3.5 : 24));
    const result = await analyzeReferenceFile(source, { outDir });
    expect(result.durationS).toBe(7.25);
    expect(result.stems.drums.analyzedSeconds).toBe(7.25);
    expect(result.stems.bass.analyzedSeconds).toBe(3.5);
    expect(mocks.buildPassport.mock.calls[0][0].map((channel) => channel.length)).toEqual([7250, 7250]);
    expect(mocks.buildPassport.mock.calls[1][0].map((channel) => channel.length)).toEqual([3500, 3500]);
  });

  it('over 240 seconds rejects before analyzeFile and Demucs', async () => {
    mocks.readWav.mockResolvedValue(audio(240.001));
    await expect(analyzeReferenceFile(source, { outDir })).rejects.toThrow(/240 с/);
    expect(mocks.readWav).toHaveBeenCalledTimes(1);
    expect(mocks.analyzeFile).not.toHaveBeenCalled();
    expect(mocks.separateStems).not.toHaveBeenCalled();
    expect(mocks.analyzeStems).not.toHaveBeenCalled();
    expect(mocks.buildPassport).not.toHaveBeenCalled();
  });

  it('exactly 240 seconds is allowed', async () => {
    mocks.readWav.mockResolvedValue(audio(240));
    const result = await analyzeReferenceFile(source, { outDir });
    expect(result.durationS).toBe(240);
    expect(mocks.separateStems).toHaveBeenCalledOnce();
  });

  it('missing/nonfinite measurements and missing stems stay null with reasons', async () => {
    mocks.analyzeFile.mockResolvedValue({ measurements: { tempo: { bpm: NaN }, key: { mode: 'unknown' } }, structure: [] });
    mocks.separateStems.mockResolvedValue({ stems: { drums: stemPaths.drums }, model: null, seconds: null });
    mocks.buildPassport.mockReturnValue({ loudness: { lufsI: Infinity }, spectral: {}, tonal: {} });
    mocks.analyzeStems.mockResolvedValue({});
    const result = await analyzeReferenceFile(source, { outDir });
    expect(result.measurements.tempo).toEqual({ bpm: null, confidence: null });
    expect(result.measurements.key).toEqual({ tonic: null, mode: null, confidence: null });
    expect(Object.values(result.measurements.loudness).every((value) => value === null)).toBe(true);
    expect(result.structure).toBeNull();
    expect(result.model).toBeNull();
    expect(result.separationSeconds).toBeNull();
    expect(result.stems.bass).toEqual({ available: false, descriptor: null, analyzedSeconds: null, activityMean: null, energyMean: null, reason: expect.stringMatching(/Нет данных/) });
    expect(result.stems.drums.descriptor.loudness.lufsI).toBeNull();
    expect(result.stems.drums.activityMean).toBeNull();
    expect(result.caveats.join(' ')).toMatch(/measurements.tempo.bpm: нет данных/);
    expect(result.caveats.join(' ')).toMatch(/separationSeconds: нет данных/);
    expect(result.caveats.join(' ')).toMatch(/descriptor.loudness.lufsI: нет данных/);
  });

  it('unreadable stem exposes no error path and preserves the other layers', async () => {
    mocks.readWav.mockImplementation(async (file) => {
      if (file === stemPaths.vocals) throw new Error(`cannot read ${file}`);
      return audio();
    });
    const result = await analyzeReferenceFile(source, { outDir });
    expect(result.stems.vocals).toMatchObject({ available: false, descriptor: null, analyzedSeconds: null, reason: expect.stringMatching(/не декодируется/) });
    expect(result.stems.drums.available).toBe(true);
    expect(JSON.stringify(result)).not.toContain('C:/private');
  });

  it('no stems skips analyzeStems and returns four explicit unavailable layers', async () => {
    mocks.separateStems.mockResolvedValue({ stems: {}, model: 'htdemucs', seconds: 0 });
    const result = await analyzeReferenceFile(source, { outDir });
    expect(mocks.analyzeStems).not.toHaveBeenCalled();
    expect(mocks.buildPassport).not.toHaveBeenCalled();
    expect(result.separationSeconds).toBe(0);
    expect(result.methods.stems).toBeNull();
    expect(LAYERS.every((layer) => result.stems[layer].available === false && result.stems[layer].reason)).toBe(true);
  });

  it('aborted signal prevents all reads and heavy calls', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(analyzeReferenceFile(source, { outDir, signal: controller.signal })).rejects.toThrow();
    expect(mocks.readWav).not.toHaveBeenCalled();
    expect(mocks.analyzeFile).not.toHaveBeenCalled();
  });

  it('abort between worker stages stops before separation', async () => {
    const controller = new AbortController();
    mocks.analyzeFile.mockImplementation(async () => { controller.abort(); return {}; });
    await expect(analyzeReferenceFile(source, { outDir, signal: controller.signal })).rejects.toThrow();
    expect(mocks.separateStems).not.toHaveBeenCalled();
  });
});

describe('P5 registry capability gate', () => {
  it.each([
    [{ available: false, reason: 'worker off' }, /Python-воркер недоступен/],
    [{ available: true, details: { demucs_available: false } }, /Demucs недоступен/],
    [{ available: true }, /Demucs недоступен/],
  ])('rejects unavailable capability before analyzer or WAV read: %j', async (capability, error) => {
    const referenceAnalyzer = vi.fn();
    const registry = createTaskRegistry({ stateDir: outDir, analysisProbe: async () => capability, referenceAnalyzer });
    expect(registry.types()).toContain('analyze_reference');
    await expect(registry.tasks.analyze_reference({ path: source, outDir }, { progress: vi.fn() })).rejects.toThrow(error);
    expect(referenceAnalyzer).not.toHaveBeenCalled();
    expect(mocks.readWav).not.toHaveBeenCalled();
    expect(mocks.separateStems).not.toHaveBeenCalled();
  });

  it('probes first, runs live reference module and forwards progress', async () => {
    const analysisProbe = vi.fn(async () => { calls.push('probe'); return { available: true, details: { demucs_available: true } }; });
    const registry = createTaskRegistry({ stateDir: outDir, analysisProbe });
    const progress = vi.fn();
    const result = await registry.tasks.analyze_reference({ path: source, outDir }, { progress });
    expect(calls.slice(0, 3)).toEqual(['probe', 'read:source', 'analyzeFile']);
    expect(result.ok).toBe(true);
    expect(result.passport.stems.vocals.available).toBe(true);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'separate' }));
  });

  it('requires task-specific outDir instead of a shared stems directory', async () => {
    const registry = createTaskRegistry({ stateDir: outDir, analysisProbe: async () => ({ available: true, details: { demucs_available: true } }) });
    await expect(registry.tasks.analyze_reference({ path: source }, { progress: vi.fn() })).rejects.toThrow(/task-specific outDir/);
    expect(mocks.readWav).not.toHaveBeenCalled();
  });

  it('probeAnalysisWorker reports demucs unavailable without a live Python worker', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: { demucs_available: false } }) });
    vi.stubGlobal('fetch', fetch);
    const capability = await probeAnalysisWorker();
    expect(capability).toMatchObject({ available: true, details: { demucs_available: false } });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
