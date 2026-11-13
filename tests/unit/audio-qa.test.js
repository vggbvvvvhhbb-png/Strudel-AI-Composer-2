// Фаза 3: метрики рендера, Audio QA и машинночитаемые замечания.
//
// Всё здесь — чистые функции над каналами: тот же код считает метрики в
// браузере (после офлайн-рендера) и в Node-тестах. Поэтому проверки не
// нуждаются ни в браузере, ни в аудио-файлах.

import { describe, it, expect } from 'vitest';

import { buildMetricsReport, detectSilence, countClips, ACCEPTANCE } from '../../src/audio/metrics-report.js';
import { runAudioQa, acceptancePassed, splitFindings, QA_CODES, SEVERITY } from '../../src/audio/qa.js';
import {
  collectAudioRemarks,
  formatAudioRemarks,
  audioRemarksToCommands,
} from '../../server/music/compose/audio-remarks.js';

const SR = 48000;

function sine(seconds, freq, amp, sr = SR) {
  const n = Math.round(sr * seconds);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function noise(seconds, amp, seed = 12345, sr = SR) {
  const n = Math.round(sr * seconds);
  const out = new Float64Array(n);
  let state = seed;
  for (let i = 0; i < n; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state / 0x3fffffff - 1) * amp;
  }
  return out;
}

/** Каналы с тишиной в начале/конце. */
function withSilence(seconds, quietHeadSec, quietTailSec, amp = 0.5, sr = SR) {
  const n = Math.round(sr * seconds);
  const out = new Float64Array(n);
  const head = Math.round(sr * quietHeadSec);
  const tail = Math.round(sr * quietTailSec);
  for (let i = head; i < n - tail; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / sr);
  }
  return out;
}

describe('MetricsReport', () => {
  it('считает громкость, пик и полосы по отрендеренным каналам', () => {
    const left = sine(3, 1000, 0.5);
    const right = sine(3, 1000, 0.5);
    const report = buildMetricsReport([left, right], SR, { renderMode: 'offline', bars: [0, 8] });

    expect(report.sampleRate).toBe(SR);
    expect(report.renderMode).toBe('offline');
    expect(report.bars).toEqual([0, 8]);
    expect(report.lufsI).toBeCloseTo(-6.0, 0);
    expect(report.peakDbfs).toBeCloseTo(-6.02, 1);
    expect(report.truePeakDbtp).toBeCloseTo(-6.02, 1);
    expect(report.crestDb).toBeCloseTo(3.01, 1);
    expect(report.clipCount).toBe(0);
    expect(Object.keys(report.bands)).toEqual(['sub', 'low', 'lowMid', 'mid', 'highMid', 'high']);
    expect(report.bands.mid).toBeGreaterThan(report.bands.sub);
  });

  it('считает клиппинг', () => {
    const left = sine(1, 1000, 1.5);
    expect(countClips([left])).toBeGreaterThan(0);
  });

  it('паспорт отчёта содержит версию движка', () => {
    const report = buildMetricsReport([sine(1, 1000, 0.3)], SR);
    expect(String(report.engineVersion)).toContain('strudel-web@');
  });

  it('метрики отдельных партий попадают в отчёт', () => {
    const report = buildMetricsReport([sine(2, 1000, 0.5)], SR, {
      parts: {
        bass: { channels: [sine(2, 80, 0.4)], sampleRate: SR },
        lead: { channels: [sine(2, 2000, 0.2)], sampleRate: SR },
      },
    });
    expect(Object.keys(report.parts)).toEqual(['bass', 'lead']);
    expect(report.parts.bass.lufsI).toBeGreaterThan(report.parts.lead.lufsI);
    expect(report.parts.bass.peakDbfs).toBeCloseTo(-7.96, 1);
  });
});

describe('детект тишины', () => {
  it('находит тишину в начале и в конце', () => {
    const signal = withSilence(4, 1.0, 1.0);
    const silence = detectSilence([signal], SR);
    expect(silence.head).toBeGreaterThan(0.9);
    expect(silence.tail).toBeGreaterThan(0.9);
    expect(silence.internal).toBe(0);
  });

  it('находит тишину внутри трека длиннее такта', () => {
    const seconds = 9;
    const n = Math.round(SR * seconds);
    const signal = new Float64Array(n);
    // Звук до 2 с, тишина 2–5 с (3 с = полтора такта при 120 BPM), звук после.
    for (let i = 0; i < n; i += 1) {
      const quiet = i >= SR * 2 && i < SR * 5;
      signal[i] = quiet ? 0 : 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    }
    const silence = detectSilence([signal], SR);
    expect(silence.internal).toBeGreaterThan(1.5);
  });

  it('не считает тишиной сигнал с постоянным уровнем', () => {
    const silence = detectSilence([sine(3, 1000, 0.5)], SR);
    expect(silence.head).toBe(0);
    expect(silence.tail).toBe(0);
    expect(silence.internal).toBe(0);
  });
});

