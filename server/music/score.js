// Составной скор «музыкальности» — прозрачный и разбираемый.
//
// Каждая критика даёт свой балл (вес в процентах), и в отчёте видно,
// что именно не попало в цель. Скор нужен не как абсолютная истина, а как
// обратная связь: модель получает список конкретных замечаний и правит код.

import { PROFILES } from './references.js';

// Критерии и их веса. Экспортируются: калибровка (scripts/calibrate.mjs)
// перебирает веса, подбирая их под оценки человека.
export const CRITERIA = [
  {
    id: 'tempo',
    label: 'Темп',
    weight: 8,
    unit: 'BPM',
    value: (m) => m.bpm,
    target: (p) => p.bpm,
    describe: (p) => `${p.bpm[0]}–${p.bpm[1]} BPM`,
  },
  {
    id: 'density',
    label: 'Плотность атак',
    weight: 12,
    unit: 'в такт',
    value: (m) => m.density,
    target: (p) => p.density,
    describe: (p) => `${p.density[0]}–${p.density[1]} атак на такт`,
  },
  {
    id: 'groove',
    label: 'Грув (доля офф-бит атак)',
    weight: 10,
    unit: 'доля',
    value: (m) => m.offbeat,
    target: (p) => p.offbeat,
    describe: (p) => `${p.offbeat[0]}–${p.offbeat[1]} атак вне сетки 1/4`,
  },
  {
    id: 'scaleFit',
    label: 'Тональность',
    weight: 12,
    unit: 'доля',
    value: (m) => m.scaleFit,
    min: (p) => p.scaleFit,
    describe: (p) => `не менее ${Math.round(p.scaleFit * 100)}% нот в ладу`,
  },
  {
    id: 'range',
    label: 'Диапазон',
    weight: 8,
    unit: 'полутонов',
    value: (m) => m.range,
    target: (p) => p.range,
    describe: (p) => `${p.range[0]}–${p.range[1]} полутонов`,
  },
  {
    id: 'separation',
    label: 'Разделение регистров',
    weight: 10,
    unit: 'полутонов',
    value: (m) => m.separation,
    min: (p) => p.separation,
    describe: (p) => `не менее ${p.separation} полутонов между басом и мелодией`,
  },
  {
    id: 'arrangement',
    label: 'Аранжировка',
    weight: 10,
    unit: 'партий',
    value: (m) => m.partCount,
    target: (p) => p.parts,
    describe: (p) => `${p.parts[0]}–${p.parts[1]} партий`,
    quality: (m) => {
      // Разнообразие ролей: бас/ударные/мелодия/пады — иначе аранжировка пустая.
      const need = ['drums', 'bass', 'melody'];
      const have = m.roles || [];
      const covered = need.filter((r) => have.includes(r)).length;
      const bonus = have.includes('pad') || have.includes('arp') || have.includes('hats') ? 0.1 : 0;
      return 0.6 + 0.4 * (covered / need.length) + bonus;
    },
  },
  {
    id: 'motion',
    label: 'Движение мелодии',
    weight: 12,
    unit: 'интервалов',
    value: (m) => m.motion,
    target: (p) => p.motion,
    describe: (p) => `${p.motion[0]}–${p.motion[1]} разных интервалов`,
  },
  {
    id: 'space',
    label: 'Воздух (паузы)',
    weight: 8,
    unit: 'доля',
    value: (m) => m.space,
    target: (p) => p.space,
    describe: (p) => `${Math.round(p.space[0] * 100)}–${Math.round(p.space[1] * 100)}% тишин`,
  },
  {
    id: 'variety',
    label: 'Разнообразие партий',
    weight: 10,
    unit: 'доля',
    value: (m) => m.rhythmVariety,
    min: (p) => p.variety,
    describe: (p) => `не менее ${Math.round(p.variety * 100)}% партий со своим ритмом`,
  },
];

