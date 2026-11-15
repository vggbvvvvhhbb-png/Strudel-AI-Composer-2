// Цикл самоулучшения двойника: план → правки → рендер → метрики.
//
// Проверяем главное правило этапа D: модель НЕ может добавить числа, которых
// нет в измерениях. Это проверяется кодом, а не просьбой модели: операция с
// неподтверждённым значением отклоняется с причиной, а план не меняется.
//
// Сеть не вызывается: модель подменена заглушкой (options.respond), рендер —
// тоже (options.render), а метрики считает настоящий compareTwin на
// синтетическом сигнале.

import { describe, it, expect } from 'vitest';
import { refineTwin, parseModelOperations } from '../../server/deepdive/refine.js';
import { compareTwin } from '../../server/deepdive/compare.js';

const SAMPLE_RATE = 8000;

/** Щелчки в заданные моменты — экспоненциальный спад. */
function clicks(times, seconds = 3, sampleRate = SAMPLE_RATE, amplitude = 0.8) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float64Array(n);
  for (const time of times) {
    const start = Math.round(time * sampleRate);
    for (let i = 0; i < 1200 && start + i < n; i += 1) {
      out[start + i] += amplitude * Math.exp(-i / 180) * Math.sin((2 * Math.PI * 1500 * i) / sampleRate);
    }
  }
  return [out];
}

/** План-двойник: две секции по 8 тактов (форма 16..96 — как требует схема). */
function planFixture(bpm = 92) {
  const group = (sample, steps, gain) => ({ sample, steps, gain, lateMs: 0 });
  return {
    meta: { style: 'trap', bpm, key: 'Cmin', schemaVersion: '0.1' },
    structure: {
      sections: [
        { name: 'intro', cycles: 8, energy: 0.4, harmony: 'Cmin' },
        { name: 'verse', cycles: 8, energy: 0.6, harmony: 'Cmin' },
      ],
    },
    parts: {
      roles: {
        kick: {
          activeIn: ['intro', 'verse'],
          pattern: 'bd',
          sound: 's',
          sections: {
            intro: { groups: [group('bd', [0, 8], 0.9)] },
            verse: { groups: [group('bd', [0, 8], 0.95)] },
          },
        },
        hats: {
          activeIn: ['intro', 'verse'],
          pattern: 'hh',
          sound: 's',
          sections: {
            intro: { groups: [group('hh', [4, 12], 0.4)] },
            verse: { groups: [group('hh', [4, 12], 0.45)] },
          },
        },
        bass: {
          activeIn: ['intro', 'verse'],
          pattern: 'c4 ~ c4 ~',
          sound: 'sine',
          gainPattern: '0.8 0.8 ~ ~',
          sections: {
            intro: { pattern: 'c4 ~ c4 ~' },
            verse: { pattern: 'c4 ~ c4 ~' },
          },
        },
      },
    },
    reasoning: 'тестовый двойник',
  };
}

/** Измерения: темп 92 BPM, сетка 1/16, ноты баса — из питч-трека. */
const MEASUREMENTS = {
  tempo: { bpm: 92, confidence: 0.9, candidates: [{ bpm: 46, kind: 'half_time', confidence: 0.4 }] },
  key: { tonic: 'C', mode: 'minor', confidence: 0.7 },
  loudness: { lufs_integrated: -9, true_peak_dbtp: -0.8 },
  spectral_balance: { sub: 0.3, low: 0.25, low_mid: 0.2, mid: 0.15, high_mid: 0.07, high: 0.03 },
};

