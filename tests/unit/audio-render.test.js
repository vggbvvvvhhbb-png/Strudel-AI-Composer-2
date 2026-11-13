// Фаза 3: офлайн-рендер и отчёт с паспортом происхождения.
//
// Рендер здесь — подставная функция: она не знает про Web Audio и отдаёт
// каналы. Именно так и устроен настоящий рендер (движок отдаёт AudioBuffer,
// обёртка — каналы), поэтому проверки одинаковы в Node и в браузере.

import { describe, it, expect } from 'vitest';

import {
  renderAndMeasure,
  renderBars,
  renderPart,
  compareRenders,
  audioBufferToChannels,
  DEFAULT_CPS,
} from '../../src/audio/render/offline.js';
import { runAudioQa, QA_CODES } from '../../src/audio/qa.js';

const SR = 48000;

/** Синус заданной длительности. */
function sine(seconds, freq, amp, sr = SR) {
  const n = Math.round(sr * seconds);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** Рендер-подставка: детерминированный синус нужной длительности. */
function fakeRender({ fromCycle, toCycle, sampleRate = SR, cps = DEFAULT_CPS }) {
  const seconds = (toCycle - fromCycle) / cps;
  const channels = [sine(seconds, 1000, 0.25, sampleRate), sine(seconds, 1000, 0.25, sampleRate)];
  return { channels, sampleRate };
}

/** Тот же рендер, но каждый прогон чуть громче: повторяемость ломается. */
let noisyCall = 0;
function noisyRender(args) {
  noisyCall += 1;
  const seconds = (args.toCycle - args.fromCycle) / args.cps;
  const amp = 0.25 * (noisyCall % 2 === 1 ? 1 : 1.05);
  const channels = [sine(seconds, 1000, amp, args.sampleRate), sine(seconds, 1000, amp, args.sampleRate)];
  return { channels, sampleRate: args.sampleRate };
}

describe('офлайн-рендер', () => {
  it('считает метрики по отрендеренным каналам', async () => {
    const { report } = await renderAndMeasure({ render: fakeRender, bars: [0, 8], sampleRate: SR });
    expect(report.renderMode).toBe('offline');
    expect(report.bars).toEqual([0, 8]);
    expect(report.sampleRate).toBe(SR);
    expect(report.lufsI).toBeCloseTo(-12, 0);
    expect(report.clipCount).toBe(0);
    expect(Object.keys(report.bands)).toEqual(['sub', 'low', 'lowMid', 'mid', 'highMid', 'high']);
  });

  it('два прогона дают повторяемость и нулевое расхождение', async () => {
    const { report, comparison } = await renderAndMeasure({ render: fakeRender, bars: [0, 4] });
    expect(report.repeatability).toMatchObject({ runs: 2, passed: true });
    expect(report.repeatability.lufsDeltaDb).toBe(0);
    expect(comparison.maxAbsDiff).toBe(0);
    expect(comparison.rmsDiff).toBe(0);
  });

  it('неповторяемый рендер ломает приёмку', async () => {
    const { report } = await renderAndMeasure({ render: noisyRender, bars: [0, 4] });
    expect(report.repeatability.passed).toBe(false);
    const findings = runAudioQa(report);
    expect(findings.find((f) => f.code === QA_CODES.REPEATABILITY_FAILED)).toBeTruthy();
  });

  it('один прогон оставляет повторяемость неизвестной', async () => {
    const { report } = await renderAndMeasure({ render: fakeRender, bars: [0, 4], runs: 1 });
    expect(report.repeatability).toBeNull();
    const findings = runAudioQa(report);
    expect(findings.find((f) => f.code === QA_CODES.REPEATABILITY_UNKNOWN)).toBeTruthy();
  });

  it('соло-рендер партии попадает в отчёт отдельной метрикой', async () => {
    const { report } = await renderAndMeasure({
      render: (args) => fakeRender({ ...args, sampleRate: args.sampleRate }),
      bars: [0, 4],
      parts: ['bass'],
    });
    expect(Object.keys(report.parts)).toEqual(['bass']);
    expect(typeof report.parts.bass.lufsI).toBe('number');
  });

  it('рендер одной партии считается отдельно', async () => {
    const { report } = await renderPart({ render: fakeRender, bars: [0, 4], partId: 'lead' });
    expect(report.renderMode).toBe('offline');
    expect(report.lufsI).toBeCloseTo(-12, 0);
  });

  it('длительность рендера считается по тактам и темпу', async () => {
    const { channels, sampleRate } = await renderBars({
      render: fakeRender,
      bars: [0, 4],
      sampleRate: SR,
      cps: 0.5,
    });
    // 4 такта при 120 BPM = 8 с.
    expect(channels[0].length).toBe(SR * 8);
    expect(sampleRate).toBe(SR);
  });

  it('расхождение рендеров считается точно', () => {
    const a = [sine(1, 1000, 0.5)];
    const b = [sine(1, 1000, 0.5)];
    expect(compareRenders(a, b).maxAbsDiff).toBe(0);

    const c = [Float64Array.from(a[0])];
    c[0][10] += 0.5;
    const diff = compareRenders(a, c);
    expect(diff.maxAbsDiff).toBeCloseTo(0.5, 6);
    expect(diff.rmsDiff).toBeGreaterThan(0);
  });

  it('AudioBuffer превращается в каналы', () => {
    const buffer = {
      numberOfChannels: 2,
      getChannelData: (index) => (index === 0 ? [0.1, -0.1, 0.2] : [0.3, -0.3, 0.4]),
    };
    const channels = audioBufferToChannels(buffer);
    expect(channels.length).toBe(2);
    expect(channels[0][2]).toBeCloseTo(0.2, 6);
    expect(channels[1][0]).toBeCloseTo(0.3, 6);
  });
});
