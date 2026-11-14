// Критик-цикл: замечания линтера → типизированные правки IR → новый скор.
//
// Правило принятия (бриф §3.4): правка принимается, только если скор ВЫРОС и
// ни один гейт не ухудшился. Иначе — откат. Итераций не больше трёх.
//
// Цикл детерминирован: набор кандидатов на каждом шаге задаётся порядком
// замечаний, порядок замечаний — стабильная сортировка по коду.
//
// Важно: правит без отката — это ловушка. Каждая правка проверяется на
// КОПИИ, исходный IR не меняется, пока не доказано, что стало лучше.

import { cloneIR } from '../ir/schema.js';
import { applyTransform } from '../ir/transforms.js';
import { symbolicReport } from './report.js';

/** Порядок замечаний: сначала ошибки, потом предупреждения, потом инфо. */
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

/**
 * Прогоняет критик-цикл.
 *
 * @param {object} ir исходный IR (не мутируется)
 * @param {object} [options]
 * @param {number} [options.iterations] максимум итераций (по умолчанию 3)
 * @param {(ir:object)=>object} [options.analyze] функция оценки
 * @returns {{ir:object, report:object, steps:Array, accepted:boolean, improved:number}}
 */
export function critique(ir, options = {}) {
  const maxIterations = Math.max(1, Math.min(3, options.iterations ?? 3));
  const analyze = options.analyze || symbolicReport;

  let current = cloneIR(ir);
  let report = analyze(current);
  const startScore = report.score.total;
  const steps = [];
  let accepted = false;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const findings = [...report.lint].sort((a, b) => {
      const severity = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
      if (severity !== 0) return severity;
      return a.code.localeCompare(b.code);
    });

    let improvedThisRound = false;
    for (const finding of findings) {
      for (const transform of finding.suggestedTransforms || []) {
        let candidate = null;
        try {
          candidate = applyTransform(current, transform.transform, ...argsOf(transform));
        } catch {
          continue; // трансформация неприменима — берём следующую
        }
        let candidateReport = null;
        try {
          candidateReport = analyze(candidate);
        } catch {
          continue;
        }
        const better = candidateReport.score.total > report.score.total;
        const notWorse = candidateReport.lintSummary.errors <= report.lintSummary.errors;
        if (better && notWorse) {
          steps.push({
            iteration,
            code: finding.code,
            transform: transform.transform,
            args: argsOf(transform),
            scoreBefore: report.score.total,
            scoreAfter: candidateReport.score.total,
            accepted: true,
          });
          current = candidate;
          report = candidateReport;
          improvedThisRound = true;
          accepted = true;
          break;
        }
        steps.push({
          iteration,
          code: finding.code,
          transform: transform.transform,
          args: argsOf(transform),
          scoreBefore: report.score.total,
          scoreAfter: candidateReport.score.total,
          accepted: false,
          reason: !better ? 'скор не вырос' : 'появились новые ошибки',
        });
      }
      if (improvedThisRound) break; // одна правка за итерацию — иначе скачки
    }
    if (!improvedThisRound) break;
  }

  return {
    ir: current,
    report,
    steps,
    accepted,
    improved: Math.round((report.score.total - startScore) * 100) / 100,
    startScore,
  };
}

/** Аргументы трансформации из объекта предложения. */
function argsOf(transform) {
  const args = [];
  if (transform.role !== undefined) args.push(transform.role);
  if (transform.amount !== undefined) args.push(transform.amount);
  if (transform.steps !== undefined) args.push(transform.steps);
  if (transform.factor !== undefined) args.push(transform.factor);
  if (transform.mode !== undefined) args.push(transform.mode);
  if (transform.sectionId !== undefined) args.push(transform.sectionId);
  if (transform.delta !== undefined) args.push(transform.delta);
  if (transform.index !== undefined) args.push(transform.index);
  if (transform.rn !== undefined) args.push(transform.rn);
  if (transform.color !== undefined) args.push(transform.color);
  if (transform.rhythm !== undefined) args.push(transform.rhythm);
  if (transform.template !== undefined) args.push(transform.template);
  if (transform.options !== undefined) args.push(transform.options);
  if (transform.bars !== undefined) args.push(transform.bars);
  return args;
}
