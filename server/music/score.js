// Составной скор «музыкальности» — прозрачный и разбираемый.
//
// Каждая критика даёт свой балл (вес в процентах), и в отчёте видно,
// что именно не попало в цель. Скор нужен не как абсолютная истина, а как
// обратная связь: модель получает список конкретных замечаний и правит код.

import { PROFILES } from './references.js';

// Критерии и их веса. Экспортируются: калибровка (scripts/calibrate.mjs)
// перебирает веса, подбирая их под оценки человека.

// Роль партии -> музыкальная функция. Нужна, потому что словарь ролей
// изменился: анализатор теперь берёт роль из кода (`// role=pad`),
// а не угадывает по метке (D-100).
export const ROLE_FUNCTIONS = {
  kick: 'drums', snare: 'drums', hats: 'drums', perc: 'drums', drums: 'drums',
  bass: 'bass', sub: 'bass',
  lead: 'melody', arp: 'melody', melody: 'melody',
  pad: 'pad', chords: 'pad', texture: 'pad',
  fx: 'fx',
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * Плотность атак на такт, приведённая к числу дорожек.
 *
 * Диапазон в профиле задан для типичного трека (4–7 партий). Дорожек
 * больше — значит больше атак по той же причине: каждая партия играет.
 * Без масштабирования трек из 100 дорожек получал бы ноль по критерию
 * плотности, то есть гейт рубил бы ровно то, что мы строим (C3).
 */
export function densityTarget(profile, partCount) {
  const base = profile.density;
  const n = Math.max(1, Math.round(partCount || 1));
  const reference = Math.max(1, profile.parts[0]);
  const scale = n / reference;
  return [Math.max(1, Math.round(base[0] * scale)), Math.max(2, Math.round(base[1] * scale))];
}

/**
 * Доля партий со своим ритмом, ожидаемая при данном размере трека.
 *
 * В маленьком треке каждая партия играет по-своему. В оркестре из 100
 * дорожек секции делят ритм (8 скрипок играют одно и то же) — это и есть
 * оркестровка, а не дефект. Поэтому ожидание падает с ростом состава,
 * но не ниже 2%: иначе критерий вообще ничего не значит.
 */
export function varietyTarget(profile, partCount) {
  const n = Math.max(1, Math.round(partCount || 1));
  const reference = Math.max(1, profile.parts[0]);
  const scale = Math.min(1, reference / n);
  return Math.max(0.02, profile.variety * scale);
}

export const CRITERIA = [
  {
    id: 'tempo',
    label: 'Темп',
    weight: 6,
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
    // Цель считается от числа дорожек (densityTarget).
    score: (value, profile, metrics) => {
      const [min, max] = densityTarget(profile, metrics.partCount);
      if (value >= min && value <= max) return 1;
      const span = Math.max(1, max - min);
      const dist = value < min ? min - value : value - max;
      return clamp01(1 - dist / span);
    },
    describeScaled: (profile, metrics) => {
      const [min, max] = densityTarget(profile, metrics.partCount);
      return `${min}–${max} атак на такт (${metrics.partCount} партий)`;
    },
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
    describe: (p) => `не менее ${p.parts[0]} партий (типично ${p.parts[0]}–${p.parts[1]})`,
    // Избыток дорожек НЕ штрафуется: 7 — мягкая цель, 12 — был потолок,
    // 100 — цель фазы C. Штраф за «слишком много партий» рубил бы ровно
    // то, что мы строим (D-100, C3). Недостаток партий — штрафуется.
    score: (value, profile) => {
      const min = Math.max(1, profile.parts[0]);
      if (value >= min) return 1;
      return clamp01(value / min);
    },
    quality: (m) => {
      // Покрытие музыкальных функций: ударные/бас/мелодия — иначе
      // аранжировка пустая. Роли приходят из кода (`// role=`), поэтому
      // и библиотечные (kick, lead), и общие (drums, melody) словари
      // приводим к функциям.
      const need = ['drums', 'bass', 'melody'];
      const functions = new Set((m.roles || []).map((role) => ROLE_FUNCTIONS[role] || role));
      const covered = need.filter((fn) => functions.has(fn)).length;
      const bonus = functions.has('pad') || functions.has('fx') ? 0.1 : 0;
      return 0.6 + 0.4 * (covered / need.length) + bonus;
    },
  },
  {
    id: 'motion',
    label: 'Движение мелодии',
    weight: 10,
    unit: 'интервалов',
    value: (m) => m.motion,
    target: (p) => p.motion,
    describe: (p) => `${p.motion[0]}–${p.motion[1]} разных интервалов`,
  },
  {
    id: 'space',
    label: 'Воздух (паузы)',
    weight: 6,
    unit: 'доля',
    value: (m) => m.space,
    target: (p) => p.space,
    describe: (p) => `${Math.round(p.space[0] * 100)}–${Math.round(p.space[1] * 100)}% тишин`,
  },
  {
    id: 'variety',
    label: 'Разнообразие партий',
    weight: 8,
    unit: 'доля',
    value: (m) => m.rhythmVariety,
    min: (p) => p.variety,
    describe: (p) => `не менее ${Math.round(p.variety * 100)}% партий со своим ритмом`,
    // Ожидание падает с ростом состава (varietyTarget): в оркестре секции
    // делят ритм, и это нормально.
    score: (value, profile, metrics) => {
      const min = varietyTarget(profile, metrics.partCount);
      return clamp01(value / (min || 1));
    },
    describeScaled: (profile, metrics) => {
      const min = varietyTarget(profile, metrics.partCount);
      return `не менее ${Math.round(min * 100)}% партий со своим ритмом (${metrics.partCount} партий)`;
    },
  },
  {
    id: 'development',
    label: 'Развитие мелодии',
    weight: 8,
    unit: 'доля',
    value: (m) => m.motifDevelopment,
    describe: () => 'не менее 30% секций с новым материалом',
    // Порог откалиброван измерением: у трека с одной темой на все секции
    // развитие 0, у трека с фразой A|A'|B|A'' — около 0.9
    // (scripts/probe-melody-metrics.mjs).
    score: (value) => clamp01(value / 0.3),
    // У трека с одной секцией развития нет по построению — данных нет,
    // и штрафовать за это нельзя.
    noDataScore: 1,
  },
];

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
    if (criterion.score) {
      // У критерия своя функция оценки: цель может зависеть от метрик
      // (плотность — от числа дорожек, аранжировка — от нижней границы).
      // «Нет данных» — нейтральная оценка 0.5, но критерий может задать
      // своё значение (noDataScore): отсутствие данных не должно штрафовать
      // трек, у которого просто нет нескольких секций.
      score = value === null ? (criterion.noDataScore ?? 0.5) : criterion.score(value, profile, metrics);
      if (criterion.target) {
        const range = criterion.target(profile);
        target = `${range[0]}–${range[1]} ${criterion.unit}`;
      } else {
        const min = criterion.min ? criterion.min(profile) : null;
        target = min === null ? '—' : min <= 1 ? `≥ ${Math.round(min * 100)}%` : `≥ ${min} ${criterion.unit}`;
      }
    } else if (criterion.min) {
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
      targetText: criterion.describeScaled ? criterion.describeScaled(profile, metrics) : criterion.describe(profile),
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
      const [min, max] = densityTarget(profile, m.partCount);
      if (value < min) {
        return `Мало атак: ${value} на такт при цели ${min}–${max} (${m.partCount} партий). Добавь движение: больше слотов в барабанах (hh*16), синопсии, больше партий.`;
      }
      return `Слишком плотно: ${value} атак на такт при цели ${min}–${max} (${m.partCount} партий). Убери часть атак, оставь паузы (тильда ~) и разрежи рисунок.`;
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
      const functions = new Set((m.roles || []).map((role) => ROLE_FUNCTIONS[role] || role));
      const missing = ['drums', 'bass', 'melody'].filter((fn) => !functions.has(fn));
      const extra = missing.length ? ` Добавь партии: ${missing.join(', ')}.` : '';
      return `Партий ${v(m)} (нужно не менее ${profile.parts[0]}, типично ${profile.parts[0]}–${profile.parts[1]}).${extra}`;
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
