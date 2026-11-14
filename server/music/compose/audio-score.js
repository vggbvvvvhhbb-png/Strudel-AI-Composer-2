// Аудио-блок скора: оценка рендера по объективным метрикам.
//
// Вес блока (20%) и веса критериев внутри блока берутся из реестра метрик
// (src/metrics/registry.js) — раньше они были литералами здесь и в
// соседних модулях, и никто не мог сказать, какие из них проверены
// человеческими парами. У всех стоит validated: false (бриф §2.8).
//
// Критерий даёт 0 при нарушении и полный балл при выполнении — так вес
// блока честно отражает, насколько рендер готов к публикации.

import { ACCEPTANCE } from '../../../src/audio/metrics-report.js';
import { runAudioQa, QA_CODES, SEVERITY } from '../../../src/audio/qa.js';
import { AUDIO_SCORE_CRITERIA, SCORE_COMBINE } from '../../../src/metrics/registry.js';

/** Вес аудио-блока в общем скоре. */
export const AUDIO_SCORE_WEIGHT = SCORE_COMBINE.audio.weight;

/** Веса критериев внутри блока: {repeatability: 25, clipping: 20, …}. */
const WEIGHTS = Object.fromEntries(
  AUDIO_SCORE_CRITERIA.map((criterion) => [criterion.check, criterion.weight]),
);

/** Веса текстовых блоков: v1 (разбор кода) и v2 (музыкальный анализ). */
const W_V1 = SCORE_COMBINE.v1.weight;
const W_V2 = SCORE_COMBINE.v2.weight;

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
 * Формула: (v1·W_V1 + v2·W_V2)·(1 − W_audio) + аудио·W_audio.
 * Если v2 нет — его вес переходит к v1 (иначе сумма «съедает» часть
 * общего скора). Если аудио-блока нет — остаются только текстовые.
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
      : Math.round((v1 * W_V1 + v2 * W_V2) * 10) / 10;
  }
  const rest = 1 - AUDIO_SCORE_WEIGHT;
  const base = v2 === null || v2 === undefined
    ? v1
    : v1 * W_V1 + v2 * W_V2;
  return Math.round((base * rest + audio * AUDIO_SCORE_WEIGHT) * 10) / 10;
}
