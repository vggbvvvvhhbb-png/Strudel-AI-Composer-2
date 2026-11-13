// Аудио-блок скора: оценка рендера по объективным метрикам.
//
// Вес 20% (§7 промта, фаза 3): общий скор = v1·0.5 + v2·0.3 + аудио·0.2.
// Блок переключаемый — без отчёта о рендере он просто не участвует.
//
// Критерии (веса внутри блока):
//   повторяемость рендера   25
//   отсутствие клиппинга     20
//   true peak в потолке      20
//   LUFS в коридоре          25
//   тишина                   10
//
// Критерий даёт 0 при нарушении и полный балл при выполнении — так вес
// блока честно отражает, насколько рендер готов к публикации.

import { ACCEPTANCE } from '../../../src/audio/metrics-report.js';
import { runAudioQa, QA_CODES, SEVERITY } from '../../../src/audio/qa.js';

export const AUDIO_SCORE_WEIGHT = 0.2;

const WEIGHTS = {
  repeatability: 25,
  clipping: 20,
  truePeak: 20,
  lufs: 25,
  silence: 10,
};

/**
 * Оценивает отчёт рендера.
 *
 * @param {object} report MetricsReport
 * @param {object} [options]
 * @param {object} [options.acceptance]
 * @returns {{total:number, issues:Array<{id:string,label:string,hint:string,severity:string}>}}
 */
export function scoreAudioReport(report, { acceptance = ACCEPTANCE } = {}) {
  if (!report) return { total: 0, issues: [] };

  const findings = runAudioQa(report, { acceptance });
  const has = (code) => findings.some((f) => f.code === code);

  const checks = {
    // Повторяемость засчитывается только при измеренном факте: один рендер
    // ничего не доказывает, поэтому «неизвестно» = «не выполнено».
    repeatability: report.repeatability?.passed === true,
    clipping: !has(QA_CODES.CLIPPING),
    truePeak: !has(QA_CODES.TRUE_PEAK_OVER),
    lufs: !has(QA_CODES.LUFS_ABOVE_CORRIDOR) && !has(QA_CODES.LUFS_BELOW_CORRIDOR),
    silence:
      !has(QA_CODES.SILENCE_HEAD) && !has(QA_CODES.SILENCE_TAIL) && !has(QA_CODES.SILENCE_INTERNAL),
  };

  let total = 0;
  for (const [name, passed] of Object.entries(checks)) total += passed ? WEIGHTS[name] : 0;

  const issues = findings
    .filter((f) => f.severity === SEVERITY.ERROR || f.severity === SEVERITY.WARNING)
    .map((f) => ({
      id: `audio:${f.code}`,
      code: f.code,
      label: f.label,
      hint: f.hint,
      severity: f.severity,
    }));

  return { total: Math.round(total * 10) / 10, issues, checks };
}

/**
 * Смешивает скоры с учётом веса аудио-блока.
 *
 * @param {number} v1 скор разбора кода
 * @param {number|null} v2 скор по событиям Strudel
 * @param {number|null} audio скор по рендеру
 * @returns {number}
 */
export function combineScores(v1, v2, audio) {
  if (audio === null || audio === undefined) {
    // Аудио-блока нет: веса перераспределяются между остальными.
    return v2 === null || v2 === undefined
      ? v1
      : Math.round((v1 * 0.6 + v2 * 0.4) * 10) / 10;
  }
  const rest = 1 - AUDIO_SCORE_WEIGHT;
  const base = v2 === null || v2 === undefined ? v1 : v1 * 0.6 + v2 * 0.4;
  return Math.round((base * rest + audio * AUDIO_SCORE_WEIGHT) * 10) / 10;
}
