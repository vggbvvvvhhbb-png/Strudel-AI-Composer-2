// Этап 6: сравнение двойника с оригиналом.
//
// Сравниваем по слоям: микс против микса, бас против баса, ударные против
// ударных. Если слоя нет — метрики по нему не будет вовсе, а не «ноль».
//
// Сравнение всегда на общей длине: сигналы разной длины обрезаются до
// минимума, иначе метрика зависит от того, что длиннее.

import { decodeWav } from '../../../src/core/wav.js';
import { compareTwin, COMPARE_METHOD } from '../compare.js';
import { detectBassNotes } from '../../../src/audio/dsp/pitch.js';
import { trimChannels } from './helpers.js';

/**
 * @param {object} params
 * @param {object} params.original исходный микс (прочитанный WAV)
 * @param {object|null} params.mixRender рендер двойника
 * @param {object} params.layerRenders рендеры отдельных слоёв
 * @param {object} params.stemAudio исходные слои с диска
 * @param {object} params.stemDescriptors измеренные дескрипторы слоёв
 * @returns {object|null} метрики baseline или null, если рендера не было
 */
export function compareStage({ original, mixRender, layerRenders, stemAudio, stemDescriptors }) {
  if (!mixRender?.wav) return null;

  const candidateWav = decodeWav(mixRender.wav);
  const twinFrames = candidateWav.frames;
  const referenceMix = {
    channels: trimChannels(original.channels, twinFrames),
    sampleRate: original.sampleRate,
  };
  const candidateMix = {
    channels: trimChannels(candidateWav.channels, twinFrames),
    sampleRate: candidateWav.sampleRate,
  };

  const reference = { mix: referenceMix };
  const candidate = { mix: candidateMix };
  for (const [layer, rendered] of Object.entries(layerRenders)) {
    if (!rendered?.wav) continue;
    const decoded = decodeWav(rendered.wav);
    candidate[layer] = { channels: decoded.channels, sampleRate: decoded.sampleRate };
    const source = stemAudio[layer];
    if (source) {
      reference[layer] = {
        channels: trimChannels(source.channels, decoded.frames),
        sampleRate: source.sampleRate,
      };
    }
  }

  // Ноты баса.
  //
  // Стороны должны быть РАЗНЫМИ. Раньше обе брались из питч-трека
  // оригинала (stemDescriptors.bass.pitch.notes), поэтому совпадение всегда
  // было 100 %, а вес слоя — 30 % общей оценки. Теперь:
  //   • оригинал — измеренные питч-ноты его стема (дескрипторы воркера);
  //   • двойник — питч-трек с ЕГО отрендеренного стема баса.
  // Если нот нет ни с одной стороны — слой не публикуется («нет данных»).
  const referenceBassNotes = stemDescriptors.bass?.pitch?.notes?.length
    ? stemDescriptors.bass.pitch.notes
    : null;

  let candidateBassNotes = null;
  const candidateBassAudio = candidate.bass;
  if (candidateBassAudio?.channels?.length) {
    const notes = detectBassNotes(candidateBassAudio.channels, candidateBassAudio.sampleRate);
    if (notes.length) candidateBassNotes = notes;
  }

  const comparison = compareTwin({
    reference,
    candidate,
    referenceBassNotes,
    candidateBassNotes,
    referenceSwing: stemDescriptors.drums?.onsets?.swing ?? null,
    candidateSwing: null,
    iterationLabel: 'baseline',
    iteration: 0,
  });

  return {
    iteration: 0,
    label: 'baseline',
    overall: comparison.overall,
    coverage: comparison.coverage,
    layers: comparison.layers,
  };
}

export { COMPARE_METHOD };
