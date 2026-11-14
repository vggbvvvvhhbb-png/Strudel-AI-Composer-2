// Символьный скор: сводка метрик в число 0…100.
//
// ВАЖНО (анти-цель брифа §2.8): этот скор — ГИПОТЕЗА о том, как звучит
// трек. До проверки человеческими парами (H3) он не имеет права быть
// целью оптимизации. Поэтому:
//   • скор честно показывает составляющие — видно, что именно не попало
//     в цель;
//   • веса помечены как непроверенные;
//   • канарейки (см. canaries.js) обязаны получать скор НИЖЕ медианы
//     нормального корпуса — иначе скор взламывается и эволюция стопорится.
//
// Скор НЕ заменяет аудио-скор: он отвечает на вопрос «структура трека
// осмысленна?», а не «красиво ли это?».

import { thresholdsFor } from './lint.js';

/** Веса составляющих. Сумма = 100. Статус: не проверено на людях (H3). */
export const SCORE_COMPONENTS = [
  {
    id: 'form',
    label: 'Форма',
    weight: 20,
    describe: 'секций ≥ 3, соседние секции контрастны',
  },
  {
    id: 'energy',
    label: 'Энергия',
    weight: 20,
    describe: 'профиль энергии совпадает с целевой кривой арки',
  },
  {
    id: 'motif',
    label: 'Мотив и фраза',
    weight: 15,
    describe: 'мотив возвращается и варьируется, фразы закрываются',
  },
  {
    id: 'groove',
    label: 'Грув',
    weight: 15,
    describe: 'бас с киком в lock, микротайминг живой',
  },
  {
    id: 'tonality',
    label: 'Тональность',
    weight: 10,
    describe: 'ноты внутри лада',
  },
  {
    id: 'density',
    label: 'Плотность',
    weight: 10,
    describe: 'плотность в рабочем диапазоне',
  },
  {
    id: 'variation',
    label: 'Разнообразие',
    weight: 10,
    describe: 'такты не копируют друг друга',
  },
];

/**
 * Считает символьный скор по отчёту.
 * @param {object} report отчёт `symbolicReport`
 * @returns {{total:number, grade:string, components:Array, penalty:number}}
 */
export function symbolicScore(report) {
  const m = report.metrics;
  const values = {
    form: formScore(m, report),
    energy: energyScore(m),
    motif: motifScore(m),
    groove: grooveScore(m, report),
    tonality: tonalityScore(m),
    density: densityScore(m, report),
    variation: variationScore(m),
  };

  const components = SCORE_COMPONENTS.map((component) => {
    const value = values[component.id];
    const score = Math.max(0, Math.min(1, value));
    return {
      id: component.id,
      label: component.label,
      weight: component.weight,
      describe: component.describe,
      value: round(value, 3),
      score: round(score, 3),
      points: round(score * component.weight, 2),
      status: score >= 0.8 ? 'ok' : score >= 0.55 ? 'near' : 'bad',
    };
  });

  // Штраф за ошибки линтера: сорванный трек не должен набирать очки.
  const errors = (report.lint || []).filter((finding) => finding.severity === 'error').length;
  const penalty = Math.min(30, errors * 10);

  const base = components.reduce((sum, component) => sum + component.points, 0);
  const total = Math.max(0, round(base - penalty, 2));

  return {
    total,
    grade: gradeOf(total),
    penalty,
    components,
    validated: false,
    note: 'Символьный скор — гипотеза; без человеческих пар (H3) целью оптимизации быть не может.',
  };
}

/** Форма: секции и контраст соседей. */
function formScore(m, report) {
  const sections = report.sections || [];
  const countScore = Math.min(1, sections.length / 3);
  const contrast = m.minContrast ?? 0;
  // Контраст 0.25 — порог North Star; 0.6 — «секции звучат по-разному».
  const contrastScore = Math.max(0, Math.min(1, (contrast - 0.1) / 0.5));
  return countScore * 0.4 + contrastScore * 0.6;
}

/** Энергия: корреляция с целевой кривой. */
function energyScore(m) {
  if (m.energyCorrelation === null) return 0.5;
  const r = m.energyCorrelation;
  if (r < 0) return 0;
  return Math.min(1, r / 0.9);
}

/** Мотив и фраза. */
function motifScore(m) {
  const hook = m.motifRecurrence?.hook ? 1 : 0;
  const recurrence = Math.min(1, (m.motifRecurrence?.count ?? 0) / 3);
  const closure = m.phraseClosure?.closureRatio;
  const closureScore = closure === null ? 0.4 : Math.min(1, closure / 0.85);
  return hook * 0.35 + recurrence * 0.25 + closureScore * 0.4;
}

/** Грув: связка с киком и живой микротайминг. */
function grooveScore(m, report) {
  const thresholds = thresholdsFor(report.genre);
  // Оффбитный бас в синтипопе — норма жанра: там связка с киком не нужна.
  const lockScore = thresholds.lock === null
    ? 0.8
    : Math.min(1, (m.bassKickLock ?? 0) / thresholds.lock);
  const std = m.microtiming?.stdMs ?? 0;
  // Слишком ровно (≈0 мс) — робот; 12…25 мс — живой микротайминг;
  // дальше начинается «разъехавшееся» (грязь).
  let timing = 0;
  if (std > 0.5 && std <= 25) timing = 1;
  else if (std <= 0.5) timing = 0.25;
  else timing = Math.max(0, 1 - (std - 25) / 20);
  return lockScore * 0.6 + timing * 0.4;
}

/** Тональность: доля нот в ладе. */
function tonalityScore(m) {
  if (m.scaleFit === null) return 0.5;
  if (m.scaleFit >= 0.98) return 1;
  if (m.scaleFit >= 0.9) return 0.6;
  return Math.max(0, (m.scaleFit - 0.6) / 0.3);
}

/** Плотность: попадание в жанровый диапазон событий/с. */
function densityScore(m, report) {
  const density = m.density ?? 0;
  const max = thresholdsFor(report.genre).maxDensity;
  if (density >= 1 && density <= max) {
    // Лучше — в середине диапазона.
    const mid = Math.min(density - 1, max - density);
    return 0.7 + 0.3 * Math.min(1, mid / (max / 3));
  }
  if (density <= 1) return Math.max(0, density) * 0.6;
  return Math.max(0, 1 - (density - max) / (max * 0.5)) * 0.6;
}

/** Разнообразие тактов. */
function variationScore(m) {
  const ratio = m.variation?.ratio ?? 0;
  return Math.min(1, ratio / 0.6);
}

function gradeOf(total) {
  if (total >= 85) return 'A';
  if (total >= 75) return 'B+';
  if (total >= 65) return 'B';
  if (total >= 55) return 'C+';
  if (total >= 45) return 'C';
  return 'D';
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
