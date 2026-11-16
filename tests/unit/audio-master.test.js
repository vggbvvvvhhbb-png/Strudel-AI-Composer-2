// Фаза 2: мастер-цепочка.
//
// Проверяем то, на что мини-студия будет опираться:
//   • потолок лимитера держится на стресс-паттерне;
//   • Bypass выровнен по времени (кросс-корреляция ≈ 0 отсчётов) и без щелчков;
//   • в аудиопотоке нет аллокаций;
//   • собранный worklet даёт тот же звук, что и то же ядро в Node;
//   • потоковый измеритель громкости совпадает с пакетным.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MasterChain } from '../../src/audio/dsp/master.js';
import { LoudnessMeter } from '../../src/audio/dsp/loudness-stream.js';
import { measureLoudness } from '../../src/audio/dsp/loudness.js';
import { MASTER_PRESETS, masterPresetFor, masterPresetForCode } from '../../src/audio/master-presets.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const SR = 48000;

const dbfs = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const round = (x, n = 6) => Number(Number(x).toFixed(n));

/** Синус. */
function tone(seconds, freq, amp = 1, sr = SR) {
  const n = Math.round(sr * seconds);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** Всплески: короткие удары с тишиной между ними — стресс для лимитера. */
function bursts(seconds, freq, amp, burstSec, periodSec, sr = SR) {
  const n = Math.round(sr * seconds);
  const out = new Float64Array(n);
  const burst = Math.round(sr * burstSec);
  const period = Math.round(sr * periodSec);
  for (let i = 0; i < n; i += 1) {
    out[i] = i % period < burst ? amp * Math.sin((2 * Math.PI * freq * i) / sr) : 0;
  }
  return out;
}

/** Белый шум детерминированный (генератор с фиксированным зерном). */
function noise(seconds, amp, sr = SR) {
  const n = Math.round(sr * seconds);
  const out = new Float64Array(n);
  let seed = 123456789;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x3fffffff - 1) * amp;
  }
  return out;
}

/** Обрабатывает сигнал блоками по 128 отсчётов (как в worklet). */
function runChain(chain, left, right, blockSize = 128) {
  const outL = new Float64Array(left.length);
  const outR = new Float64Array(right.length);
  const blockL = new Float64Array(blockSize);
  const blockR = new Float64Array(blockSize);
  const resL = new Float64Array(blockSize);
  const resR = new Float64Array(blockSize);
  for (let start = 0; start < left.length; start += blockSize) {
    const end = Math.min(start + blockSize, left.length);
    const n = end - start;
    blockL.fill(0);
    blockR.fill(0);
    blockL.set(left.subarray(start, end));
    blockR.set(right.subarray(start, end));
    chain.process(blockL, blockR, resL, resR);
    outL.set(resL.subarray(0, n), start);
    outR.set(resR.subarray(0, n), start);
  }
  return [outL, outR];
}

function peakOf(signal) {
  let p = 0;
  for (let i = 0; i < signal.length; i += 1) {
    const v = Math.abs(signal[i]);
    if (v > p) p = v;
  }
  return p;
}

/** Сдвиг, при котором сигналы совпадают лучше всего (кросс-корреляция). */
function bestLag(input, output, maxLag) {
  let best = -Infinity;
  let bestLagValue = 0;
  const n = Math.min(input.length, output.length - maxLag);
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += input[i] * output[i + lag];
    if (s > best) {
      best = s;
      bestLagValue = lag;
    }
  }
  return bestLagValue;
}

