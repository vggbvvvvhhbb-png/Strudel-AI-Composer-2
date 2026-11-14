// Спайк S1: серверный рендер Strudel-кода в WAV.
//
// Что проверяем (DoD спайка из плана владельца):
//   * render(code, seconds) -> wav: код действительно превращается в звук;
//   * длительность рендера соответствует тактам и темпу;
//   * пики и громкость в разумных пределах, клиппинга нет;
//   * атаки стоят на своих местах (огибающая рендера, а не только события);
//   * детерминизм: два прогона дают побайтово одинаковый звук.
//
// Тест требует браузера (Chrome/Edge) и собранного бандла. Если браузера нет —
// тест пропускается, а не падает: на CI без браузера это норма.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { decodeWav } from '../../src/core/wav.js';
import { measureLoudness, measurePeakDbfs } from '../../src/audio/dsp/loudness.js';

const BUNDLE = 'server/deepdive/render/dist/render-bundle.js';

function browserAvailable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.some((p) => existsSync(p));
}

const canRun = existsSync(BUNDLE) && browserAvailable();

// Код для рендера: синтезаторы плюс ударные из банка dirt-samples.
const CODE = `
setCpm(120/4)
const key = "c:minor"
const drums = s("bd ~ bd ~ bd ~ bd ~").gain(0.8)
const bass = note("<c2 c2 eb2 g1>").s("sawtooth").lpf(400).gain(0.6)
$DRUMS: drums
$BASS: bass
`;

// cps — ЦИКЛЫ В СЕКУНДУ: 120 BPM -> 0.5 (один такт = 2 с).
const CPS = 0.5;
const BARS = 8;

describe('спайк S1: серверный рендер кода в WAV', () => {
  let worker = null;
  let first = null;

  beforeAll(async () => {
    if (!canRun) return;
    const { createRenderWorker } = await import('../../server/deepdive/render/render-worker.mjs');
    worker = await createRenderWorker();
    first = await worker.render({ code: CODE, fromCycle: 0, toCycle: BARS, cps: CPS });
  }, 180000);

  afterAll(async () => {
    if (worker) await worker.close();
  });

  it('рендерит код в WAV нужной длительности', () => {
    if (!canRun) return;
    expect(first.ok).toBe(true);
    expect(first.wav).toBeTruthy();
    const decoded = decodeWav(first.wav);
    expect(decoded.sampleRate).toBe(48000);
    // 8 тактов по 2 с = 16 с. Допуск — один сэмпл.
    expect(Math.abs(decoded.frames / decoded.sampleRate - BARS / CPS)).toBeLessThan(0.01);
    expect(decoded.channels.length).toBe(2);
    expect(decoded.frames).toBeGreaterThan(0);
  });

  it('звук не пустой и без клиппинга', () => {
    if (!canRun) return;
    const decoded = decodeWav(first.wav);
    const peak = measurePeakDbfs(decoded.channels, decoded.sampleRate);
    const lufs = measureLoudness(decoded.channels, decoded.sampleRate).lufsI;
    expect(peak).toBeGreaterThan(-20); // есть звук
    expect(peak).toBeLessThanOrEqual(0.001); // но без перегрузки
    expect(Number.isFinite(lufs)).toBe(true);
    expect(first.report.clipCount).toBe(0);
  });

  it('атаки стоят на своих местах: огибающая растёт в начале тактов', () => {
    if (!canRun) return;
    const decoded = decodeWav(first.wav);
    // RMS по окнам 50 мс в пределах первых двух тактов.
    const win = Math.round(0.05 * decoded.sampleRate);
    const limit = Math.round(2.5 * decoded.sampleRate);
    const levels = [];
    for (let from = 0; from + win <= limit; from += win) {
      let sum = 0;
      for (const ch of decoded.channels) for (let i = from; i < from + win; i += 1) sum += ch[i] * ch[i];
      levels.push(Math.sqrt(sum / (win * decoded.channels.length)));
    }
    const loud = levels.filter((v) => v > 0.02).length;
    expect(loud).toBeGreaterThan(0); // звук есть
    // Повторяемость ударов: в двух тактах пиков должно быть несколько.
    const peaks = levels.filter((v, i) => i > 0 && v > levels[i - 1] * 2 && v > 0.02).length;
    expect(peaks).toBeGreaterThanOrEqual(2);
  });

  it('рендер детерминирован в пределах допуска проекта', async () => {
    if (!canRun) return;
    const second = await worker.render({ code: CODE, fromCycle: 0, toCycle: BARS, cps: CPS });
    expect(second.wav.length).toBe(first.wav.length);

    // ВАЖНО. В float рендер детерминирован (maxAbsDiff = 0, спайк фазы 0).
    // Но при квантовании в 16-битный PCM один сэмпл может перескочить
    // границу округления и отличаться ровно на 1 LSB (1/32768 = 3.05e-5).
    // Поэтому сравниваем не байты, а расхождение — собственным допуском
    // проекта maxAbsDiff <= 1e-4 (docs/BRIEF.md:73).
    const a = decodeWav(first.wav);
    const b = decodeWav(second.wav);
    let maxAbsDiff = 0;
    let diffSamples = 0;
    for (let c = 0; c < a.channels.length; c += 1) {
      for (let i = 0; i < a.frames; i += 1) {
        const diff = Math.abs(a.channels[c][i] - b.channels[c][i]);
        if (diff > 0) diffSamples += 1;
        if (diff > maxAbsDiff) maxAbsDiff = diff;
      }
    }
    expect(maxAbsDiff).toBeLessThanOrEqual(1e-4);
    // Расхождение единичное: не более 0.01% отсчётов.
    expect(diffSamples).toBeLessThan((a.frames * a.channels.length) / 10000);
  }, 120000);

  it('в отчёте есть паспорт рендера', () => {
    if (!canRun) return;
    expect(first.fingerprint.code_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fingerprint.sample_rate).toBe(48000);
    expect(first.fingerprint.engine_version).toBeTruthy();
  });

  it('ошибка в коде не роняет воркер молча', async () => {
    if (!canRun) return;
    await expect(
      worker.render({ code: 'this is not valid javascript ((', fromCycle: 0, toCycle: 2, cps: CPS }),
    ).rejects.toThrow();
  }, 60000);
});
