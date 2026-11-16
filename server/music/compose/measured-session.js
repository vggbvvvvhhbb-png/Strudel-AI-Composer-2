// Серверная обвязка измерительного рефайна: настоящий рендер и настоящее
// измерение (D-111).
//
// Модуль `measured-refine.js` не знает, откуда берётся звук и чем он
// измеряется: рендер и замер внедряются. Здесь они настоящие:
//   render  — headless-Chromium со Strudel (тот же движок, тот же fingerprint),
//             через общий пул воркера;
//   measure — DSP проекта по получившимся сэмплам: громкость, пик, клиппинг
//             (buildMetricsReport) и музыкальный разбор кода (analyzeTrack).
//
// ЧЕСТНОСТЬ. Покрытие слоёв не измеряется: рендер идёт одним миксом, а
// послойный рендер удваивает время работы. Поэтому coverage = null («нет
// данных»), а не «4/4».

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getRenderWorker, enqueueRender } from '../../deepdive/render/pool.js';
import { decodeWav } from '../../../src/core/wav.js';
import { buildMetricsReport } from '../../../src/audio/metrics-report.js';
import { analyzeTrack } from '../features.js';
import { scoreTrack } from '../score.js';
import { resolveProfile } from '../references.js';
import { compileTrackSpec } from '../compiler/index.js';

/** Каталог для временных WAV измерительного рефайна. */
function tempDir() {
  return path.join(os.tmpdir(), 'strudel-measured-refine');
}

/**
 * Рендер кода в WAV тем же движком, что и остальной проект.
 *
 * @param {string} code
 * @param {{bars?:number, bpm?:number|null}} options
 * @returns {Promise<{wavPath:string, fingerprint:object, report:object}>}
 */
export async function serverRender(code, { bars = 16, bpm = null } = {}) {
  const worker = await getRenderWorker();
  // cps — циклы в секунду: cps = bpm / 240 (один такт = четыре доли).
  const cps = bpm ? Number(bpm) / 240 : 0.5;
  const result = await enqueueRender(() => worker.render({
    code,
    fromCycle: 0,
    toCycle: bars,
    cps,
    wantWav: true,
    wantEvents: true,
  }));
  if (!result?.ok || !result.wav) throw new Error('рендер не удался');
  await mkdir(tempDir(), { recursive: true });
  const wavPath = path.join(tempDir(), `measured-${Date.now()}-${Math.abs(hashCode(code))}.wav`);
  await writeFile(wavPath, result.wav);
  return {
    wavPath,
    fingerprint: result.fingerprint ?? null,
    report: result.report ?? null,
    renderMs: result.renderMs ?? null,
  };
}

/**
 * Замер по WAV-файлу: технический блок (L0) и музыкальный (L1).
 *
 * @param {string} wavPath
 * @param {object} spec
 * @returns {Promise<object>}
 */
export async function serverMeasure(wavPath, spec) {
  const { readFile } = await import('node:fs/promises');
  const audio = decodeWav(await readFile(wavPath));
  const report = buildMetricsReport(audio.channels, audio.sampleRate, { renderMode: 'offline' });
  const code = compileTrackSpec(spec);
  const analysis = analyzeTrack(code);
  const style = spec?.meta?.style ?? 'cinematic';
  const musical = scoreTrack(analysis, resolveProfile(style, ''));

  return {
    l0: scoreAudioTotal(report),
    l1: musical.total ?? null,
    // Послойное покрытие не измерялось — честное «нет данных».
    coverage: null,
    truePeakDbtp: report.truePeakDbtp ?? null,
    lufsI: report.lufsI ?? null,
    clipCount: report.clipCount ?? null,
    motifCoherence: analysis.metrics?.motifCoherence ?? null,
    contourEntropy: analysis.metrics?.contourEntropy ?? null,
    notes: ['покрытие слоёв не измерялось: рендер идёт одним миксом'],
  };
}

/**
 * Технический балл (L0): 100 — все проверки пройдены.
 * @param {object} report
 * @returns {number}
 */
function scoreAudioTotal(report) {
  const checks = [
    report.truePeakDbtp === null || report.truePeakDbtp <= -1.0,
    !report.clipCount,
    report.lufsI === null || (report.lufsI >= -16 && report.lufsI <= -12),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

/**
 * Простой хеш строки — для имени файла. Криптографическим он не должен
 * быть: речь о том, чтобы два рендера не легли в один файл.
 * @param {string} text
 * @returns {number}
 */
function hashCode(text) {
  let hash = 0;
  for (let i = 0; i < String(text).length; i += 1) {
    hash = (hash * 31 + String(text).charCodeAt(i)) | 0;
  }
  return hash;
}
