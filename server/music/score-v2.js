// Скор v2: старые критерии (60 %) + новые метрики развития (40 %).
//
// Старый `scoreTrack` (server/music/score.js) НЕ ломается: он остаётся
// источником привычных критериев и замечаний. Здесь — второй слой, который
// оценивает то, чего старый слой не видел: развитие во времени.
//
// Правила:
//   • трек короче 16 тактов — новые критерии НЕ применяются, но выдаётся
//     замечание «нет формы»;
//   • каждое замечание говорит, что не так, и даёт конкретное действие;
//   • баллы прозрачны: видно, что именно не попало в цель.

import { analyzeTrackFromEvents } from './metrics/events.js';
import { scoreTrack, CRITERIA } from './score.js';
import { resolveProfile } from './references.js';
import {
  analyzeProgression,
  VARIATION_TARGETS,
  NOVELTY_LOW,
  NOVELTY_HIGH,
} from './metrics/progression.js';

/** Доля веса, которую занимают новые критерии. */
export const V2_WEIGHT = 0.4;

/** Минимальная длина трека, на которой форма имеет смысл. */
export const MIN_FORM_BARS = 16;

/**
 * Новые критерии: веса в сумме дают 40.
 */
export const V2_CRITERIA = [
  {
    id: 'progression',
    label: 'Прогрессия и форма',
    weight: 12,
    unit: 'баллов',
    describe: (p) => 'секции различаются, энергия и гармония меняются',
    value: (m) => formScore(m),
    quality: () => 1,
  },
  {
    id: 'harmonicMotion',
    label: 'Гармоническое движение',
    weight: 10,
    unit: 'смен на 4 такта',
    describe: () => 'гармония меняется, но не превращается в хаос',
    value: (m) => m.harmony?.changesPer4Bars ?? 0,
    quality: (m) => {
      // Слишком много смен — хаос; слишком мало — обои.
      const changes = m.harmony?.changesPer4Bars ?? 0;
      if (changes < 0.15) return 0.2;
      if (changes > 1.4) return 0.5;
      return 1;
    },
  },
  {
    id: 'partDiversity',
    label: 'Разнообразие партий',
    weight: 8,
    unit: 'партий',
    describe: () => 'партии играют разные рисунки и в разных регистрах',
    value: (m) => m.diversity?.parts ?? 0,
    quality: (m) => {
      const jaccard = m.diversity?.meanJaccard ?? 1;
      // Партии, играющие одно и то же, — это не разнообразие.
      const separation = Math.max(0, Math.min(1, (1 - jaccard) / 0.7));
      const roles = Math.min(1, (m.diversity?.roles ?? 0) / 3);
      return 0.4 + 0.3 * separation + 0.3 * roles;
    },
  },
  {
    id: 'variability',
    label: 'Вариативность',
    weight: 5,
    unit: 'доля',
    describe: () => 'рисунок партии меняется от такта к такту',
    value: (m) => meanVariation(m),
    quality: (m) => {
      // Бас, повторяющийся полтрека, — прямой признак статичности.
      if (m.variability?.bassIdentical) return 0.4;
      return 1;
    },
  },
  {
    id: 'automation',
    label: 'Автоматизация',
    weight: 5,
    unit: 'доля',
    describe: () => 'параметры меняются во времени, а не стоят константой',
    value: (m) => m.automation?.ratio ?? 0,
    quality: () => 1,
  },
];

/** Сумма весов новых критериев — 40. */
export const V2_CRITERIA_WEIGHT = V2_CRITERIA.reduce((sum, c) => sum + c.weight, 0);

const clamp01 = (n) => Math.max(0, Math.min(1, n));

function round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Балл формы: из энергии, новизны и гармонического движения.
 * @param {object} m метрики v2
 */
function formScore(m) {
  const energy = m.energy;
  if (!energy) return 0;
  // Размах в целевом диапазоне — 1, за пределами — линейное затухание.
  const [low, high] = energy.target || [0.1, 0.5];
  const range = energy.dynamicRange || 0;
  let rangeScore = 1;
  if (range < low) rangeScore = low ? range / low : 0;
  else if (range > high) rangeScore = high ? Math.max(0, 1 - (range - high) / high) : 0;

  // Новизна: развитие без хаоса.
  const novelty = m.novelty;
  let noveltyScore = 0.5;
  if (novelty) {
    if (novelty.mean < NOVELTY_LOW) noveltyScore = novelty.mean / (NOVELTY_LOW || 1);
    else if (novelty.max > NOVELTY_HIGH) noveltyScore = 0.5;
    else noveltyScore = clamp01(0.5 + (novelty.mean - NOVELTY_LOW) / 0.4);
  }

  // Почти-повторы: у трека с формой повторы должны быть.
  const repeatShare = novelty?.nearRepeatShare ?? 0;
  const repeatScore = repeatShare > 0.6 ? 0.6 : 1;

  return clamp01(rangeScore * 0.45 + noveltyScore * 0.35 + repeatScore * 0.2);
}