describe('мастер-цепочка: потолок лимитера', () => {
  it('ни один отсчёт на стресс-паттерне не превышает потолок', () => {
    const chain = new MasterChain(SR, { ceilingDb: -1 });
    const left = bursts(2, 1000, 1.0, 0.02, 0.25);
    const right = bursts(2, 997, 1.0, 0.02, 0.25);
    const [outL, outR] = runChain(chain, left, right);

    const peak = Math.max(peakOf(outL), peakOf(outR));
    const ceiling = Math.pow(10, -1 / 20);
    expect(peak).toBeLessThanOrEqual(ceiling + 1e-9);
    // Потолок должен реально сработать, а не «просто нечего было ловить».
    expect(dbfs(peak)).toBeCloseTo(-1, 2);
  });

  it('пик ровно на потолке при синусе в 0 dBFS', () => {
    const chain = new MasterChain(SR, { ceilingDb: -1 });
    const left = tone(1, 1000, 1.0);
    const right = tone(1, 1000, 1.0);
    const [outL] = runChain(chain, left, right);
    expect(dbfs(peakOf(outL))).toBeCloseTo(-1, 2);
  });

  it('громкий шум тоже не проходит потолок', () => {
    const chain = new MasterChain(SR, { ceilingDb: -1 });
    const left = noise(1, 1.5);
    const right = noise(1, 1.5);
    const [outL, outR] = runChain(chain, left, right);
    const peak = Math.max(peakOf(outL), peakOf(outR));
    expect(dbfs(peak)).toBeLessThanOrEqual(-1 + 1e-6);
  });
});

describe('мастер-цепочка: задержка', () => {
  it('выход отстаёт от входа ровно на lookahead', () => {
    const chain = new MasterChain(SR, { ceilingDb: -1, lookaheadMs: 5 });
    const left = noise(1, 0.3);
    const right = noise(1, 0.3);
    const [outL] = runChain(chain, left, right);
    // Ищем совпадение входного и выходного сигнала: сдвиг = задержка цепочки.
    const lag = bestLag(left, outL, 400);
    expect(lag).toBe(chain.latencySamples);
    expect(chain.latencySamples).toBe(Math.round((5 * SR) / 1000));
  });
});

describe('мастер-цепочка: Bypass', () => {
  it('сухая ветка выровнена по времени с обработанной (сдвиг = задержка цепочки)', () => {
    const chain = new MasterChain(SR, { ceilingDb: -1, lookaheadMs: 5 });
    const left = noise(1, 0.4);
    const right = noise(1, 0.4);
    const [outL] = runChain(chain, left, right);

    // Кросс-корреляция: при каком сдвиге вход совпадает с выходом? Это и есть
    // задержка конвейера. Bypass-ветка задержана ровно так же.
    const lag = bestLag(left, outL, 400);
    expect(lag).toBe(chain.latencySamples);
  });

  it('после кроссфейда в bypass выход совпадает с входом, сдвинутым на задержку', () => {
    const chain = new MasterChain(SR, { ceilingDb: -1, lookaheadMs: 5 });
    const left = noise(1, 0.4);
    const right = noise(1, 0.4);

    // Прогреваем цепочку, затем полностью уходим в bypass и ждём конца кроссфейда.
    const warmup = Math.round(0.2 * SR);
    chain.process(left.subarray(0, warmup), right.subarray(0, warmup), new Float64Array(warmup), new Float64Array(warmup));
    chain.setBypass(true);
    const fade = Math.round(0.05 * SR);
    chain.process(left.subarray(warmup, warmup + fade), right.subarray(warmup, warmup + fade), new Float64Array(fade), new Float64Array(fade));

    const rest = left.length - warmup - fade;
    const outL = new Float64Array(rest);
    const outR = new Float64Array(rest);
    const block = 128;
    for (let start = 0; start < rest; start += block) {
      const end = Math.min(start + block, rest);
      const n = end - start;
      const bl = new Float64Array(block);
      const br = new Float64Array(block);
      bl.set(left.subarray(warmup + fade + start, warmup + fade + end));
      br.set(right.subarray(warmup + fade + start, warmup + fade + end));
      const rl = new Float64Array(block);
      const rr = new Float64Array(block);
      chain.process(bl, br, rl, rr);
      outL.set(rl.subarray(0, n), start);
      outR.set(rr.subarray(0, n), start);
    }

    // Сухой сигнал = вход, задержанный на lookahead.
    const lag = chain.latencySamples;
    let maxError = 0;
    for (let i = 0; i < 5000; i += 1) {
      const srcIndex = warmup + fade + i - lag;
      if (srcIndex < 0) continue;
      maxError = Math.max(maxError, Math.abs(left[srcIndex] - outL[i]));
    }
    expect(maxError).toBeLessThan(1e-6);
  });

  it('переключение не даёт щелчка (разрыв не больше, чем у самого сигнала)', () => {
    const chain = new MasterChain(SR, { ceilingDb: -1, lookaheadMs: 5 });
    const left = noise(1, 0.4);
    const right = noise(1, 0.4);

    const block = 128;
    const out = new Float64Array(left.length);
    const bl = new Float64Array(block);
    const br = new Float64Array(block);
    const rl = new Float64Array(block);
    const rr = new Float64Array(block);
    for (let start = 0; start < left.length; start += block) {
      const end = Math.min(start + block, left.length);
      const n = end - start;
      bl.fill(0);
      br.fill(0);
      bl.set(left.subarray(start, end));
      br.set(right.subarray(start, end));
      if (start === Math.round(left.length / 2)) chain.setBypass(true);
      chain.process(bl, br, rl, rr);
      out.set(rl.subarray(0, n), start);
    }

    // Максимальный скачок между соседними отсчётами: в кроссфейде он не должен
    // превышать масштаб собственных скачков сигнала.
    let maxJump = 0;
    for (let i = 1; i < out.length; i += 1) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]));
    let inputJump = 0;
    for (let i = 1; i < left.length; i += 1) inputJump = Math.max(inputJump, Math.abs(left[i] - left[i - 1]));
    expect(maxJump).toBeLessThan(inputJump * 2 + 0.05);
  });
});