const STEM_DESCRIPTORS = {
  drums: {
    activity: { 0: 0.6, 1: 0.9 },
    onsets: {
      count: 4,
      grid: { step: '1/16', fit_ratio: 0.9 },
      swing: 0.56,
      hits: [
        { time_s: 0, gm: 36, velocity: 0.9 },
        { time_s: 1.304, gm: 36, velocity: 0.95 },
        { time_s: 0.652, gm: 42, velocity: 0.4 },
        { time_s: 1.956, gm: 42, velocity: 0.45 },
      ],
    },
  },
  bass: {
    activity: { 0: 0.5, 1: 0.8 },
    pitch: { notes: [{ time_s: 0, midi: 36, confidence: 0.8 }, { time_s: 1.304, midi: 36, confidence: 0.8 }] },
  },
  other: { activity: { 0: 0.2, 1: 0.4 }, chords: [] },
};

/** Все группы партии (верхний уровень + секции). */
function groupsOf(part) {
  const out = [];
  for (const group of part?.groups ?? []) out.push(group);
  for (const override of Object.values(part?.sections ?? {})) {
    for (const group of override?.groups ?? []) out.push(group);
  }
  return out;
}

/** Рендер-заглушка: щелчки на шагах кика из ПЛАНА (кода он не касается). */
function rendererFromPlan() {
  return async ({ spec }) => {
    const barSec = 240 / spec.meta.bpm;
    const times = [];
    for (const part of Object.values(spec.parts.roles)) {
      for (const group of groupsOf(part)) {
        for (const step of group.steps) times.push((step * barSec) / 16);
      }
    }
    const signal = clicks(times);
    return {
      drums: { channels: signal, sampleRate: SAMPLE_RATE },
      mix: { channels: signal, sampleRate: SAMPLE_RATE },
    };
  };
}

/** Оригинал: те же щелчки, что и у baseline-плана. */
function referenceAudio() {
  const barSec = 240 / 92;
  const signal = clicks([0, (8 * barSec) / 16]);
  return { drums: { channels: signal, sampleRate: SAMPLE_RATE }, mix: { channels: signal, sampleRate: SAMPLE_RATE } };
}

/** Baseline-метрики: честный compareTwin оригинала и двойника. */
async function baselineFor(render) {
  const candidate = await render({ spec: planFixture(), code: '', iteration: 0 });
  return compareTwin({
    reference: referenceAudio(),
    candidate,
    iterationLabel: 'baseline',
    iteration: 0,
  });
}

/** Общий вход цикла (baseline считается тем же рендером, что и итерации). */
async function makeInput(respond, options = {}) {
  const render = options.render ?? rendererFromPlan();
  const metrics = await baselineFor(render);
  return {
    plan: planFixture(),
    metrics,
    measurements: MEASUREMENTS,
    stem_descriptors: STEM_DESCRIPTORS,
    options: {
      iterations: 3,
      respond,
      render,
      reference: referenceAudio(),
      ...(options.options ?? {}),
    },
  };
}

describe('разбор ответа модели', () => {
  it('читает список операций из объекта, из массива и из markdown-обёртки', () => {
    expect(parseModelOperations('{"operations":[{"op":"set_bpm","value":92}]}')).toEqual([{ op: 'set_bpm', value: 92 }]);
    expect(parseModelOperations('[{"op":"set_bpm","value":92}]')).toEqual([{ op: 'set_bpm', value: 92 }]);
    expect(parseModelOperations('```json\n{"operations":[]}\n```')).toEqual([]);
  });

  it('невалидный JSON — это ошибка, а не пустой список', () => {
    expect(() => parseModelOperations('это не JSON {{{')).toThrow(/невалидный JSON/);
    expect(() => parseModelOperations('{"текст":"без операций"}')).toThrow(/нет списка операций/);
  });
});

