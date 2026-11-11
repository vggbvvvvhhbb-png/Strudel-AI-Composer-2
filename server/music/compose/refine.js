// Refine v2: в структурном режиме правится СПЕКА, а не код.
//
// Почему так: код, собранный компилятором, валиден по построению —
// переписывать его текстом значит снова получать «сломанный» результат
// и снова проверять. Спека же проверяется Zod и checkSpec, а после
// правки компилируется заново — код остаётся корректным.
//
// Цикл: замечание → правка спеки → компиляция → оценка → повтор.
// Стоп: три итерации или прирост меньше двух баллов.

import { compile } from '../compiler/index.js';
import { checkSpec } from '../spec/check.js';
import { collectRemarks, applyRemark } from './remarks.js';

/**
 * Оценка спеки: компилируем и измеряем.
 *
 * Функция оценки передаётся снаружи, потому что источник истины для
 * метрик различается (v1 — свой парсер, v2 — события Strudel), а
 * refine-циклу важен только результат: число баллов и замечания.
 *
 * Оценка асинхронна: метрики v2 считаются по исполнению Strudel,
 * а это асинхронная операция.
 *
 * @param {object} spec
 * @param {Function} scoreFn async (code) => {total:number, issues:Array}
 * @returns {Promise<{code:string, compiled:object, score:object}>}
 */
export async function evaluateSpec(spec, scoreFn) {
  const compiled = compile(spec);
  const score = await scoreFn(compiled.code);
  return { code: compiled.code, compiled, score };
}

/**
 * Один шаг улучшения: собрать замечания и применить одно.
 *
 * Применяется первое замечание — те, что с наибольшим эффектом, идут
 * раньше. Если замечание не изменило спеку (правка невозможна) —
 * берётся следующее.
 *
 * @param {object} spec
 * @param {object[]} remarks
 * @returns {{spec:object|null, remark:object|null}}
 */
export function refineOnce(spec, remarks) {
  for (const remark of remarks) {
    const next = applyRemark(spec, remark);
    if (JSON.stringify(next) === JSON.stringify(spec)) continue; // правка ничего не дала
    const check = checkSpec(next);
    if (!check.ok) continue; // правка сломала валидность — берём следующую
    return { spec: check.spec, remark };
  }
  return { spec: null, remark: null };
}

/**
 * Полный цикл улучшения спеки.
 *
 * @param {object} options
 * @param {object} options.spec исходная спека
 * @param {Function} options.scoreFn (code) => {total, issues}
 * @param {number} [options.maxIterations] максимум итераций (по умолчанию 3)
 * @param {number} [options.minGain] минимальный прирост баллов для продолжения
 * @param {Function} [options.onEvent] колбэк события
 * @returns {Promise<{spec:object, code:string, before:object, after:object, steps:Array}>}
 */
export async function refineSpec({
  spec,
  scoreFn,
  maxIterations = 3,
  minGain = 2,
  onEvent,
}) {
  const emit = (event, payload) => {
    if (typeof onEvent === 'function') onEvent(event, payload);
  };

  let current = spec;
  let currentEval = await evaluateSpec(current, scoreFn);
  const before = currentEval.score;
  const steps = [];

  for (let i = 0; i < maxIterations; i += 1) {
    const remarks = collectRemarks(current);
    if (!remarks.length) {
      steps.push({ iteration: i + 1, applied: false, reason: 'Замечаний нет', score: before.total });
      break;
    }

    const { spec: nextSpec, remark } = refineOnce(current, remarks);
    if (!nextSpec) {
      steps.push({
        iteration: i + 1,
        applied: false,
        reason: 'Ни одно замечание нельзя применить, не сломав спеку',
        score: currentEval.score.total,
      });
      break;
    }

    const nextEval = await evaluateSpec(nextSpec, scoreFn);
    const gained = nextEval.score.total - currentEval.score.total;

    emit('refine-step', {
      iteration: i + 1,
      remark: { id: remark.id, label: remark.label, hint: remark.hint },
      score: nextEval.score.total,
      gain: Math.round(gained * 10) / 10,
    });

    if (gained < minGain) {
      steps.push({
        iteration: i + 1,
        applied: false,
        reason: `Прирост ${gained.toFixed(1)} < ${minGain} — останавливаюсь`,
        score: currentEval.score.total,
        remark: { id: remark.id, label: remark.label, hint: remark.hint },
      });
      break;
    }

    steps.push({
      iteration: i + 1,
      applied: true,
      score: nextEval.score.total,
      gain: Math.round(gained * 10) / 10,
      remark: { id: remark.id, label: remark.label, hint: remark.hint },
    });

    current = nextSpec;
    currentEval = nextEval;
  }

  const after = currentEval.score;
  return {
    spec: current,
    code: currentEval.code,
    compiled: currentEval.compiled,
    before,
    after,
    steps,
    improved: after.total > before.total,
  };
}
