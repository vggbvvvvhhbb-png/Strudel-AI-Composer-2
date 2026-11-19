import { describe, expect, it } from 'vitest';
import { encodeWav } from '../../src/core/wav.js';
import { assessSeparation, compareAudio } from '../../scripts/gate-b.mjs';

function pcmWav(channels, sampleRate = 44100) {
  const wav = Buffer.from(encodeWav(channels.map((channel) => new Float32Array(channel.length)), sampleRate));
  for (let frame = 0; frame < channels[0].length; frame += 1) {
    for (let channel = 0; channel < channels.length; channel += 1) {
      wav.writeInt16LE(channels[channel][frame], 44 + (frame * channels.length + channel) * 2);
    }
  }
  return wav;
}

const availableAnalysis = { available: true, demucs_available: true };

function completedSeparation() {
  return {
    state: 'done',
    result: {
      ok: true,
      seconds: 200,
      model: 'htdemucs',
      stems: { drums: 'drums.wav', bass: 'bass.wav', vocals: 'vocals.wav', other: 'other.wav' },
    },
  };
}

describe('gate B: signed PCM16 evidence', () => {
  it('255 → 256 differs by one LSB, not by the changed bytes', () => {
    expect(compareAudio(pcmWav([[255]]), pcmWav([[256]]))).toEqual({
      maxAbsDiff: 1,
      maxAbsDiffNormalized: 1 / 32768,
      diffSamples: 1,
      total: 1,
      relativeDiff: 1,
    });
  });

  it.each([
    [-1, 0, 1],
    [-256, 0, 256],
    [-32768, 32767, 65535],
  ])('compares signed samples %i → %i', (from, to, difference) => {
    expect(compareAudio(pcmWav([[from]]), pcmWav([[to]]))).toMatchObject({
      maxAbsDiff: difference,
      maxAbsDiffNormalized: difference / 32768,
      diffSamples: 1,
      total: 1,
    });
  });

  it('counts channel samples in stereo, not bytes or frames', () => {
    const a = pcmWav([[255, 10, 20], [-1, 30, 40]]);
    const b = pcmWav([[256, 10, 20], [0, 30, 40]]);
    expect(compareAudio(a, b)).toEqual({
      maxAbsDiff: 1,
      maxAbsDiffNormalized: 1 / 32768,
      diffSamples: 2,
      total: 6,
      relativeDiff: 2 / 6,
    });
  });

  it('reports zero difference for identical samples', () => {
    const wav = pcmWav([[-32768, 0, 32767], [1, -1, 255]]);
    expect(compareAudio(wav, Buffer.from(wav))).toMatchObject({
      maxAbsDiffNormalized: 0, diffSamples: 0, total: 6, relativeDiff: 0,
    });
  });

  it.each([
    ['sampleRate', () => pcmWav([[0]], 44100), () => pcmWav([[0]], 48000), 1],
    ['channels', () => pcmWav([[0, 0]]), () => pcmWav([[0], [0]]), 2],
    ['frames', () => pcmWav([[0, 0, 0]]), () => pcmWav([[0, 0]]), 3],
  ])('rejects a %s mismatch before comparing samples', (field, makeA, makeB, total) => {
    const result = compareAudio(makeA(), makeB());
    expect(result).toMatchObject({ maxAbsDiffNormalized: null, diffSamples: null, total });
    expect(result.error).toContain(field);
  });

  it.each(['left', 'right', 'both'])('reports missing %s data without a fabricated score', (missing) => {
    const wav = pcmWav([[0]]);
    expect(compareAudio(missing === 'right' ? wav : null, missing === 'left' ? wav : null)).toEqual({
      maxAbsDiffNormalized: null, diffSamples: null, total: null,
    });
  });

  it.each([
    ['empty buffer', () => Buffer.alloc(0)],
    ['empty PCM', () => pcmWav([[]])],
    ['truncated data', () => pcmWav([[1]]).subarray(0, 45)],
    ['non-PCM format', () => {
      const wav = pcmWav([[0]]);
      wav.writeUInt16LE(3, 20);
      return wav;
    }],
  ])('rejects %s instead of returning zero difference', (_name, makeWav) => {
    const result = compareAudio(makeWav(), pcmWav([[0]]));
    expect(result).toMatchObject({ maxAbsDiffNormalized: null, diffSamples: null, total: null });
    expect(result.error).toBeTruthy();
  });
});

describe('gate B: measured separation and first-twin evidence', () => {
  it.each([
    [{ available: false, reason: 'worker offline' }, 'worker offline'],
    [{ available: true, demucs_available: false }, 'Demucs'],
    [availableAnalysis, 'health'],
  ])('never turns worker health alone into separation success', (analysis, reason) => {
    const result = assessSeparation(analysis);
    expect(result).toMatchObject({ ok: null, stemCount: null, firstTwinOk: null, firstTwinWallMs: null });
    expect(result.reason).toContain(reason);
  });

  it.each(['queued', 'running'])('does not accept a %s task as final evidence', (state) => {
    expect(assessSeparation(availableAnalysis, { ...completedSeparation(), state }, 1000, 1000))
      .toMatchObject({ ok: null, firstTwinOk: null, firstTwinWallMs: null });
  });

  it('records task failure and sanitizes its error', () => {
    const result = assessSeparation(availableAnalysis, {
      state: 'error', error: 'Demucs failed: token=fixture-value\nBearer fixture-bearer',
    }, 1000, 32000);
    expect(result).toMatchObject({ ok: false, firstTwinOk: null, firstTwinWallMs: null });
    expect(result.reason).toContain('Demucs failed');
    expect(result.reason).not.toContain('fixture-value');
    expect(result.reason).not.toContain('fixture-bearer');
    expect(result.reason).not.toContain('\n');
  });

  it('requires all four stems in a completed task', () => {
    const task = completedSeparation();
    delete task.result.stems.bass;
    expect(assessSeparation(availableAnalysis, task, 300000, 32000))
      .toMatchObject({ ok: false, stemCount: 3, firstTwinOk: null, firstTwinWallMs: null });
  });

  it.each([null, NaN, -1])('rejects missing or invalid separation wall time %s', (wallMs) => {
    expect(assessSeparation(availableAnalysis, completedSeparation(), wallMs, 32000))
      .toMatchObject({ ok: false, firstTwinOk: null, firstTwinWallMs: null });
  });

  it('requires the measured worker separation time', () => {
    const task = completedSeparation();
    task.result.seconds = null;
    expect(assessSeparation(availableAnalysis, task, 300000, 32000))
      .toMatchObject({ ok: false, firstTwinOk: null });
  });

  it.each([
    [388000, true],
    [388001, false],
  ])('checks the 420-second first-twin limit using separation wall time %i', (wallMs, expected) => {
    expect(assessSeparation(availableAnalysis, completedSeparation(), wallMs, 32000)).toEqual({
      ok: true,
      reason: null,
      stemCount: 4,
      firstTwinWallMs: wallMs + 32000,
      firstTwinOk: expected,
    });
  });

  it('cannot infer first-twin time from separation success without render timing', () => {
    expect(assessSeparation(availableAnalysis, completedSeparation(), 300000))
      .toMatchObject({ ok: true, stemCount: 4, firstTwinOk: null, firstTwinWallMs: null });
  });
});