describe('мастер-цепочка: аудиопоток без аллокаций', () => {
  it('рост кучи за 5000 блоков незначителен', () => {
    const chain = new MasterChain(SR, { ceilingDb: -1 });
    const block = new Float64Array(128);
    const outL = new Float64Array(128);
    const outR = new Float64Array(128);

    // Прогрев: первые вызовы создают внутренние буферы.
    for (let i = 0; i < 50; i += 1) chain.process(block, block, outL, outR);

    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 5000; i += 1) {
      block.fill((i % 100) / 100);
      chain.process(block, block, outL, outR);
    }
    if (global.gc) global.gc();
    const growth = process.memoryUsage().heapUsed - before;

    // Если бы на каждый блок выделялся буфер, рост был бы ~1 МБ (5000 × 128 × 8).
    expect(growth).toBeLessThan(512 * 1024);
  });
});

describe('потоковый измеритель громкости', () => {
  it('совпадает с пакетным измерением', () => {
    const left = tone(5, 1000, 0.5);
    const right = tone(5, 1000, 0.5);

    const meter = new LoudnessMeter(SR);
    const block = 128;
    for (let start = 0; start < left.length; start += block) {
      const end = Math.min(start + block, left.length);
      const bl = left.subarray(start, end);
      const br = right.subarray(start, end);
      meter.process(bl, br);
    }

    const batch = measureLoudness([left, right], SR);
    expect(meter.momentaryLufs).not.toBeNull();
    expect(Math.abs(meter.momentaryLufs - batch.lufsM)).toBeLessThan(0.2);
    expect(Math.abs(meter.integratedLufs - batch.lufsI)).toBeLessThan(0.3);
    expect(Math.abs(meter.peakDbfs - 20 * Math.log10(0.5))).toBeLessThan(0.01);
  });

  it('моментная громкость ниже интегральной на сигнале с паузами', () => {
    const left = new Float64Array(SR * 2);
    const right = new Float64Array(SR * 2);
    for (let i = 0; i < SR; i += 1) {
      left[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
      right[i] = left[i];
    }
    const meter = new LoudnessMeter(SR);
    const block = 128;
    for (let start = 0; start < left.length; start += block) {
      const end = Math.min(start + block, left.length);
      meter.process(left.subarray(start, end), right.subarray(start, end));
    }
    expect(meter.momentaryLufs).toBeNull(); // последнее окно — тишина
    expect(meter.integratedLufs).toBeGreaterThan(-30);
  });
});

describe('собранный worklet совпадает с ядром', () => {
  let registered = {};
  let previous = {};

  beforeAll(() => {
    // Файл worklet генерируется: собираем, чтобы тест проверял актуальный артефакт.
    execFileSync(process.execPath, [join(root, 'scripts', 'build-worklet.mjs')], { cwd: root, stdio: 'pipe' });

    const code = readFileSync(join(root, 'public', 'worklets', 'master-processor.js'), 'utf8');

    // Окружение worklet: у него своя глобальная область, в Node её нужно
    // подделать. Глобалы держим установленными до конца файла — процессор
    // читает sampleRate и при создании, и при работе.
    class FakeProcessor {
      constructor() {
        this.messages = [];
        this.port = {
          onmessage: null,
          postMessage: (message) => this.messages.push(message),
        };
      }
    }
    previous = {
      processor: globalThis.AudioWorkletProcessor,
      register: globalThis.registerProcessor,
      sampleRate: globalThis.sampleRate,
    };
    globalThis.AudioWorkletProcessor = FakeProcessor;
    globalThis.registerProcessor = (name, ctor) => {
      registered[name] = ctor;
    };
    globalThis.sampleRate = SR;

    // eslint-disable-next-line no-new-func
    new Function(code)();
  });

  afterAll(() => {
    globalThis.AudioWorkletProcessor = previous.processor;
    globalThis.registerProcessor = previous.register;
    globalThis.sampleRate = previous.sampleRate;
  });

  it('worklet зарегистрирован под нужным именем', () => {
    const Processor = registered['master-processor'];
    expect(typeof Processor).toBe('function');
  });

  it('даёт тот же выход, что и то же ядро в Node', () => {
    const Processor = registered['master-processor'];
    const processor = new Processor({ processorOptions: { master: { ceilingDb: -1 } } });

    const left = noise(0.5, 0.8);
    const right = noise(0.5, 0.7);

    // Node-ядро.
    const chain = new MasterChain(SR, { ceilingDb: -1 });
    const expectedL = new Float64Array(left.length);
    const expectedR = new Float64Array(right.length);
    const block = 128;
    for (let start = 0; start < left.length; start += block) {
      const end = Math.min(start + block, left.length);
      const n = end - start;
      const bl = new Float64Array(block);
      const br = new Float64Array(block);
      bl.set(left.subarray(start, end));
      br.set(right.subarray(start, end));
      const rl = new Float64Array(block);
      const rr = new Float64Array(block);
      chain.process(bl, br, rl, rr);
      expectedL.set(rl.subarray(0, n), start);
      expectedR.set(rr.subarray(0, n), start);
    }

    // Worklet: те же блоки, тот же результат.
    let maxDiff = 0;
    for (let start = 0; start < left.length; start += block) {
      const end = Math.min(start + block, left.length);
      const n = end - start;
      const inL = new Float32Array(block);
      const inR = new Float32Array(block);
      inL.set(left.subarray(start, end));
      inR.set(right.subarray(start, end));
      const outL = new Float32Array(block);
      const outR = new Float32Array(block);
      processor.process([[inL, inR]], [[outL, outR]]);
      for (let i = 0; i < n; i += 1) {
        maxDiff = Math.max(maxDiff, Math.abs(outL[i] - expectedL[start + i]));
        maxDiff = Math.max(maxDiff, Math.abs(outR[i] - expectedR[start + i]));
      }
    }
    // Разница только от float32 во входе/выходе worklet.
    expect(maxDiff).toBeLessThan(1e-5);
  });

  it('сообщает задержку конвейера при старте', () => {
    const Processor = registered['master-processor'];
    const processor = new Processor({ processorOptions: { master: { ceilingDb: -1, lookaheadMs: 5 } } });
    const ready = processor.messages.find((m) => m.type === 'ready');
    expect(ready).toBeTruthy();
    expect(ready.latencySamples).toBe(Math.round((5 * SR) / 1000));
  });

  it('отдаёт метры в порт', () => {
    const Processor = registered['master-processor'];
    const processor = new Processor({ processorOptions: {} });
    const block = 128;
    // Метры уходят 10 раз в секунду: 4800 отсчётов → 38 блоков по 128.
    for (let i = 0; i < 60; i += 1) {
      const inL = new Float32Array(block);
      const inR = new Float32Array(block);
      inL.fill(0.5);
      inR.fill(0.5);
      processor.process([[inL, inR]], [[new Float32Array(block), new Float32Array(block)]]);
    }
    const metrics = processor.messages.filter((m) => m.type === 'metrics');
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0].meters).toHaveProperty('lufsM');
    expect(metrics[0].meters).toHaveProperty('truePeakDb');
  });
});

