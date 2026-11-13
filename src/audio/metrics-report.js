// MetricsReport — метрики рендера с паспортом происхождения.
//
// Правило из §5 промта: «Ни один потребитель не принимает числа без паспорта».
// Поэтому отчёт всегда содержит версию движка, способ рендера и — если
// рендеров было два — повторяемость. autoMix и приёмка работают только при
// repeatability.passed; иначе — предупреждение и ручной режим.
//
// Все числа считаются ТЕМ ЖЕ DSP-ядром, что звучит в реалтайме:
// src/audio/dsp/* — чистые модули без Web Audio, поэтому один и тот же код
// исполняется в браузере, в офлайн-рендерере и в Node-тестах.

import { z } from 'zod';
import { measureLoudness, measurePeakDbfs, measureCrestDb } from './dsp/loudness.js';
import { measureTruePeak } from './dsp/truepeak.js';
import { measureBands, BANDS } from './dsp/bands.js';
import { ENGINE_VERSION_STRING } from './engine-version.js';

/** Коридор приёмки: §6 промта. */
export const ACCEPTANCE = {
  targetLufs: -14,
  lufsCorridor: [-16, -12],
  truePeakCeilingDbtp: -1.0,
  headroomDb: 6,
  voicePeakDbfs: -3,
  repeatabilityLufsDeltaDb: 0.3,
};

/**
 * Считает метрики по отрендеренным каналам.
 *
 * @param {Float64Array[]} channels
 * @param {number} sampleRate
 * @param {object} [options]
 * @param {number} [options.renderMode] 'offline' | 'realtime' | 'plan'
 * @param {[number, number]} [options.bars]
 * @param {{runs:number, lufsDeltaDb:number, passed:boolean}} [options.repeatability]
 * @param {object} [options.parts] { [id]: { channels, sampleRate } } — соло-рендеры партий
 * @param {object} [options.engineVersion]
 * @returns {object} MetricsReport
 */
export function buildMetricsReport(channels, sampleRate, options = {}) {
  const {
    renderMode = 'offline',
    bars = null,
    repeatability = null,
    parts = {},
    engineVersion = ENGINE_VERSION_STRING,
  } = options;

  const loudness = measureLoudness(channels, sampleRate);
  const peak = measureTruePeak(channels, sampleRate);
  const bands = measureBands(channels, sampleRate);
  const samplePeak = measurePeakDbfs(channels);
  const crest = measureCrestDb(channels);

  const report = {
    engineVersion,
    sampleRate,
    renderMode,
    repeatability,
    bars,
    lufsI: loudness.lufsI,
    lufsM: loudness.lufsM,
    lufsS: loudness.lufsS,
    truePeakDbtp: peak.truePeakDb,
    peakDbfs: samplePeak,
    clipCount: countClips(channels),
    crestDb: crest,
    bands: bandLevels(bands),
    silence: detectSilence(channels, sampleRate),
    parts: {},
    warnings: [],
  };

  for (const [id, part] of Object.entries(parts)) {
    const partChannels = part?.channels;
    if (!partChannels || !partChannels.length) continue;
    const partLoudness = measureLoudness(partChannels, part.sampleRate || sampleRate);
    const partBands = measureBands(partChannels, part.sampleRate || sampleRate);
    report.parts[id] = {
      lufsI: partLoudness.lufsI,
      peakDbfs: measurePeakDbfs(partChannels),
      bands: bandLevels(partBands),
    };
  }

  return report;
}

/** Уровни полос в dB — в порядке, заданном ядром (measureBands отдаёт dB числом). */
function bandLevels(bands) {
  const out = {};
  for (const band of BANDS) {
    const level = bands?.[band.id];
    out[band.id] = typeof level === 'number' && Number.isFinite(level) ? Number(level.toFixed(2)) : null;
  }
  return out;
}

/** Сколько отсчётов достигли полной шкалы (|x| >= 1). */
export function countClips(channels) {
  let count = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      if (Math.abs(ch[i]) >= 1) count += 1;
    }
  }
  return count;
}

/**
 * Детект тишины: в начале, в конце и внутри (более одного такта подряд).
 *
 * «Тихий» — отсчёты, у которых пик в окне 50 мс ниже −60 dBFS.
 *
 * @returns {{head:number, tail:number, internal:number}} длины в секундах
 */
