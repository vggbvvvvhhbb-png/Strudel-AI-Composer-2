// Офлайн-рендер и сбор отчёта о звучании.
//
// Модуль намеренно не знает про Web Audio: рендер — это функция, которую
// передали снаружи. В браузере её реализует движок (src/audio/engine/adapter.js),
// в Node-тестах — синтезатор. Благодаря этому метрики считаются одним и тем же
// кодом и в реалтайме, и в CI, и в офлайн-рендерере.
//
// Один такт = один цикл Strudel (4 доли), поэтому bars и cycles совпадают:
//   длительность = (toBar − fromBar) / cps секунд. Внимание: cps — это циклы
//   в секунду, то есть cps = bpm / 240 (bpm / 4 — это cpm, другое имя).

import { buildMetricsReport, ACCEPTANCE } from '../metrics-report.js';
import { measureLoudness } from '../dsp/loudness.js';

export const DEFAULT_SAMPLE_RATE = 48000;
export const DEFAULT_CPS = 0.5; // 120 BPM

/**
 * AudioBuffer → массив каналов Float64Array.
 * @param {AudioBuffer} buffer
 * @returns {Float64Array[]}
 */
export function audioBufferToChannels(buffer) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    channels.push(Float64Array.from(buffer.getChannelData(c)));
  }
  return channels;
}

/**
 * Каналы → AudioBuffer (нужен конструктор из окружения: в Node его нет).
 *
 * @param {Float64Array[]} channels
 * @param {number} sampleRate
 * @param {(channels:Float64Array[], sampleRate:number)=>AudioBuffer} factory
 * @returns {AudioBuffer}
 */
export function channelsToAudioBuffer(channels, sampleRate, factory) {
  if (typeof factory !== 'function') throw new Error('Нужен конструктор AudioBuffer');
  return factory(channels, sampleRate);
}

/**
 * Расхождение двух рендеров — детерминированность (H3).
 *
 * @param {Float64Array[]} a
 * @param {Float64Array[]} b
 * @returns {{maxAbsDiff:number, rmsDiff:number}}
 */
export function compareRenders(a, b) {
  const frames = Math.min(
    ...[a, b].flatMap((channels) => channels.map((ch) => ch.length)),
  );
  let maxAbsDiff = 0;
  let sum = 0;
  for (let c = 0; c < a.length; c += 1) {
    const chA = a[c];
    const chB = b[Math.min(c, b.length - 1)];
    for (let i = 0; i < frames; i += 1) {
      const diff = Math.abs(chA[i] - chB[i]);
      if (diff > maxAbsDiff) maxAbsDiff = diff;
      sum += diff * diff;
    }
  }
  const channels = Math.max(1, a.length);
  return {
    maxAbsDiff: Number(maxAbsDiff.toFixed(9)),
    rmsDiff: Number(Math.sqrt(sum / (frames * channels)).toFixed(9)),
  };
}

/**
 * Один рендер диапазона тактов.
 *
 * @param {object} options
 * @param {(args:{fromCycle:number,toCycle:number,sampleRate:number,cps:number,partId?:string}) => Promise<{channels:Float64Array[], sampleRate?:number}>} options.render
 * @param {[number,number]} options.bars
 * @param {number} [options.sampleRate]
 * @param {number} [options.cps]
 * @param {string} [options.partId] соло-рендер партии
 * @returns {Promise<{channels:Float64Array[], sampleRate:number, fromCycle:number, toCycle:number}>}
 */
export async function renderBars({ render, bars, sampleRate = DEFAULT_SAMPLE_RATE, cps = DEFAULT_CPS, partId }) {
  const [fromCycle, toCycle] = bars;
  const result = await render({ fromCycle, toCycle, sampleRate, cps, partId });
  const channels = result?.channels ?? [];
  return {
    channels,
    sampleRate: result?.sampleRate ?? sampleRate,
    fromCycle,
    toCycle,
  };
}

/**
 * Рендер + два прогона для повторяемости + соло-рендеры партий → MetricsReport.
 *
 * Повторяемость — не украшение: без неё autoMix и приёмка по метрикам
 * работать не должны (§5 промта). Поэтому по умолчанию runs = 2, а расхождение
 * по LUFS сверяется с порогом приёмки.
 *
 * @param {object} options
 * @param {Function} options.render функция рендера (см. renderBars)
 * @param {[number,number]} [options.bars] диапазон тактов [from, to]
 * @param {number} [options.sampleRate]
 * @param {number} [options.cps]
 * @param {number} [options.runs] число прогонов (1 — без проверки повторяемости)
 * @param {string[]} [options.parts] партии для соло-рендеров
 * @param {object} [options.acceptance]
 * @returns {Promise<{report:object, channels:Float64Array[], sampleRate:number, renderMs:number, comparison:object|null}>}
 */
export async function renderAndMeasure({
  render,
  bars = [0, 16],
  sampleRate = DEFAULT_SAMPLE_RATE,
  cps = DEFAULT_CPS,
  runs = 2,
  parts = [],
  acceptance = ACCEPTANCE,
}) {
  const started = Date.now();

  const main = await renderBars({ render, bars, sampleRate, cps });

  // Повторяемость: второй рендер того же диапазона.
  let comparison = null;
  let repeatability = null;
  if (runs >= 2) {
    const second = await renderBars({ render, bars, sampleRate, cps });
    comparison = compareRenders(main.channels, second.channels);
    const lufsA = measureLoudness(main.channels, main.sampleRate).lufsI;
    const lufsB = measureLoudness(second.channels, second.sampleRate).lufsI;
    const delta = Math.abs(lufsA - lufsB);
    repeatability = {
      runs: 2,
      lufsDeltaDb: Number(delta.toFixed(3)),
      passed: Number.isFinite(delta) && delta <= acceptance.repeatabilityLufsDeltaDb,
    };
  }

  // Соло-рендеры партий — чтобы понимать, кто именно громкий.
  const partRenders = {};
  for (const partId of parts) {
    const rendered = await renderBars({ render, bars, sampleRate, cps, partId });
    partRenders[partId] = { channels: rendered.channels, sampleRate: rendered.sampleRate };
  }

  const report = buildMetricsReport(main.channels, main.sampleRate, {
    renderMode: 'offline',
    bars,
    repeatability,
    parts: partRenders,
  });

  return {
    report,
    channels: main.channels,
    sampleRate: main.sampleRate,
    renderMs: Date.now() - started,
    comparison,
  };
}

/**
 * Рендер одной партии (соло) — для проверки баланса.
 *
 * @param {object} options то же, что у renderAndMeasure, плюс partId
 * @returns {Promise<{report:object, channels:Float64Array[], renderMs:number}>}
 */
export async function renderPart({ render, bars = [0, 16], sampleRate = DEFAULT_SAMPLE_RATE, cps = DEFAULT_CPS, partId }) {
  const started = Date.now();
  const rendered = await renderBars({ render, bars, sampleRate, cps, partId });
  const report = buildMetricsReport(rendered.channels, rendered.sampleRate, {
    renderMode: 'offline',
    bars,
  });
  return { report, channels: rendered.channels, sampleRate: rendered.sampleRate, renderMs: Date.now() - started };
}