describe('пресеты мастера', () => {
  it('есть пресет для каждого стиля проекта', () => {
    const styles = ['lofi', 'techno', 'house', 'ambient', 'dnb', 'synthwave', 'trap', 'jazz', 'rock', 'cinematic'];
    for (const style of styles) {
      const preset = masterPresetFor(style);
      expect(preset, `нет пресета для ${style}`).toBeTruthy();
      expect(preset.params.ceilingDb).toBeLessThanOrEqual(-1);
      expect(preset.params.comp.ratio).toBeLessThanOrEqual(4);
      expect(preset.params.comp.thresholdDb).toBeGreaterThanOrEqual(-24);
      expect(preset.params.comp.thresholdDb).toBeLessThanOrEqual(-18);
    }
  });

  it('неизвестный стиль даёт нейтральный пресет', () => {
    expect(masterPresetFor('нетакого-стиля').id).toBe('flat');
  });

  it('у всех пресетов одинаковый lookahead; потолок −1, кроме оркестра (D-121)', () => {
    for (const preset of Object.values(MASTER_PRESETS)) {
      expect(preset.params.lookaheadMs).toBe(5);
      if (preset.id === 'orchestral') {
        expect(preset.params.ceilingDb).toBe(-1.2);
      } else {
        expect(preset.params.ceilingDb).toBe(-1);
      }
    }
  });

  it('оркестровый пресет не жмёт плотный микс порогом −20 (замер §1.4)', () => {
    const preset = masterPresetFor('orchestral');
    expect(preset.params.comp.thresholdDb).toBe(-7);
    expect(preset.params.comp.ratio).toBe(4);
    expect(preset.params.comp.makeupDb).toBe(1);
    expect(preset.params.ceilingDb).toBeLessThanOrEqual(-1);
  });

  it('masterPresetForCode: опера (cinematic, ≥24 партий) → оркестровый пресет', () => {
    const parts = Array.from({ length: 30 }, (_, i) => `$P${String(i + 1).padStart(3, '0')}: note("c3") // role=violin`).join('\n');
    const code = `// cinematic — 90 BPM, C minor\nsetCpm(90/4)\n${parts}`;
    expect(masterPresetForCode(code).id).toBe('orchestral');
  });

  it('masterPresetForCode: малый cinematic-состав остаётся на cinematic', () => {
    const code = '// cinematic — 90 BPM, C minor\n$LEAD: note("c4")\n$BASS: note("c2")';
    expect(masterPresetForCode(code).id).toBe('cinematic');
  });

  it('masterPresetForCode: стиль спека сопоставляется с пресетом, muted-партии считаются', () => {
    expect(masterPresetForCode('// lo-fi — 80 BPM\n_$DRUMS: s("bd")').id).toBe('lofi');
    expect(masterPresetForCode('// techno — 128 BPM\n$KICK: s("bd")').id).toBe('techno');
    expect(masterPresetForCode('').id).toBe('flat');
    expect(masterPresetForCode('setCpm(1)').id).toBe('flat');
  });
});
