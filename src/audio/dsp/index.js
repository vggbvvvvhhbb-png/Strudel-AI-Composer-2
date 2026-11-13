// DSP-ядро мини-студии: чистые ES-модули без Web Audio.
// Их импортируют и мастер-worklet, и Node-тесты, и офлайн-рендерер —
// поэтому метрики в реалтайме и в CI считаются одним и тем же кодом.

export { biquadCoeffs, Biquad } from './biquad.js';
export { KWeighting, kWeightingCoefficients, K_WEIGHTING_48K } from './k-weighting.js';
export {
  measureLoudness,
  measurePeakDbfs,
  measureCrestDb,
  ABSOLUTE_GATE_LUFS,
  RELATIVE_GATE_LU,
  LOUDNESS_OFFSET,
} from './loudness.js';
export { measureTruePeak, TruePeakOversampler, truePeakFilter } from './truepeak.js';
export { LookaheadLimiter } from './limiter.js';
export { GlueCompressor } from './comp.js';
export { BandAnalyzer, measureBands, BANDS } from './bands.js';