/** Средняя доля уникальных тактов по партиям. */
function meanVariation(m) {
  const perPart = m.variability?.perPart || {};
  const values = Object.values(perPart).map((p) => p.uniqueRatio ?? 0);
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Считает скор v2 трека.
 *
 * @param {string} code Strudel-код
 * @param {string} [style] стиль (id профиля или стиль спеки)
 * @param {string} [text] исходный запрос — для определения стиля
 * @returns {Promise<object>} скор v2
 */
export async function scoreTrackV2(code, style, text = '') {
  const profile = resolveProfile(style, text);
  // Старые критерии считаем по событиям Strudel: свой парсер mini-нотации
  // не понимает `arrange` и на структурированном треке находит ноль событий
  // (D-001). Старый `scoreTrack` при этом не ломается — он просто получает
  // другой источник данных.
  const analysis = await analyzeTrackFromEvents(code, { cycles: 8 });
  const v1 = scoreTrack(analysis, profile);

  let metrics = null;
  let metricsError = null;
  try {
    metrics = await analyzeProgression(code, { cycles: 64, style: profile.id });
  } catch (err) {
    metricsError = err?.message || String(err);
  }

  const hasForm = metrics && metrics.bars >= MIN_FORM_BARS;

  // --- новые критерии ---
  const newCriteria = [];
  if (hasForm) {
    for (const criterion of V2_CRITERIA) {
      const raw = criterion.value(metrics);
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
      // Каждый новый критерий нормируется к [0, 1] по своей шкале.
      const normalized = normalizeCriterion(criterion, value);
      const quality = criterion.quality(metrics) ?? 1;
      const score = clamp01(normalized * quality);
      newCriteria.push({
        id: criterion.id,
        label: criterion.label,
        weight: criterion.weight,
        unit: criterion.unit,
        value: value === null ? null : round(value, 3),
        target: criterion.describe(profile),
        score: round(score, 3),
        points: round(score * criterion.weight, 1),
        status: value === null ? 'na' : score >= 0.8 ? 'ok' : score >= 0.55 ? 'near' : 'bad',
      });
    }
  }

  const newTotal = newCriteria.reduce((sum, c) => sum + c.points, 0);
  const newMax = V2_CRITERIA_WEIGHT;

  // --- старые критерии масштабируются до 60 ---
  const oldScale = (1 - V2_WEIGHT) / (CRITERIA.reduce((sum, c) => sum + c.weight, 0) / 100);
  const oldCriteria = v1.criteria.map((criterion) => {
    const weight = round(criterion.weight * oldScale, 1);
    return {
      ...criterion,
      weight,
      points: round(criterion.score * weight, 1),
      group: 'v1',
    };
  });
  const oldTotal = oldCriteria.reduce((sum, c) => sum + c.points, 0);

  const total = round(oldTotal + newTotal, 1);
  const issues = [
    ...v1.issues.map((issue) => ({ ...issue, group: 'v1' })),
    ...newCriteria
      .filter((c) => c.status === 'bad' || c.status === 'near')
      .map((c) => ({
        id: c.id,
        label: c.label,
        weight: c.weight,
        value: c.value,
        target: c.target,
        score: c.score,
        gain: round(c.weight * (1 - c.score), 1),
        hint: v2Hint(c.id, metrics, analysis),
        group: 'v2',
      })),
  ].sort((a, b) => b.gain - a.gain);

  if (!hasForm) {
    issues.unshift({
      id: 'no-form',
      label: 'Нет формы',
      weight: 0,
      value: metrics?.bars ?? null,
      target: `не менее ${MIN_FORM_BARS} тактов`,
      score: 0,
      gain: 0,
      hint:
        `Трек длиной ${metrics?.bars ?? '—'} такт — форма не читается. ` +
        'Новые критерии не применяются: на таком треке их не измерить.',
      group: 'v2',
    });
  }

  return {
    total,
    grade: gradeOf(total),
    criteria: [...oldCriteria, ...newCriteria],
    oldTotal: round(oldTotal, 1),
    newTotal: round(newTotal, 1),
    oldMax: round(CRITERIA.reduce((sum, c) => sum + c.weight, 0) * oldScale, 1),
    newMax,
    issues,
    hasForm,
    metrics,
    metricsError,
    profile: profile.id,
  };
}

/**
 * Нормализация нового критерия к [0, 1] по его шкале.
 */
function normalizeCriterion(criterion, value) {
  if (value === null) return 0.5;
  switch (criterion.id) {
    case 'progression':
      return clamp01(value);
    case 'harmonicMotion':
      // Цель: 0.4–1.0 смены аккорда на 4 такта.
      if (value < 0.15) return clamp01(value / 0.15);
      if (value > 1.4) return clamp01(1 - (value - 1.4) / 1.6);
      return 1;
    case 'partDiversity':
      // Цель: 4–8 партий.
      return clamp01((value - 1) / 5);
    case 'variability':
      // Цель: средняя доля уникальных тактов.
      return clamp01(value / 0.35);
    case 'automation':
      // Цель: хотя бы четверть параметров автоматизирована.
      return clamp01(value / 0.25);
    default:
      return clamp01(value);
  }
}

/**
 * Конкретное замечание по каждому новому критерию.
 */
function v2Hint(id, metrics, analysis) {
  if (!metrics) return 'Метрики не посчитались: проверьте, что код исполняется.';
  switch (id) {
    case 'progression': {
      const energy = metrics.energy;
      const [low, high] = energy.target || [0.1, 0.5];
      if (energy.dynamicRange < low) {
        return (
          `Размах энергии ${energy.dynamicRange.toFixed(2)} при цели ${low}–${high}: ` +
          'секции звучат одинаково. Подними энергию дропа до 0.9 и опусти интро до 0.3.'
        );
      }
      if (energy.dynamicRange > high) {
        return (
          `Размах энергии ${energy.dynamicRange.toFixed(2)} при цели ${low}–${high}: ` +
          'трек слишком рваный. Сглаживай переходы между секциями.'
        );
      }
      if (metrics.novelty?.mean < NOVELTY_LOW) {
        return (
          `Средняя новизна ${metrics.novelty.mean.toFixed(3)} ниже порога ${NOVELTY_LOW}: ` +
          'окна почти не отличаются. Смени рисунок партии или гармонию во второй половине.'
        );
      }
      if (metrics.novelty?.max > NOVELTY_HIGH) {
        return (
          `Максимальная новизна ${metrics.novelty.max.toFixed(2)} выше порога ${NOVELTY_HIGH}: ` +
          'трек слишком рваный — часть окон не связана с остальными.'
        );
      }
      return 'Форма в порядке: энергия и новизна в целевых диапазонах.';
    }
    case 'harmonicMotion': {
      const harmony = metrics.harmony;
      if (harmony.wallpaper.flag) {
        return (
          `Одна гармония ${harmony.longestRun} тактов подряд — «обои». ` +
          'Смени прогрессию в середине трека.'
        );
      }
      if (harmony.changesPer4Bars < 0.15) {
        return `Всего ${harmony.changes} смен гармонии на ${metrics.bars} такт — слишком статично.`;
      }
      return `Смен гармонии: ${harmony.changes} (${harmony.changesPer4Bars.toFixed(2)} на 4 такта), различных аккордов: ${harmony.distinct}.`;
    }
    case 'partDiversity': {
      const diversity = metrics.diversity;
      if (diversity.meanJaccard > 0.6) {
        return (
          `Партии совпадают по рисунку (Жаккар ${diversity.meanJaccard.toFixed(2)}): ` +
          'у каждой партии должен быть свой ритм.'
        );
      }
      return (
        `Партий: ${diversity.parts}, ролей: ${diversity.roles}, регистров: ${diversity.registers}, ` +
        `Жаккар сеток: ${diversity.meanJaccard.toFixed(2)}.`
      );
    }
    case 'variability': {
      if (metrics.variability?.bassIdentical) {
        const { from, to, bars } = metrics.variability.bassIdentical;
        return (
          `Бас идентичен в тактах ${from + 1}–${to + 1} (${bars} такт подряд): ` +
          'задай другой variant или смени рецепт баса.'
        );
      }
      return 'Рисунки партий меняются: повторов баса не найдено.';
    }
    case 'automation':
      return (
        `Автоматизировано ${metrics.automation.automated} из ${metrics.automation.total} параметров ` +
        `(${(metrics.automation.ratio * 100).toFixed(0)}%). ` +
        'Добавь движение через сигнал: .lpf(sine.slow(8).range(400, 3000)).'
      );
    default:
      return 'Приведи метрику к целевому диапазону.';
  }
}

function gradeOf(total) {
  if (total >= 85) return 'A';
  if (total >= 75) return 'B+';
  if (total >= 65) return 'B';
  if (total >= 55) return 'C+';
  if (total >= 45) return 'C';
  return 'D';
}
