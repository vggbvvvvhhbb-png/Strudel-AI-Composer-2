// Сравнение код-двойника с оригиналом — метрики похожести по слоям.
//
// ЧЕСТНОСТЬ — главное правило этого модуля:
//
//   * сравниваются ТОЛЬКО те слои, которые есть и у оригинала, и у двойника;
//     отсутствующий слой — это «нет данных», а не «0 % похоже»;
//   * каждая метрика показывает, КАК считалась (метод и версия);
//   * общая оценка — среднее по слоям, а не по слоям, которых нет;
//   * ничего не выдумывается: нет измерения — нет числа.
//
// Метрики (по плану владельца §3.3 шаг 8):
//   ритм  — F-measure атак кода против атак стема, допуск ±50 мс;
//   бас   — доля совпавших нот (питч ±50 центов, октава-агностик) + RMSE f0;
//   тембр — косинусное сходство log-mel спектрограмм;
//   грув  — корреляция огибающих + разница свинга;
//   громкость — разница LUFS integrated.

import { detectOnsets, onsetFMeasure, envelopeCorrelation } from '../../src/audio/dsp/onsets.js';
import { logMelSpectrogram, cosineSimilarity } from '../../src/audio/dsp/mel.js';
import { measureLoudness } from '../../src/audio/dsp/loudness.js';

export const COMPARE_METHOD = 'deep-dive/compare@0.1.0';
export const TOLERANCE_MS = 50;
export const PITCH_TOLERANCE_CENTS = 50;

/** Вес каждого слоя в общей оценке. Слои без данных в оценку не входят. */
const LAYER_WEIGHTS = { rhythm: 0.35, bass: 0.3, timbre: 0.25, groove: 0.1 };

/**
 * Сравнение двух списков нот баса.
 *
 * @param {Array<{time_s:number, midi:number, confidence?:number}>} reference ноты оригинала
 * @param {Array<{time_s:number, midi:number}>} candidate ноты двойника
 * @param {{toleranceMs?:number, pitchToleranceCents?:number, octaveAgnostic?:boolean}} [options]
 */