export function detectSilence(channels, sampleRate, { thresholdDb = -60, windowMs = 50 } = {}) {
  const frames = Math.max(...channels.map((ch) => ch.length));
  const window = Math.max(1, Math.round((windowMs * sampleRate) / 1000));
  const threshold = Math.pow(10, thresholdDb / 20);

  // Окно считается тихим, если в нём нет ни одного отсчёта выше порога.
  const quietWindows = new Uint8Array(Math.ceil(frames / window));
  for (let w = 0; w < quietWindows.length; w += 1) {
    const from = w * window;
    const to = Math.min(from + window, frames);
    let peak = 0;
    for (const ch of channels) {
      for (let i = from; i < to; i += 1) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
    }
    quietWindows[w] = peak < threshold ? 1 : 0;
  }

  const total = quietWindows.length;
  let head = 0;
  while (head < total && quietWindows[head]) head += 1;

  let tail = 0;
  while (tail < total && quietWindows[total - 1 - tail]) tail += 1;

  // Внутренняя тишина: подряд идущие тихие окна между началом и концом.
  // Считаем только участки длиннее одного такта (barsPerCycle → длительность такта).
  const secondsPerBar = (60 / 120) * 4; // 120 BPM по умолчанию, 4 доли на такт
  const barSec = secondsPerBar;
  let internal = 0;
  let run = 0;
  for (let i = head; i < total - tail; i += 1) {
    if (quietWindows[i]) {
      run += 1;
    } else {
      if (run * (window / sampleRate) > barSec) internal += run * (window / sampleRate);
      run = 0;
    }
  }
  if (run * (window / sampleRate) > barSec) internal += run * (window / sampleRate);

  return {
    head: Number((head * (window / sampleRate)).toFixed(3)),
    tail: Number((tail * (window / sampleRate)).toFixed(3)),
    internal: Number(internal.toFixed(3)),
  };
}

/**
 * Схема отчёта для приёма с сервера (отчёт приходит из браузера).
 *
 * Сервер не может проверить числа — аудио у него нет. Поэтому отчёт
 * принимается только по форме и явно помечается как «из браузера»: потребитель
 * (autoMix, приёмка, ассистент) обязан понимать, что это данные клиента, а не
 * результат серверного измерения.
 */
export const MetricsReportSchema = z.object({
  engineVersion: z.string().max(80).optional(),
  sampleRate: z.number().positive().optional(),
  renderMode: z.enum(['offline', 'realtime', 'plan']).optional(),
  repeatability: z
    .object({
      runs: z.number().int().min(1).max(8),
      lufsDeltaDb: z.number().finite(),
      passed: z.boolean(),
    })
    .nullable()
    .optional(),
  bars: z.tuple([z.number(), z.number()]).nullable().optional(),
  lufsI: z.number().finite().nullable().optional(),
  lufsM: z.number().finite().nullable().optional(),
  lufsS: z.number().finite().nullable().optional(),
  truePeakDbtp: z.number().finite().nullable().optional(),
  peakDbfs: z.number().finite().nullable().optional(),
  clipCount: z.number().int().min(0).optional(),
  crestDb: z.number().finite().nullable().optional(),
  bands: z.record(z.number().finite().nullable()).optional(),
  silence: z
    .object({
      head: z.number().finite(),
      tail: z.number().finite(),
      internal: z.number().finite(),
    })
    .optional(),
  parts: z
    .record(
      z.object({
        lufsI: z.number().finite().nullable().optional(),
        peakDbfs: z.number().finite().nullable().optional(),
        bands: z.record(z.number().finite().nullable()).optional(),
      }),
    )
    .optional(),
  warnings: z.array(z.string().max(200)).optional(),
});

/**
 * Принимает отчёт с клиента.
 *
 * @param {unknown} raw
 * @returns {{ok:boolean, report:object|null, error?:string}}
 */
export function parseMetricsReport(raw) {
  const parsed = MetricsReportSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error?.issues?.[0];
    return {
      ok: false,
      report: null,
      error: issue ? `${issue.path.join('.') || 'отчёт'}: ${issue.message}` : 'Отчёт не прошёл проверку формы',
    };
  }
  return { ok: true, report: parsed.data };
}