describe('цикл самоулучшения: план → правки → метрики', () => {
  it('1. плановые правки применяются и дают новую итерацию в журнале', async () => {
    const respond = async () => JSON.stringify({
      operations: [{ op: 'set_layer_gain', layer: 'drums', value: 0.7 }],
    });
    const result = await refineTwin(await makeInput(respond));

    expect(result.iterations.length).toBeGreaterThanOrEqual(2);
    const first = result.iterations[1];
    expect(first.iteration).toBe(1);
    expect(first.label).toBe('iteration-1');
    expect(first.status).toBe('ok');
    expect(first.changes.length).toBeGreaterThan(0);
    expect(first.changes.join(' ')).toMatch(/динамика|громкость/i);
    expect(first.metrics.overall).toBeGreaterThanOrEqual(0);
    expect(typeof first.delta.overall).toBe('number');
    // Правка действительно применена к плану.
    const gains = groupsOf(result.best.plan.parts.roles.kick).map((group) => group.gain);
    expect(gains.every((gain) => gain === 0.7)).toBe(true);
  });

  it('2. BPM вне измеренного — операция отклонена, темп плана не меняется', async () => {
    const respond = async () => JSON.stringify({
      operations: [
        { op: 'set_bpm', value: 140 },
        { op: 'set_layer_gain', layer: 'drums', value: 0.7 },
      ],
    });
    const result = await refineTwin(await makeInput(respond));

    const first = result.iterations[1];
    expect(first.status).toBe('ok');
    const rejected = first.rejected.find((item) => item.op?.op === 'set_bpm');
    expect(rejected).toBeTruthy();
    expect(rejected.reason).toMatch(/BPM/);
    expect(rejected.reason).toMatch(/92/);
    // Темп плана остался измеренным.
    expect(result.best.plan.meta.bpm).toBe(92);
    expect(first.changes.join(' ')).not.toMatch(/темп:/);
    // Отклонение попало в журнал.
    expect(result.log.join('\n')).toMatch(/отклонено .*set_bpm/);
  });

  it('BPM в пределах измеренного — операция проходит проверку диапазона', async () => {
    const respond = async () => JSON.stringify({
      operations: [{ op: 'set_bpm', value: 93.5 }],
    });
    const result = await refineTwin(await makeInput(respond));

    const first = result.iterations[1];
    expect(first.status).toBe('ok');
    // Проверка диапазона операцию пропустила: 93.5 внутри измеренного темпа.
    expect(first.rejected).toEqual([]);
    expect(first.changes.join(' ')).toMatch(/темп/);
    // Но честная метрика грува видит, что огибающие двойника на 93.5 BPM
    // разошлись с оригиналом на 92 BPM (корреляция 1.0 → 0.53), поэтому
    // общая оценка упала — и цикл вернул план к лучшему. Раньше слой грува
    // был постоянной 0.5, расхождение не было видно, и цикл принимал
    // ухудшающую правку.
    expect(result.best.plan.meta.bpm).toBe(92);
    expect(result.log.join('\n')).toMatch(/оценка хуже лучшей/);
  });

  it('правка, улучшающая сходство, применяется', async () => {
    const respond = async () => JSON.stringify({
      operations: [{ op: 'set_bpm', value: 93.5 }],
    });
    // Оригинал — на 93.5 BPM: тогда смена темпа улучшает сходство,
    // и цикл её принимает.
    const barSec = 240 / 93.5;
    const signal = clicks([0, (8 * barSec) / 16]);
    const reference = {
      drums: { channels: signal, sampleRate: SAMPLE_RATE },
      mix: { channels: signal, sampleRate: SAMPLE_RATE },
    };
    const result = await refineTwin(await makeInput(respond, { options: { reference } }));

    expect(result.best.plan.meta.bpm).toBe(93.5);
    expect(result.best.code).toMatch(/setCpm\(93\.5\/4\)/);
    // Правка выиграла у baseline: оценка выросла, поэтому цикл её оставил.
    expect(result.best.overall).toBeGreaterThan(result.iterations[0].metrics.overall);
  });

  it('3. невалидный JSON не роняет цикл: итерация неудачна, следующая выполняется', async () => {
    let call = 0;
    const respond = async () => {
      call += 1;
      if (call === 1) return 'простите, вот мои мысли: JSON не получился';
      return JSON.stringify({ operations: [{ op: 'set_layer_gain', layer: 'bass', value: 0.8 }] });
    };
    const result = await refineTwin(await makeInput(respond));

    expect(result.iterations[1].status).toBe('failed');
    expect(result.iterations[1].error).toMatch(/невалидный JSON/);
    expect(result.iterations[1].metrics).toBeNull();
    expect(result.iterations[2].status).toBe('ok');
    expect(result.iterations[2].iteration).toBe(2);
    expect(result.iterations[2].changes.length).toBeGreaterThan(0);
  });

  it('4. стоп по плато: оценка не растёт — цикл останавливается раньше K', async () => {
    const respond = async () => JSON.stringify({
      operations: [{ op: 'set_layer_gain', layer: 'drums', value: 0.7 }],
    });
    // Рендер всегда возвращает одно и то же звучание — улучшать нечем.
    const flat = async () => {
      const signal = clicks([0, 1.3]);
      return {
        drums: { channels: signal, sampleRate: SAMPLE_RATE },
        mix: { channels: signal, sampleRate: SAMPLE_RATE },
      };
    };
    const result = await refineTwin(await makeInput(respond, { render: flat }));

    expect(result.iterations.length).toBeLessThan(4); // baseline + меньше K итераций
    expect(result.stopReason).toMatch(/плато/);
    expect(result.stopReasonCode).toBe('plateau');
    expect(result.log.join('\n')).toMatch(/плато/);
    expect(result.iterations[1].delta.overall).toBeLessThan(0.01);
  });

  it('5. baseline присутствует в журнале и не меняется после итераций', async () => {
    const respond = async () => JSON.stringify({
      operations: [{ op: 'set_layer_gain', layer: 'drums', value: 0.7 }],
    });
    const input = await makeInput(respond);
    const snapshot = JSON.stringify(input.metrics);
    const result = await refineTwin(input);

    const baseline = result.iterations[0];
    expect(baseline.iteration).toBe(0);
    expect(baseline.label).toBe('baseline');
    expect(baseline.metrics.overall).toBe(input.metrics.overall);
    expect(baseline.metrics.layers).toEqual(input.metrics.layers);
    expect(baseline.delta.overall).toBe(0);
    expect(baseline.changes).toEqual([]);
    // Входные метрики не мутировались.
    expect(JSON.stringify(input.metrics)).toBe(snapshot);
  });
});