const clamp01 = (n) => Math.max(0, Math.min(1, n));

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Оценка попадания в диапазон: внутри — 1, вне — линейное затухание.
function rangeScore(value, [min, max]) {
  if (value >= min && value <= max) return 1;
  const span = Math.max(1, max - min);
  const dist = value < min ? min - value : value - max;
  return clamp01(1 - dist / span);
}

function gradeOf(total) {
  if (total >= 85) return 'A';
  if (total >= 75) return 'B+';
  if (total >= 65) return 'B';
  if (total >= 55) return 'C+';
  if (total >= 45) return 'C';
  return 'D';
}

/**
 * Считает скор трека по референсному профилю.
 *
 * @param {object} analysis результат analyzeTrack
 * @param {object} profile профиль стиля из references.js
 * @param {object} [weights] переопределение весов критериев (использует калибровка)
 * @returns {{total:number, grade:string, criteria:Array, issues:Array}}
 */
export function scoreTrack(analysis, profile = PROFILES.generic, weights = {}) {
  const metrics = analysis.metrics || {};
  const criteria = [];

  for (const criterion of CRITERIA) {
    const raw = criterion.value(metrics);
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    const weight = weights[criterion.id] ?? criterion.weight;

    let score;
    let target;
    if (criterion.min) {
      const min = criterion.min(profile);
      // Порог в долях (0..1) — это процент, иначе — абсолютная величина.
      target = min <= 1 ? `≥ ${Math.round(min * 100)}%` : `≥ ${min} ${criterion.unit}`;
      score = value === null ? 0.5 : clamp01(value / (min || 1));
    } else {
      const range = criterion.target(profile);
      target = `${range[0]}–${range[1]} ${criterion.unit}`;
      score = value === null ? 0.5 : rangeScore(value, range);
    }

    const quality = criterion.quality ? criterion.quality(metrics) : 1;
    score = clamp01(score * quality);

    criteria.push({
      id: criterion.id,
      label: criterion.label,
      weight,
      unit: criterion.unit,
      value: value === null ? null : round(value, 3),
      target,
      targetText: criterion.describe(profile),
      score: round(score, 3),
      points: round(score * weight, 1),
      status: value === null ? 'na' : score >= 0.8 ? 'ok' : score >= 0.55 ? 'near' : 'bad',
    });
  }

  const total = round(criteria.reduce((sum, c) => sum + c.points, 0), 1);
  const issues = criteria
    .filter((c) => c.status === 'bad' || c.status === 'near')
    .map((c) => ({
      id: c.id,
      label: c.label,
      weight: c.weight,
      value: c.value,
      target: c.targetText,
      score: c.score,
      gain: round(c.weight * (1 - c.score), 1),
      hint: issueHint(CRITERIA.find((d) => d.id === c.id), analysis, profile),
    }))
    .sort((a, b) => b.gain - a.gain);

  return { total, grade: gradeOf(total), criteria, issues, profile: profile.id };
}

