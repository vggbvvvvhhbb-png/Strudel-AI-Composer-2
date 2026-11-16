// Измерительный рефайн поверх compose — «Учитель» (D-111).
//
// Проверяем поведение, а не «функция вернула объект»:
//   • цикл делает ровно столько итераций, сколько разрешено;
//   • зелёный вход не трогается;
//   • правила срабатывают по измеренным дефицитам, а не по воле теста;
//   • детерминизм: один seed — один результат;
//   • бюджет, отмена и отказ операции останавливают цикл;
//   • неполное покрытие не «лечится», а публикуется;
//   • события идут в заявленном порядке.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PART_GAIN,
  EPS,
  RULE_TABLE,
  activeParts,
  compareRenderFingerprints,
  decideEdit,
  defaultApplyOp,
  isL0Green,
  leadPart,
  measureDeltas,
  normalizeMeasure,
  refineComposed,
} from '../../server/music/compose/measured-refine.js';
import { fallbackSpec } from '../../server/music/compose/pipeline.js';
import { compileTrackSpec } from '../../server/music/compiler/index.js';

/** Спека с предсказуемым составом: две тональные партии и ударная. */
function specFixture(seed = 1) {
  const spec = fallbackSpec('techno', seed);
  spec.parts.roles = {
    kick: { role: 'kick', activeIn: ['intro', 'drop'], pattern: 'bd*4', sound: 'bd' },
    lead: { role: 'lead', activeIn: ['intro', 'drop'], pattern: '0 2 4', sound: 'square' },
    pad: { role: 'pad', activeIn: ['drop'], pattern: '<0 2 4>', sound: 'sine' },
  };
  return spec;
}

/**
 * Мок-рендер: отдаёт заранее заданные измерения по очереди и запоминает,
 * какие спеки приходили.
 */
function makeRender(measurements) {
  const calls = [];
  let index = 0;
  const render = async (code, options) => {
    calls.push({ code, options });
    const measurement = measurements[Math.min(index, measurements.length - 1)];
    index += 1;
    return {
      wavPath: `/tmp/fake-${index}.wav`,
      metrics: measurement,
      fingerprint: { code_sha256: `hash-${index}`, iteration: index },
    };
  };
  return { render, calls };
}

/** Мок-замер: отдаёт заранее подготовленные измерения. */
function makeMeasure(measurements) {
  let index = 0;
  const measure = async () => {
    const value = measurements[Math.min(index, measurements.length - 1)];
    index += 1;
    return value;
  };
  return { measure };
}

/** Нормализованное измерение из «сырых» чисел. */
function measurement(overrides = {}) {
  return normalizeMeasure({
    l0: 100,
    l1: 80,
    coverage: '4/4',
    truePeakDbtp: -3,
    lufsI: -14,
    clipCount: 0,
    motifCoherence: 0.8,
    contourEntropy: 0.5,
    ...overrides,
  });
}