describe('запрет «модель не добавляет числа»', () => {
  it('операция вне белого списка отклоняется с причиной', async () => {
    const respond = async () => JSON.stringify({
      operations: [{ op: 'write_code', value: '$KICK: s("bd")' }],
    });
    const result = await refineTwin(await makeInput(respond));

    const first = result.iterations[1];
    expect(first.status).toBe('failed');
    expect(first.rejected[0].reason).toMatch(/белый список/);
    expect(first.changes).toEqual([]);
  });

  it('нота не из измеренных — паттерн не принимается', async () => {
    const respond = async () => JSON.stringify({
      operations: [{ op: 'set_note_pattern', layer: 'bass', value: 'e5 ~ e5 ~' }],
    });
    const result = await refineTwin(await makeInput(respond));

    const first = result.iterations[1];
    expect(first.status).toBe('failed');
    expect(first.rejected[0].reason).toMatch(/не измерена/);
    expect(result.best.plan.parts.roles.bass.pattern).toBe('c4 ~ c4 ~');
  });

  it('модель получает только JSON измерений и метрик — без путей и аудио', async () => {
    let payload = null;
    const respond = async (args) => {
      payload = args.payload;
      return JSON.stringify({ operations: [] });
    };
    await refineTwin(await makeInput(respond));

    expect(payload).toBeTruthy();
    expect(payload.measurements.tempo.bpm).toBe(92);
    expect(payload.metrics.baseline.overall).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(payload.allowed_operations)).toBe(true);
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/wav|\.mp3|audio/i);
    expect(text).not.toMatch(/temp_dir|file_name/);
  });
});
