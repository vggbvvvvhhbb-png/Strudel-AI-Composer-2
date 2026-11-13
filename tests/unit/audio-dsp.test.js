// Контрактные тесты DSP-ядра мини-студии.
//
// Ядро — чистые ES-модули без Web Audio: их импортируют и мастер-worklet,
// и Node-тесты, и офлайн-рендерер. Поэтому метрики в реалтайме и в CI
// считаются одним и тем же кодом.
//
// Тесты падают при регрессии: смена формул, фильтров или нормировок
// обязана ломать сборку, а не «тихо менять цифры в метриках».
//
// Сверка с эталоном (ffmpeg/libebur128) — отдельный прогон:
//   npm run validate:loudness

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  kWeightingCoefficients,
  K_WEIGHTING_48K,
  KWeighting,
} from '../../src/audio/dsp/k-weighting.js';
import {
  measureLoudness,
  measurePeakDbfs,
  measureCrestDb,
} from '../../src/audio/dsp/loudness.js';
import { measureTruePeak } from '../../src/audio/dsp/truepeak.js';
import { LookaheadLimiter } from '../../src/audio/dsp/limiter.js';
import { GlueCompressor } from '../../src/audio/dsp/comp.js';
import { measureBands, BANDS } from '../../src/audio/dsp/bands.js';

const here = dirname(fileURLToPath(import.meta.url));
const SR = 48000;

