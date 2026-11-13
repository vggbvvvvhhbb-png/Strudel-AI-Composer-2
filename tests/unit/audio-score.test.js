// Фаза 3: аудио-блок в скоре и его проводка через HTTP.
//
// Аудио-блок — 20% общего скора (§7 промта). Он переключаемый: без отчёта
// о рендере веса просто перераспределяются между остальными блоками.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { once } from 'node:events';

import { scoreAudioReport, combineScores, AUDIO_SCORE_WEIGHT } from '../../server/music/compose/audio-score.js';
import { parseMetricsReport } from '../../src/audio/metrics-report.js';

const { completeChat } = vi.hoisted(() => ({ completeChat: vi.fn() }));
vi.mock('../../server/llm/client.js', () => ({ completeChat }));

import router from '../../server/routes/compose.js';

const SR = 48000;

const cleanReport = {
  engineVersion: 'strudel-web@1.3.0/superdough@1.3.0',
  sampleRate: SR,
  renderMode: 'offline',
  repeatability: { runs: 2, lufsDeltaDb: 0.02, passed: true },
  bars: [0, 16],
  lufsI: -14,
  truePeakDbtp: -1.2,
  peakDbfs: -1.4,
  clipCount: 0,
  crestDb: 12,
  bands: { sub: -30, low: -20, lowMid: -15, mid: -12, highMid: -20, high: -30 },
  silence: { head: 0, tail: 0, internal: 0 },
  parts: {},
  warnings: [],
};

describe('аудио-блок скора', () => {
  it('чистый отчёт даёт полный балл блока', () => {
    const scored = scoreAudioReport(cleanReport);
    expect(scored.total).toBe(100);
    expect(scored.issues).toEqual([]);
    expect(scored.checks.repeatability).toBe(true);
  });

  it('клиппинг снимает балл клиппинга', () => {
    const scored = scoreAudioReport({ ...cleanReport, clipCount: 7 });
    expect(scored.total).toBe(80);
    expect(scored.checks.clipping).toBe(false);
    expect(scored.issues[0].id).toBe('audio:clipping');
  });

  it('громкость вне коридора снимает балл громкости', () => {
    const scored = scoreAudioReport({ ...cleanReport, lufsI: -6 });
    expect(scored.checks.lufs).toBe(false);
    expect(scored.total).toBe(75);
  });

  it('неизмеренная повторяемость не засчитывается', () => {
    const { repeatability, ...withoutRepeatability } = cleanReport;
    const scored = scoreAudioReport(withoutRepeatability);
    expect(scored.checks.repeatability).toBe(false);
    expect(scored.total).toBe(75);
  });

  it('вес аудио-блока — 20%', () => {
    expect(AUDIO_SCORE_WEIGHT).toBe(0.2);
  });
});

describe('смешивание скоров', () => {
  it('без аудио-блока веса остаются 60/40', () => {
    // 80·0.6 + 60·0.4 = 72
    expect(combineScores(80, 60, null)).toBe(72);
    expect(combineScores(80, null, null)).toBe(80);
  });

  it('с аудио-блоком 20% идёт на звук', () => {
    // База 80·0.6 + 60·0.4 = 72; далее 72·0.8 + 100·0.2 = 77.6
    expect(combineScores(80, 60, 100)).toBe(77.6);
  });
});

describe('разбор отчёта с клиента', () => {
  it('корректный отчёт принимается', () => {
    const parsed = parseMetricsReport(cleanReport);
    expect(parsed.ok).toBe(true);
    expect(parsed.report.lufsI).toBe(-14);
  });

  it('битый отчёт отклоняется с причиной', () => {
    const parsed = parseMetricsReport({ lufsI: 'громко' });
    expect(parsed.ok).toBe(false);
    expect(parsed.report).toBeNull();
    expect(typeof parsed.error).toBe('string');
  });
});

describe('аудио-блок в HTTP-протоколе', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  beforeEach(() => completeChat.mockReset());

  async function compose(body) {
    const response = await fetch(`${base}/api/music/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const events = text
      .trim()
      .split('\n\n')
      .map((line) => JSON.parse(line.replace(/^data: /, '')));
    return { status: response.status, events };
  }

  it('отчёт рендера попадает в скор и в событие scored', async () => {
    completeChat.mockResolvedValue(JSON.stringify({ meta: { style: 'techno', bpm: 132, key: 'c:minor' }, form: [], harmony: {} }));
    const { events } = await compose({ prompt: 'техно', seed: 5, refine: false, audioReport: cleanReport });
    const scored = events.find((e) => e.type === 'scored');
    expect(scored).toBeTruthy();
    expect(scored.score.audio).toBeTruthy();
    expect(scored.score.audio.total).toBe(100);
    expect(scored.audioRejected).toBeNull();
  });

  it('без отчёта аудио-блок просто не участвует', async () => {
    completeChat.mockResolvedValue(JSON.stringify({ meta: { style: 'techno', bpm: 132, key: 'c:minor' }, form: [], harmony: {} }));
    const { events } = await compose({ prompt: 'техно', seed: 6, refine: false });
    const scored = events.find((e) => e.type === 'scored');
    expect(scored.score.audio).toBeNull();
    expect(typeof scored.score.total).toBe('number');
  });

  it('битый отчёт не ломает композицию — причина возвращается', async () => {
    completeChat.mockResolvedValue(JSON.stringify({ meta: { style: 'techno', bpm: 132, key: 'c:minor' }, form: [], harmony: {} }));
    const { events } = await compose({
      prompt: 'техно',
      seed: 7,
      refine: false,
      audioReport: { lufsI: 'громко' },
    });
    const scored = events.find((e) => e.type === 'scored');
    expect(scored.score.audio).toBeNull();
    expect(typeof scored.audioRejected).toBe('string');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('аудио-блок выключается флагом useAudio', async () => {
    completeChat.mockResolvedValue(JSON.stringify({ meta: { style: 'techno', bpm: 132, key: 'c:minor' }, form: [], harmony: {} }));
    const { events } = await compose({
      prompt: 'техно',
      seed: 8,
      refine: false,
      useAudio: false,
      audioReport: cleanReport,
    });
    const scored = events.find((e) => e.type === 'scored');
    expect(scored.score.audio).toBeNull();
  });
});