// Конкретное замечание к каждой проваленной критеке.
function issueHint(criterion, analysis, profile) {
  const m = analysis.metrics || {};
  const v = criterion.value;
  switch (criterion.id) {
    case 'tempo': {
      const value = v(m);
      const [min, max] = profile.bpm;
      return value < min
        ? `Темп ${value ?? '—'} BPM ниже цели (${min}–${max}). Подними темп до ${Math.round((min + max) / 2)} BPM — строка setCpm.`
        : `Темп ${value ?? '—'} BPM выше цели (${min}–${max}). Снизь до ${Math.round((min + max) / 2)} BPM — строка setCpm.`;
    }
    case 'density': {
      const value = v(m);
      const [min, max] = profile.density;
      if (value < min) {
        return `Мало атак: ${value} на такт при цели ${min}–${max}. Добавь движение: больше слотов в барабанах (hh*16), синопсии, больше партий.`;
      }
      return `Слишком плотно: ${value} атак на такт при цели ${min}–${max}. Убери часть атак, оставь паузы (тильда ~) и разрежи рисунок.`;
    }
    case 'groove': {
      const value = v(m);
      const [min, max] = profile.offbeat;
      if (value < min) {
        return `Слишком ровная сетка: только ${Math.round(value * 100)}% атак вне 1/4. Добавь синкопы и шаги 1/8, 1/16 (сдвинь атаки на «и»).`;
      }
      return `Слишком много атак вне сетки (${Math.round(value * 100)}% при цели ${Math.round(min * 100)}–${Math.round(max * 100)}%). Собери ритм: сильные доли на 1 и 3, остальное на слабых.`;
    }
    case 'scaleFit': {
      const outside = analysis.outsideScale || [];
      const names = outside.map((o) => `${o.name}×${o.count}`).join(', ');
      return `Ноты вне лада${names ? ` (${names})` : ''}. Оставь только ступени тональности ${analysis.key?.name || ''} или сдвинь их на соседние ступени.`;
    }
    case 'range':
      return `Диапазон ${v(m)} полутонов при цели ${profile.range[0]}–${profile.range[1]}. ${v(m) < profile.range[0] ? 'Подними верхнюю партию на октаву.' : 'Опусти нижнюю партию или убери крайние ноты.'}`;
    case 'separation':
      return `Бас и верхние партии слишком близко (разница ${v(m) ?? '—'} полутонов, нужно не менее ${profile.separation}). Опусти бас на 1–2 октавы или подними мелодию, чтобы они не спорили.`;
    case 'arrangement': {
      const roles = m.roles || [];
      const missing = ['drums', 'bass', 'melody'].filter((r) => !roles.includes(r));
      const extra = missing.length ? ` Добавь партии: ${missing.join(', ')}.` : '';
      return `Партий ${v(m)} при цели ${profile.parts[0]}–${profile.parts[1]}.${extra}`;
    }
    case 'motion':
      return `Мелодия почти не движется: ${v(m)} разных интервалов при цели ${profile.motion[0]}–${profile.motion[1]}. Используй больше ступеней лада, скачки на терции/квинты, не повторяй одну ноту.`;
    case 'space':
      return `Пауз ${Math.round(v(m) * 100)}% при цели ${Math.round(profile.space[0] * 100)}–${Math.round(profile.space[1] * 100)}%. ${v(m) < profile.space[0] ? 'Дай паузы: тильда ~ в рисунке.' : 'Убери часть пауз, добавь атакующих.'}`;
    case 'variety':
      return `Партии повторяют один ритм (${Math.round(v(m) * 100)}% уникальных). Каждой партии — свой рисунок: бас и мелодия не должны идти одинаково.`;
    default:
      return 'Приведи метрику к целевому диапазону.';
  }
}

/**
 * Текстовый разбор для промпта модели: факты + конкретные замечания.
 */
export function formatReport(analysis, score, profile) {
  const lines = [];
  const m = analysis.metrics || {};
  lines.push(`Стиль-референс: ${profile.nameRu} (${profile.name}).`);
  lines.push(`Темп: ${analysis.bpm ?? 'не задан'} BPM. Тональность: ${analysis.key?.name || 'не задана'}${analysis.key && !analysis.key.declared ? ' (определена по нотам)' : ''}.`);
  lines.push(`Партий: ${m.partCount}. Атак на такт: ${m.density}. Доля офф-бит: ${Math.round((m.offbeat || 0) * 100)}%.`);
  lines.push(`Тональных нот: ${m.scaleFit === null ? '—' : `${Math.round(m.scaleFit * 100)}%`}. Диапазон: ${m.range ?? '—'} полутонов. Разделение регистров: ${m.separation ?? '—'}.`);
  lines.push(`Движение мелодии: ${m.motion} интервалов. Пауз: ${Math.round((m.space || 0) * 100)}%. Уникальных ритмов: ${Math.round((m.rhythmVariety || 0) * 100)}%.`);
  lines.push(`Итог: ${score.total} из 100 (${score.grade}).`);
  if (score.issues.length) {
    lines.push('Что нужно исправить:');
    for (const issue of score.issues) {
      lines.push(`- [${issue.label}] ${issue.hint}`);
    }
  } else {
    lines.push('Серьёзных замечаний нет.');
  }
  return lines.join('\n');
}