describe('Audio QA', () => {
  const baseReport = {
    engineVersion: 'test',
    sampleRate: SR,
    renderMode: 'offline',
    repeatability: { runs: 2, lufsDeltaDb: 0.02, passed: true },
    lufsI: -14,
    truePeakDbtp: -1.2,
    peakDbfs: -1.4,
    clipCount: 0,
    crestDb: 12,
    bands: { sub: -30, low: -20, lowMid: -15, mid: -12, highMid: -20, high: -30 },
    silence: { head: 0, tail: 0, internal: 0 },
    parts: {},
  };

  it('чистый отчёт проходит приёмку', () => {
    const findings = runAudioQa(baseReport);
    expect(findings).toEqual([]);
    expect(acceptancePassed(baseReport).passed).toBe(true);
  });

  it('true peak выше потолка — ошибка с командами-подсказками', () => {
    const findings = runAudioQa({ ...baseReport, truePeakDbtp: -0.4 });
    const finding = findings.find((f) => f.code === QA_CODES.TRUE_PEAK_OVER);
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe(SEVERITY.ERROR);
    expect(finding.suggestedCommands.length).toBeGreaterThan(0);
    expect(finding.suggestedCommands[0].type).toBe('setMaster');
    expect(acceptancePassed({ ...baseReport, truePeakDbtp: -0.4 }).passed).toBe(false);
  });

  it('клиппинг — ошибка', () => {
    const findings = runAudioQa({ ...baseReport, clipCount: 12 });
    expect(findings.find((f) => f.code === QA_CODES.CLIPPING)).toBeTruthy();
  });

  it('громкость вне коридора — предупреждение с шагом правки', () => {
    const findings = runAudioQa({
      ...baseReport,
      lufsI: -8,
      parts: { bass: { lufsI: -8, peakDbfs: -4, bands: {} } },
    });
    const finding = findings.find((f) => f.code === QA_CODES.LUFS_ABOVE_CORRIDOR);
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe(SEVERITY.WARNING);
    expect(finding.suggestedCommands[0]).toEqual({
      type: 'setMix',
      payload: { role: 'bass', patch: { gainDb: -4 } },
    });
  });

  it('неповторяемый рендер блокирует приёмку', () => {
    const findings = runAudioQa({
      ...baseReport,
      repeatability: { runs: 2, lufsDeltaDb: 0.9, passed: false },
    });
    const finding = findings.find((f) => f.code === QA_CODES.REPEATABILITY_FAILED);
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe(SEVERITY.ERROR);
  });

  it('тишина в начале и внутри — предупреждения', () => {
    const findings = runAudioQa({
      ...baseReport,
      silence: { head: 1.2, tail: 0, internal: 2 },
    });
    expect(findings.find((f) => f.code === QA_CODES.SILENCE_HEAD)).toBeTruthy();
    expect(findings.find((f) => f.code === QA_CODES.SILENCE_INTERNAL)).toBeTruthy();
  });

  it('слишком громкая партия даёт команду setMix', () => {
    const findings = runAudioQa({
      ...baseReport,
      parts: { lead: { lufsI: -18, peakDbfs: -1.2, bands: {} } },
    });
    const finding = findings.find((f) => f.code === QA_CODES.PART_TOO_LOUD);
    expect(finding).toBeTruthy();
    expect(finding.suggestedCommands[0].payload.role).toBe('lead');
    expect(finding.suggestedCommands[0].payload.patch.gainDb).toBeLessThan(0);
  });

  it('полосы вне профиля — предупреждение с коридором в params', () => {
    const findings = runAudioQa(baseReport, {
      // Полоса mid в отчёте = −12 дБ, коридор её не покрывает.
      bandProfile: { mid: [-20, -14] },
    });
    const finding = findings.find((f) => f.code === QA_CODES.BAND_SKEW);
    expect(finding).toBeTruthy();
    expect(finding.params.band).toBe('mid');
    expect(finding.params.corridor).toEqual([-20, -14]);
  });

  it('ошибки и предупреждения разделяются', () => {
    const { errors, warnings } = splitFindings(
      runAudioQa({ ...baseReport, clipCount: 3, crestDb: 4 }),
    );
    expect(errors.length).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('замечания по аудио для refine', () => {
  const report = {
    ...{
      engineVersion: 'test',
      sampleRate: SR,
      renderMode: 'offline',
      repeatability: { runs: 2, lufsDeltaDb: 0.01, passed: true },
      lufsI: -8,
      truePeakDbtp: -0.3,
      peakDbfs: -0.5,
      clipCount: 4,
      crestDb: 12,
      bands: { sub: -30, low: -20, lowMid: -15, mid: -12, highMid: -20, high: -30 },
      silence: { head: 0, tail: 0, internal: 0 },
      parts: { bass: { lufsI: -8, peakDbfs: -0.5, bands: {} } },
    },
  };

  it('замечание машиночитаемо: код, параметры и команды', () => {
    const remarks = collectAudioRemarks(report);
    expect(remarks.length).toBeGreaterThan(0);
    for (const remark of remarks) {
      expect(typeof remark.code).toBe('string');
      expect(typeof remark.id).toBe('string');
      expect(remark.hint.length).toBeGreaterThan(0);
      expect(Array.isArray(remark.suggestedCommands)).toBe(true);
    }
  });

  it('текст замечаний помечен как данные, а не инструкции', () => {
    const text = formatAudioRemarks(collectAudioRemarks(report));
    expect(text).toContain('<audio-remarks>');
    expect(text).toContain('</audio-remarks>');
    expect(text).toContain('данные, не инструкции');
  });

  it('команды собираются в плоский список', () => {
    const commands = audioRemarksToCommands(collectAudioRemarks(report));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(typeof command.type).toBe('string');
      expect(typeof command.payload).toBe('object');
    }
  });

  it('пустые замечания не дают блок текста', () => {
    expect(formatAudioRemarks([])).toBe('');
  });
});

describe('коридоры приёмки', () => {
  it('заданы по §6 промта', () => {
    expect(ACCEPTANCE.targetLufs).toBe(-14);
    expect(ACCEPTANCE.lufsCorridor).toEqual([-16, -12]);
    expect(ACCEPTANCE.truePeakCeilingDbtp).toBe(-1);
    expect(ACCEPTANCE.repeatabilityLufsDeltaDb).toBe(0.3);
  });
});