function sine(frames, freq, amp, sampleRate = SR) {
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

function rmsDb(samples) {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return 10 * Math.log10(sum / samples.length);
}

describe('K-взвешивание (ITU-R BS.1770-4)', () => {
  it('коэффициенты на 48 кГц совпадают с таблицей стандарта', () => {
    const { shelf, hpf } = kWeightingCoefficients(48000);
    for (const key of ['b0', 'b1', 'b2', 'a1', 'a2']) {
      expect(shelf[key]).toBeCloseTo(K_WEIGHTING_48K.shelf[key], 12);
      expect(hpf[key]).toBeCloseTo(K_WEIGHTING_48K.hpf[key], 12);
    }
  });

  it('коэффициенты пересчитываются под частоту дискретизации', () => {
    const a = kWeightingCoefficients(44100);
    const b = kWeightingCoefficients(48000);
    expect(a.shelf.b0).not.toBeCloseTo(b.shelf.b0, 6);
    // Шелл нормирован: усиление на постоянной составляющей — ровно 1
    // в любой частоте дискретизации (иначе громкость «плыла» бы с сэмплрейтом).
    for (const sr of [44100, 48000, 96000]) {
      const { shelf, hpf } = kWeightingCoefficients(sr);
      const dcShelf = (shelf.b0 + shelf.b1 + shelf.b2) / (1 + shelf.a1 + shelf.a2);
      const dcHpf = (hpf.b0 + hpf.b1 + hpf.b2) / (1 + hpf.a1 + hpf.a2);
      expect(dcShelf).toBeCloseTo(1, 12);
      expect(dcHpf).toBeCloseTo(0, 12);
    }
  });

  it('АЧХ: около 0 dB на 1 кГц и +4 dB на 10 кГц', () => {
    const gainAt = (freq) => {
      const n = SR;
      const x = sine(n, freq, 0.5);
      const kw = new KWeighting(SR);
      const [y] = kw.processStereo(x, x);
      const from = Math.round(SR * 0.2);
      return rmsDb(y.subarray(from)) - rmsDb(x.subarray(from));
    };
    expect(gainAt(1000)).toBeCloseTo(0.7, 1);
    expect(gainAt(10000)).toBeCloseTo(4, 1);
    // Низа режутся мягко (RLB-фильтр 2-го порядка, Q = 0.5):
    // 50 Гц — около −4 дБ, 20 Гц — уже −13 дБ.
    expect(gainAt(50)).toBeLessThan(-3);
    expect(gainAt(20)).toBeLessThan(-12);
  });
});

describe('громкость по BS.1770', () => {
  it('стерео-синус 1 кГц −20 dBFS даёт −20 LUFS (dual-mono +3 dB)', () => {
    const l = sine(SR * 3, 1000, 0.1);
    const { lufsI } = measureLoudness([l, Float64Array.from(l)], SR);
    // −20 dBFS пик → среднеквадратичный −23 dBFS → +3 dB (два канала) → −20 LUFS.
    expect(lufsI).toBeCloseTo(-20, 1);
  });

  it('тишина не даёт интегральной громкости', () => {
    const silence = new Float64Array(SR * 2);
    const { lufsI } = measureLoudness([silence], SR);
    expect(lufsI).toBeNull();
  });

  it('установившийся сигнал даёт расчётную громкость', () => {
    // Пик −10 dBFS → среднеквадратичный −13 dBFS → +0.7 dB (K) − 0.69 (смещение).
    const signal = sine(SR * 3, 1000, 0.316);
    const { lufsI } = measureLoudness([signal], SR);
    expect(lufsI).toBeCloseTo(-13, 1);
  });

  it('абсолютный гейт отсекает тихие хвосты', () => {
    // 1 с сигнала + 2 с тишины: часть блоков не заполнена сигналом, гейт их
    // отбрасывает, поэтому интегральная громкость ниже установившейся.
    const frames = SR * 3;
    const signal = new Float64Array(frames);
    signal.set(sine(SR, 1000, 0.316), 0);
    const { lufsI, gatedBlocks, blockLufs } = measureLoudness([signal], SR);
    expect(gatedBlocks).toBeLessThan(blockLufs.length);
    expect(lufsI).toBeLessThan(-13);
    expect(lufsI).toBeGreaterThan(-16);
  });

  it('пик и crest считаются по всем каналам', () => {
    const l = sine(SR, 1000, 0.5);
    const r = sine(SR, 1000, 0.25);
    expect(measurePeakDbfs([l, r])).toBeCloseTo(-6.02, 1);
    // Синус: crest = 3.01 dB.
    expect(measureCrestDb([l])).toBeCloseTo(3.01, 1);
  });
});

describe('true peak', () => {
  it('на низкочастотном сигнале совпадает с sample peak', () => {
    const l = sine(SR, 1000, 0.5);
    const { truePeakDb, peakDb } = measureTruePeak([l], SR);
    expect(truePeakDb).toBeCloseTo(peakDb, 1);
  });

  it('на высокочастотном сигнале выше sample peak', () => {
    // 12 кГц при 48 кГц — кратно fs/4, поэтому отсчёты попадают ровно на пик
    // и разницы нет. 11 кГц — не кратно: пик между отсчётами выше sample peak.
    const l = sine(SR, 11000, 0.5);
    const { truePeakDb, peakDb } = measureTruePeak([l], SR);
    expect(truePeakDb).toBeGreaterThan(peakDb);
    expect(truePeakDb - peakDb).toBeLessThan(1);
  });

  it('задержка реконструкции целая и не влияет на пик', () => {
    const l = sine(SR, 12000, 0.5);
    const res = measureTruePeak([l], SR);
    expect(Number.isInteger(res.latencySamples)).toBe(true);
    expect(res.latencySamples).toBeGreaterThan(0);
  });
});

describe('lookahead-лимитер', () => {
  it('не превышает потолок', () => {
    const limiter = new LookaheadLimiter(SR, { ceilingDb: -1, lookaheadMs: 5 });
    const left = sine(SR, 100, 0.99);
    const right = Float64Array.from(left);
    const [outL, outR] = limiter.process(left, right);
    let peak = 0;
    for (let i = 0; i < outL.length; i += 1) {
      peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
    }
    const ceiling = Math.pow(10, -1 / 20);
    expect(peak).toBeLessThanOrEqual(ceiling + 1e-9);
    expect(limiter.grDb).toBeLessThanOrEqual(0);
  });

  it('сообщает задержку конвейера', () => {
    const limiter = new LookaheadLimiter(SR, { lookaheadMs: 5 });
    expect(limiter.latencySamples).toBe(Math.round((5 * SR) / 1000));
  });

  it('тихий сигнал не трогает', () => {
    const limiter = new LookaheadLimiter(SR, { ceilingDb: -1 });
    const left = sine(SR, 1000, 0.05);
    const [outL] = limiter.process(left, Float64Array.from(left));
    expect(rmsDb(outL.subarray(SR / 2))).toBeCloseTo(rmsDb(left.subarray(SR / 2)), 2);
  });
});

describe('glue-компрессор', () => {
  it('сжимает сигнал выше порога', () => {
    const comp = new GlueCompressor(SR, { thresholdDb: -20, ratio: 3 });
    const left = sine(SR * 2, 100, 0.5);
    const [outL] = comp.process(left, Float64Array.from(left));
    const from = SR;
    expect(rmsDb(outL.subarray(from))).toBeLessThan(rmsDb(left.subarray(from)));
    expect(comp.grDb).toBeLessThan(0);
    expect(comp.grDb).toBeGreaterThan(-20);
  });

  it('сигнал ниже порога не трогает', () => {
    const comp = new GlueCompressor(SR, { thresholdDb: -20, ratio: 3 });
    const left = sine(SR * 2, 100, 0.05);
    const [outL] = comp.process(left, Float64Array.from(left));
    expect(rmsDb(outL.subarray(SR / 2))).toBeCloseTo(rmsDb(left.subarray(SR / 2)), 2);
  });
});

describe('полосы', () => {
  const energyOf = (db) => (Number.isFinite(db) ? Math.pow(10, db / 10) : 0);

  it('сумма энергий полос близка к полной энергии сигнала', () => {
    const l = sine(SR, 100, 0.5);
    const levels = measureBands([l], SR);
    const sum = BANDS.reduce((acc, band) => acc + energyOf(levels[band.id]), 0);
    const total = 0.5 * 0.5 * 0.5; // среднеквадратичное в полосе синуса амплитудой 0.5
    expect(sum).toBeGreaterThan(total * 0.8);
    expect(sum).toBeLessThan(total * 1.25);
  });

  it('тон 100 Гц попадает в низкую полосу, а не в средние', () => {
    const l = sine(SR, 100, 0.5);
    const levels = measureBands([l], SR);
    expect(levels.low).toBeGreaterThan(levels.mid);
    expect(levels.low).toBeGreaterThan(levels.highMid);
  });
});

describe('DSP-ядро не зависит от платформы', () => {
  it('в модулях ядра нет обращений к Web Audio', () => {
    const dir = join(here, '../../src/audio/dsp');
    const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');
      expect(source).not.toMatch(/AudioContext|createGain|createBiquadFilter|AudioWorklet|AudioNode/);
    }
  });
});