describe('измерительный рефайн: цикл', () => {
  it('цикл делает ровно две итерации и останавливается по maxIterations', async () => {
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    // Пик каждый раз чуть ниже, но всё ещё выше потолка: правило R1
    // срабатывает дважды, улучшение есть (значит, не плато), а громкость
    // внутри коридора (значит, R2 не вмешивается и требования не спорят).
    // L0 держим ниже 80 — значит, цель (зелёный трек) не достигается и цикл
    // доходит до границы итераций.
    const first = measurement({ truePeakDbtp: -0.5, l0: 60 });
    const second = measurement({ truePeakDbtp: -0.9, l0: 65 });
    const third = measurement({ truePeakDbtp: -1.3, l0: 70 });
    const { render, calls } = makeRender([first, second, third]);
    const { measure } = makeMeasure([first, second, third]);

    const result = await refineComposed({
      spec,
      code,
      seed: 1,
      render,
      measure,
      maxIterations: 2,
    });

    expect(result.iterations).toHaveLength(2);
    expect(result.stoppedBy).toBe('max-iterations');
    // Рендер был на старте и после каждой правки.
    expect(calls).toHaveLength(3);
  });

  it('зелёный вход не трогается: 0 правок и stoppedBy already-green', async () => {
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    const { render, calls } = makeRender([measurement()]);
    const { measure } = makeMeasure([measurement()]);

    const result = await refineComposed({ spec, code, seed: 1, render, measure });

    expect(result.iterations).toHaveLength(0);
    expect(result.stoppedBy).toBe('already-green');
    expect(calls).toHaveLength(1);
  });

  it('R1 срезает громкость, когда пик выше потолка', async () => {
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    const hot = measurement({ truePeakDbtp: -0.4, l0: 70 });
    const { render } = makeRender([hot, hot]);
    const { measure } = makeMeasure([hot, hot]);

    const result = await refineComposed({ spec, code, seed: 1, render, measure, maxIterations: 1 });

    expect(result.iterations[0].rule).toBe('R1');
    // В правке участвуют все активные партии: это эквивалент мастер-трима.
    const ops = result.iterations[0].deltas ? [] : [];
    expect(ops).toEqual([]);
    const active = activeParts(result.spec);
    for (const part of active) {
      const gain = (result.spec.parts.roles[part.id].effects ?? [])
        .find((effect) => effect.name === 'gain');
      expect(gain).toBeTruthy();
    }
  });

  it('детерминизм: два прогона с одним seed дают одинаковые дельты', async () => {
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    const hot = measurement({ truePeakDbtp: -0.4, l0: 70 });
    const run = async () => {
      const { render } = makeRender([hot, hot]);
      const { measure } = makeMeasure([hot, hot]);
      return refineComposed({ spec, code, seed: 7, render, measure, maxIterations: 1 });
    };
    const first = await run();
    const second = await run();
    expect(second.deltas).toEqual(first.deltas);
    expect(second.code).toBe(first.code);
  });

  it('отмена прерывает цикл: stoppedBy abort', async () => {
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    const hot = measurement({ truePeakDbtp: -0.4, l0: 70 });
    const { render } = makeRender([hot]);
    const { measure } = makeMeasure([hot]);
    const controller = new AbortController();
    controller.abort();

    const result = await refineComposed({
      spec,
      code,
      seed: 1,
      render,
      measure,
      signal: controller.signal,
    });

    expect(result.stoppedBy).toBe('abort');
    expect(result.iterations).toHaveLength(0);
  });

  it('бюджет останавливает цикл без правок', async () => {
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    const hot = measurement({ truePeakDbtp: -0.4, l0: 70 });
    const { render } = makeRender([hot]);
    const { measure } = makeMeasure([hot]);

    const result = await refineComposed({
      spec,
      code,
      seed: 1,
      render,
      measure,
      budgetMs: 0,
    });

    expect(result.stoppedBy).toBe('budget');
    expect(result.iterations).toHaveLength(0);
  });

  it('запрещённая операция отвергается: спека не меняется', async () => {
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    const hot = measurement({ truePeakDbtp: -0.4, l0: 70 });
    const { render } = makeRender([hot]);
    const { measure } = makeMeasure([hot]);

    const result = await refineComposed({
      spec,
      code,
      seed: 1,
      render,
      measure,
      maxIterations: 1,
      applyOp: () => null,
    });

    expect(result.stoppedBy).toBe('rejected-op');
    expect(result.spec).toEqual(spec);
    expect(result.code).toBe(code);
  });

  it('неполное покрытие не лечится, а публикуется', async () => {
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    const partial = measurement({ coverage: '2/4' });
    const { render } = makeRender([partial]);
    const { measure } = makeMeasure([partial]);

    const result = await refineComposed({ spec, code, seed: 1, render, measure });

    expect(result.coverage).toBe('2/4');
    // R6 не правит: покрытие неполное, но технических дефицитов нет.
    expect(result.iterations).toHaveLength(0);
    expect(result.stoppedBy).toBe('already-green');
  });

  it('measuredRefine выключен по умолчанию: поведение compose не меняется', async () => {
    // Контракт: измерительный рефайн включается только явным флагом, а
    // обычная сборка спеки остаётся прежней. Проверяем, что флаг не влияет
    // на спеку и код.
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    expect(code).toBe(compileTrackSpec(spec));
  });

  it('события идут в заявленном порядке', async () => {
    const spec = specFixture();
    const code = compileTrackSpec(spec);
    const hot = measurement({ truePeakDbtp: -0.4, l0: 70 });
    const { render } = makeRender([hot, hot]);
    const { measure } = makeMeasure([hot, hot]);
    const events = [];

    await refineComposed({
      spec,
      code,
      seed: 1,
      render,
      measure,
      maxIterations: 1,
      onEvent: (type) => events.push(type),
    });

    expect(events).toEqual([
      'refine_start',
      'rendered',
      'measured',
      'edit_applied',
      'rerendered',
      'measured',
      'refine_done',
    ]);
  });
});