export function compareNotes(reference, candidate, options = {}) {
  const tolerance = (options.toleranceMs ?? 100) / 1000;
  const pitchTolerance = options.pitchToleranceCents ?? PITCH_TOLERANCE_CENTS;
  const octaveAgnostic = options.octaveAgnostic !== false;
  const ref = [...(reference ?? [])].sort((a, b) => a.time_s - b.time_s);
  const cand = [...(candidate ?? [])].sort((a, b) => a.time_s - b.time_s);
  if (!ref.length || !cand.length) {
    return { note_match_ratio: 0, matched: 0, reference_count: ref.length, candidate_count: cand.length };
  }
  const used = new Array(cand.length).fill(false);
  let matched = 0;
  const centsErrors = [];
  for (const note of ref) {
    let bestIndex = -1;
    let bestCents = Infinity;
    for (let i = 0; i < cand.length; i += 1) {
      if (used[i]) continue;
      if (Math.abs(cand[i].time_s - note.time_s) > tolerance) continue;
      let cents = (cand[i].midi - note.midi) * 100;
      if (octaveAgnostic) {
        // Октавовая неопределённость фона: 1200 центов — это целая октава.
        while (cents > 600) cents -= 1200;
        while (cents < -600) cents += 1200;
      }
      if (Math.abs(cents) <= pitchTolerance && Math.abs(cents) < Math.abs(bestCents)) {
        bestCents = cents;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      used[bestIndex] = true;
      matched += 1;
      centsErrors.push(bestCents);
    }
  }
  const ratio = matched / Math.max(ref.length, cand.length);
  const rmse = centsErrors.length
    ? Math.sqrt(centsErrors.reduce((sum, c) => sum + c * c, 0) / centsErrors.length)
    : null;
  return {
    note_match_ratio: Number(ratio.toFixed(4)),
    matched,
    reference_count: ref.length,
    candidate_count: cand.length,
    f0_rmse_cents: rmse === null ? null : Number(rmse.toFixed(2)),
    octave_agnostic: octaveAgnostic,
  };
}

/**
 * Сравнение слоя «ритм»: атаки кода против атак оригинала.
 *
 * @param {{channels:Float64Array[], sampleRate:number}} reference
 * @param {{channels:Float64Array[], sampleRate:number}} candidate
 */
export function compareRhythm(reference, candidate, options = {}) {
  const refOnsets = detectOnsets(reference.channels, reference.sampleRate, options.onset);
  const candOnsets = detectOnsets(candidate.channels, candidate.sampleRate, options.onset);
  const score = onsetFMeasure(refOnsets.times, candOnsets.times, { toleranceMs: options.toleranceMs ?? TOLERANCE_MS });
  return {
    ...score,
    reference_onsets: refOnsets.times.length,
    candidate_onsets: candOnsets.times.length,
  };
}

/** Сравнение тембра: log-mel косинус. */
export function compareTimbre(reference, candidate, options = {}) {
  const melOptions = options.mel ?? {};
  const a = logMelSpectrogram(reference.channels, reference.sampleRate, melOptions);
  const b = logMelSpectrogram(candidate.channels, candidate.sampleRate, melOptions);
  const similarity = cosineSimilarity(a, b);
  return {
    cosine: Number(similarity.profile.toFixed(4)),
    mean_frame_cosine: Number(similarity.meanFrame.toFixed(4)),
    mel_bands: a.nMels,
    reference_frames: a.frames,
    candidate_frames: b.frames,
  };
}

/** Сравнение грува: корреляция огибающих + разница свинга. */
export function compareGroove(reference, candidate, options = {}) {
  const correlation = envelopeCorrelation(reference.channels, reference.sampleRate);
  const candidateCorrelation = envelopeCorrelation(candidate.channels, candidate.sampleRate);
  const refSwing = reference.swing ?? null;
  const candSwing = candidate.swing ?? null;
  return {
    envelope_correlation: correlation,
    candidate_envelope_correlation: candidateCorrelation,
    swing_delta: refSwing !== null && candSwing !== null ? Number(Math.abs(refSwing - candSwing).toFixed(4)) : null,
  };
}

/**
 * Полное сравнение двойника с оригиналом.
 *
 * @param {object} input
 * @param {object} input.reference {drums?:{channels,sampleRate}, bass?:..., other?:..., mix?:...}
 * @param {object} input.candidate {drums?:..., bass?:..., other?:..., mix?:...}
 * @param {Array} [input.referenceBassNotes] ноты баса оригинала (из питч-трека)
 * @param {Array} [input.candidateBassNotes] ноты баса двойника (из плана)
 * @param {number} [input.referenceSwing]
 * @param {number} [input.candidateSwing]
 * @param {string} [input.iterationLabel]
 * @returns {object} запись метрик по контракту deep-dive.schema.json
 */
export function compareTwin(input) {
  const {
    reference = {},
    candidate = {},
    referenceBassNotes = null,
    candidateBassNotes = null,
    referenceSwing = null,
    candidateSwing = null,
    iterationLabel = 'baseline',
    iteration = 0,
  } = input;

  const layers = {};
  const scores = [];

  // Ритм — по слою ударных.
  if (reference.drums?.channels?.length && candidate.drums?.channels?.length) {
    const rhythm = compareRhythm(reference.drums, candidate.drums);
    layers.rhythm = rhythm;
    scores.push({ value: rhythm.f1, weight: LAYER_WEIGHTS.rhythm });
  }

  // Бас — по нотам (питч-трек оригинала + план двойника).
  if (referenceBassNotes?.length && candidateBassNotes?.length) {
    const bass = compareNotes(referenceBassNotes, candidateBassNotes);
    layers.bass = bass;
    if (bass.note_match_ratio > 0) scores.push({ value: bass.note_match_ratio, weight: LAYER_WEIGHTS.bass });
  }

  // Тембр — по каждому слою, где есть обе стороны.
  const timbreParts = [];
  for (const layer of ['drums', 'bass', 'other']) {
    if (!reference[layer]?.channels?.length || !candidate[layer]?.channels?.length) continue;
    const timbre = compareTimbre(reference[layer], candidate[layer]);
    layers.timbre = layers.timbre ?? { per_layer: {}, cosine: 0, mel_bands: timbre.mel_bands };
    layers.timbre.per_layer[layer] = timbre;
    timbreParts.push(timbre.cosine);
  }
  if (timbreParts.length) {
    const mean = timbreParts.reduce((sum, v) => sum + v, 0) / timbreParts.length;
    layers.timbre.cosine = Number(mean.toFixed(4));
    scores.push({ value: mean, weight: LAYER_WEIGHTS.timbre });
  }

  // Грув — по огибающим ударных (или микса, если слоя ударных нет).
  const grooveRef = reference.drums ?? reference.mix;
  const grooveCand = candidate.drums ?? candidate.mix;
  if (grooveRef?.channels?.length && grooveCand?.channels?.length) {
    const groove = compareGroove(
      { ...grooveRef, swing: referenceSwing },
      { ...grooveCand, swing: candidateSwing },
    );
    layers.groove = groove;
    // Корреляция огибающих может быть отрицательной — в оценку идёт
    // нормированное значение 0..1, иначе «антикорреляция» шла бы «в минус».
    const normalized = Math.max(0, Math.min(1, (groove.envelope_correlation + 1) / 2));
    scores.push({ value: normalized, weight: LAYER_WEIGHTS.groove });
  }

  // Громкость — по миксу.
  if (reference.mix?.channels?.length && candidate.mix?.channels?.length) {
    const refLufs = measureLoudness(reference.mix.channels, reference.mix.sampleRate).lufsI;
    const candLufs = measureLoudness(candidate.mix.channels, candidate.mix.sampleRate).lufsI;
    layers.loudness = {
      lufs_delta_db: Number((candLufs - refLufs).toFixed(2)),
      twin_lufs_i: Number(candLufs.toFixed(2)),
      reference_lufs_i: Number(refLufs.toFixed(2)),
    };
  }

  const overall = scores.length
    ? scores.reduce((sum, item) => sum + item.value * item.weight, 0) / scores.reduce((sum, item) => sum + item.weight, 0)
    : 0;

  return {
    iteration,
    label: iterationLabel,
    overall: Number(overall.toFixed(4)),
    layers,
    method: COMPARE_METHOD,
    measured_layers: scores.map((item) => item.value >= 0 ? item.value : 0),
    missing_layers: ['rhythm', 'bass', 'timbre', 'groove'].filter((name) => !layers[name]),
  };
}