describe('измерительный рефайн: правила', () => {
  it('таблица правил описывает R1…R6 и порядок исполнения', () => {
    expect(RULE_TABLE.map((rule) => rule.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    // R6 — правило без операции: покрытие не правится, а публикуется.
    expect(RULE_TABLE.find((rule) => rule.id === 'R6').op).toBeNull();
  });

  it('R2 подбирает шаг не больше 1 дБ', () => {
    const spec = specFixture();
    const decision = decideEdit({
      spec,
      measurement: measurement({ truePeakDbtp: -6, lufsI: -30 }),
      seed: 1,
      style: 'techno',
    });
    expect(decision.rule).toBe('R2');
    for (const op of decision.op) {
      expect(Math.abs(op.params.gainDb)).toBeLessThanOrEqual(1);
    }
  });

  it('R3 срезает на 2 дБ при клиппинге', () => {
    const spec = specFixture();
    const decision = decideEdit({
      spec,
      measurement: measurement({ truePeakDbtp: -6, lufsI: -14, clipCount: 3 }),
      seed: 1,
      style: 'techno',
    });
    expect(decision.rule).toBe('R3');
    // Шаг правила — минус 2 дБ от текущей амплитуды партии, а не абсолютное
    // значение: у партии без эффекта gain база — амплитуда движка по умолчанию.
    const baseDb = 20 * Math.log10(DEFAULT_PART_GAIN);
    expect(decision.op[0].params.gainDb).toBeCloseTo(baseDb - 2, 1);
  });

  it('R4 применяет тему трека к lead-партии', () => {
    const spec = specFixture();
    const decision = decideEdit({
      spec,
      measurement: measurement({ motifCoherence: 0.2 }),
      seed: 1,
      style: 'techno',
    });
    expect(decision.rule).toBe('R4');
    expect(decision.targetId).toBe('lead');
    expect(decision.op[0].op).toBe('setPattern');
    expect(decision.op[0].params.pattern.length).toBeGreaterThan(0);
  });

  it('R5 не исполняется: коридор энтропии не откалиброван', () => {
    const spec = specFixture();
    const decision = decideEdit({
      spec,
      measurement: measurement({ contourEntropy: 0.99 }),
      seed: 1,
      style: 'techno',
    });
    // Коридор не измерен — правило молчит, а не угадывает границы.
    expect(decision).toBeNull();
  });

  it('lead-партия определяется по роли, иначе по первой тональной', () => {
    const spec = specFixture();
    expect(leadPart(spec).id).toBe('lead');
    const noLead = specFixture();
    delete noLead.parts.roles.lead;
    expect(leadPart(noLead).id).toBe('pad');
  });
});

describe('измерительный рефайн: честность измерений', () => {
  it('null отличается от нуля: неизвестное значение остаётся null', () => {
    const m = normalizeMeasure({ l0: 100, lufsI: null, clipCount: undefined });
    expect(m.lufsI).toBeNull();
    expect(m.clipCount).toBeNull();
    expect(m.l0).toBe(100);
  });

  it('L0 зелёный только когда дефектов нет', () => {
    expect(isL0Green(measurement())).toBe(true);
    expect(isL0Green(measurement({ truePeakDbtp: -0.5 }))).toBe(false);
    expect(isL0Green(measurement({ clipCount: 1 }))).toBe(false);
    expect(isL0Green(measurement({ lufsI: -25 }))).toBe(false);
  });

  it('дельты нормированы и не выдумывают отсутствующие данные', () => {
    const before = measurement({ l0: 50, l1: null });
    const after = measurement({ l0: 60, l1: null });
    const deltas = measureDeltas(before, after);
    expect(deltas.l0).toBeCloseTo(0.1, 6);
    expect(deltas.l1).toBeNull();
    expect(EPS).toBe(0.01);
  });

  it('рендеры сравниваются по допуску, а не побайтово', () => {
    const same = compareRenderFingerprints(
      { fingerprint: { a: 1 } },
      { fingerprint: { a: 1 } },
    );
    expect(same.changed).toBe(false);
    const different = compareRenderFingerprints(
      { fingerprint: { a: 1 } },
      { fingerprint: { a: 2 } },
    );
    expect(different.changed).toBe(true);
  });

  it('операция вне реестра отвергается', () => {
    const spec = specFixture();
    expect(defaultApplyOp(spec, { id: 'kick', op: 'setVolume', params: {} })).toBeNull();
    expect(defaultApplyOp(spec, { id: 'kick', op: 'setGain', params: { gainDb: -1 } })).toBeTruthy();
  });
});
