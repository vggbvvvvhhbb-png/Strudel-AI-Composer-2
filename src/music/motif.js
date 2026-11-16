// Мотив: контур + ритм + ступени лада (фаза D — мелодический мозг).
//
// До этого мелодия в проекте была статичной: лид брал один из двух-трёх
// шаблонов из матрицы ролей (`server/music/knowledge/roles.js`), и все
// скрипки в оркестре играли одно и то же. Измерено на треке из 100
// дорожек: у 18 скрипок было 3 уникальных ритма.
//
// Мотив здесь — не «последовательность нот», а единица музыкальной мысли:
//   • КОНТУР — форма линии (архетип смещений ступеней от опорной ступени);
//   • РИТМ   — ячейка на 16-й сетке;
//   • СТУПЕНИ — абсолютные ступени лада (0 — тоника).
//
// Из мотива вырастает фраза: A | A' | B | A'' — четыре варианта темы, где
// A' — транспозиция, B — контраст (ретроград + инверсия), A'' — возвращение
// с разрешением. Каденция задана явно: фраза заканчивается на ступени 4
// (половинная каденция) или 0 (полное разрешение).
//
// ВАЖНО: эти ступени — ОТНОСИТЕЛЬНЫЕ. Компилятор сдвигает партию корнем
// текущего аккорда (`.add(n("<roots>"))`), поэтому ступень 4 звучит как
// КВИНТА текущего аккорда, а 0 — как его КОРЕНЬ: каденция разрешается
// в аккорд, который звучит в конце секции, а не в глобальную тонику
// (D-123). Без гармонии в секции сдвига нет — каденция глобальная.
//
// Все функции детерминированы: один и тот же seed — один и тот же мотив,
// байт в байт. Math.random() здесь не используется никогда.

import { random01 } from '../ir/prng.js';

// Архетипы контура: смещения ступеней от опорной ступени.
// Числа — это ШАГИ ЛАДА, а не полутона: контур всегда остаётся в ладу.
export const CONTOURS = {
  rise: [0, 1, 2, 3],
  fall: [0, -1, -2, -3],
  arch: [0, 1, 2, 1],
  wave: [0, 2, 1, 3],
  peak: [0, 2, 4, 2],
  fallrise: [0, -1, -2, -1],
  step: [0, 1, 1, 2],
  leap: [0, 3, 2, 4],
};

// Ритмические ячейки: шаги на 16-й сетке (0 — доля, 4 — четверть, 8 — половинка).
export const RHYTHMS = {
  straight: [0, 4, 8, 12],
  eighths: [0, 2, 4, 6],
  sixteenth: [0, 1, 2, 3],
  syncop: [0, 3, 6, 10],
  dotted: [0, 3, 6, 12],
  sparse: [0, 6, 12],
  triplet: [0, 3, 8, 11],
};

// Какой контур и ритм вероятны в стиле. Не «правильный жанр», а веса:
// стиль задаёт предпочтение, а seed выбирает внутри него.
const STYLE_CONTOURS = {
  techno: ['arch', 'wave', 'step', 'leap'],
  house: ['arch', 'wave', 'rise', 'step'],
  'lo-fi': ['fall', 'fallrise', 'step', 'arch'],
  ambient: ['rise', 'arch', 'wave', 'fallrise'],
  dubstep: ['fall', 'leap', 'wave', 'arch'],
  synthwave: ['rise', 'arch', 'wave', 'peak'],
  trap: ['fall', 'wave', 'arch', 'leap'],
  jazz: ['step', 'wave', 'arch', 'fall'],
  rock: ['rise', 'fall', 'peak', 'arch'],
  cinematic: ['arch', 'rise', 'fall', 'peak'],
};

const STYLE_RHYTHMS = {
  techno: ['straight', 'sixteenth', 'syncop', 'triplet'],
  house: ['straight', 'eighths', 'syncop', 'triplet'],
  'lo-fi': ['sparse', 'dotted', 'straight', 'triplet'],
  ambient: ['sparse', 'dotted', 'triplet', 'eighths'],
  dubstep: ['syncop', 'straight', 'dotted', 'triplet'],
  synthwave: ['straight', 'eighths', 'triplet', 'syncop'],
  trap: ['syncop', 'triplet', 'straight', 'dotted'],
  jazz: ['syncop', 'triplet', 'eighths', 'sparse'],
  rock: ['straight', 'eighths', 'syncop', 'dotted'],
  cinematic: ['sparse', 'dotted', 'straight', 'eighths'],
};

// Роли вариантов фразы: A — тема, A' — транспозиция, B — контраст,
// A'' — возвращение с разрешением.
export const PHRASE_ROLES = ['A', "A'", 'B', "A''"];

// Сколько нот в мотиве по группам оркестра.
//
// Числа не взяты с потолка: это бюджет атак на такт из `GROUP_BUDGET`
// (src/music/expand.js) — мотив не должен прореживаться, иначе от музыки
// остаются одни обрывки.
//
// Длинные группы играют меньше нот, но те же: у хора две половинные,
// у струнных три четверти, у солиста четыре. Это и есть дивизи — одна
// тема, разные длительности.
export const MOTIF_LENGTH_BY_GROUP = {
  strings: 3,
  brass: 3,
  woodwinds: 3,
  keys: 4,
  choir: 2,
  lead: 4,
  arp: 4,
};

/**
 * Выбор из списка по seed — детерминированно.
 * @param {string[]} options
 * @param {number} seed
 * @param {...(string|number)} parts адрес
 * @returns {string}
 */
function pick(options, seed, ...parts) {
  if (!options.length) return '';
  return options[Math.floor(random01(seed, ...parts) * options.length) % options.length];
}

/**
 * Нормализация ступеней: мотив не уходит ниже тоники. Сдвиг на
 * константу сохраняет интервальный рисунок контура.
 * @param {number[]} degrees
 * @returns {{degrees: number[], shift: number}}
 */
function normalizeDegrees(degrees) {
  const min = degrees.reduce((acc, value) => Math.min(acc, value), 0);
  const shift = min < 0 ? -min : 0;
  return { degrees: degrees.map((value) => value + shift), shift };
}

/**
 * Создаёт мотив: контур + ритм + ступени.
 *
 * @param {object} options
 * @param {number} [options.seed] зерно трека
 * @param {string} [options.style] стиль (влияет на предпочтение)
 * @param {string} [options.contour] имя архетипа контура
 * @param {string} [options.rhythm] имя ритмической ячейки
 * @param {number} [options.length] сколько нот в мотиве
 * @param {number} [options.anchor] опорная ступень (0 — тоника, 4 — доминанта)
 * @returns {object} мотив
 */
export function createMotif({ seed = 1, style = 'techno', contour, rhythm, length = 4, anchor = 0 } = {}) {
  const contours = STYLE_CONTOURS[style] ?? Object.keys(CONTOURS);
  const rhythms = STYLE_RHYTHMS[style] ?? Object.keys(RHYTHMS);
  const contourName = contour ?? pick(contours, seed, 'contour');
  const rhythmName = rhythm ?? pick(rhythms, seed, 'rhythm');

  const shape = CONTOURS[contourName] ?? CONTOURS.arch;
  const cells = RHYTHMS[rhythmName] ?? RHYTHMS.straight;
  const count = Math.max(2, Math.min(8, Math.round(length || 4)));

  const degrees = shape.slice(0, count).map((offset) => anchor + offset);
  const steps = cells.slice(0, count);
  const { degrees: normalized } = normalizeDegrees(degrees);

  return {
    degrees: normalized,
    steps,
    contour: contourName,
    rhythm: rhythmName,
    anchor: normalized[0],
    length: count,
  };
}

/**
 * Транспозиция по ступеням лада.
 * @param {object} motif
 * @param {number} delta
 * @returns {object}
 */
export function transposeMotif(motif, delta) {
  if (!delta) return motif;
  const { degrees } = normalizeDegrees(motif.degrees.map((value) => value + delta));
  return { ...motif, degrees, anchor: degrees[0] };
}

/**
 * Инверсия относительно опорной ступени: контур переворачивается.
 * @param {object} motif
 * @param {number} [pivot]
 * @returns {object}
 */
export function invertMotif(motif, pivot = 4) {
  const { degrees } = normalizeDegrees(motif.degrees.map((value) => 2 * pivot - value));
  return { ...motif, degrees, anchor: degrees[0], contour: `inversion:${motif.contour}` };
}

/**
 * Ретроград: контур читается задом наперёд.
 * @param {object} motif
 * @returns {object}
 */
export function retrogradeMotif(motif) {
  const degrees = [...motif.degrees].reverse();
  // Сетка остаётся восходящей: motifToMini сортирует атаки по шагу, и
  // переворот сетки вместе со ступенями отменил бы ретроград, а каденция
  // (withEnding меняет последнюю ступень) легла бы на ПЕРВУЮ ноту фразы.
  return { ...motif, degrees, anchor: degrees[0], contour: `retrograde:${motif.contour}` };
}

/**
 * Аугментация: ритм растягивается вдвое (длиннее ноты — реже атаки).
 * Ноты, не помещающиеся в такт, отбрасываются.
 * @param {object} motif
 * @param {number} [factor]
 * @returns {object}
 */
export function augmentMotif(motif, factor = 2) {
  const degrees = [];
  const steps = [];
  motif.degrees.forEach((degree, index) => {
    const step = motif.steps[index] * factor;
    if (step >= 16) return;
    degrees.push(degree);
    steps.push(step);
  });
  if (!degrees.length) return motif;
  return { ...motif, degrees, steps, length: degrees.length, rhythm: `augmented:${motif.rhythm}` };
}

/**
 * Фрагментация: от мотива остаётся начало.
 * @param {object} motif
 * @param {number} size
 * @returns {object}
 */
export function fragmentMotif(motif, size = 2) {
  const count = Math.max(1, Math.min(motif.degrees.length, size));
  return {
    ...motif,
    degrees: motif.degrees.slice(0, count),
    steps: motif.steps.slice(0, count),
    length: count,
    contour: `fragment:${motif.contour}`,
  };
}

/**
 * Каданса: последняя нота мотива ставится на заданную ступень.
 * @param {object} motif
 * @param {number} degree
 * @returns {object}
 */
export function withEnding(motif, degree) {
  if (!motif.degrees.length) return motif;
  const degrees = [...motif.degrees];
  degrees[degrees.length - 1] = degree;
  const { degrees: normalized } = normalizeDegrees(degrees);
  return { ...motif, degrees, anchor: normalized[0] };
}

/**
 * Мотив в мини-нотацию: длительности в 16-х долях, сумма — ровно такт.
 *
 * Важно: длительность задаёт ЗВУЧАНИЕ, а не позицию. Семантика `@`
 * измерена (scripts/probe-duration-semantics.mjs): в последовательности
 * единица = 1/(сумма длительностей) цикла, поэтому «0@8 4@8» — это две
 * половинные ноты (0.5 и 0.5), а не две шестнадцатые с тишиной.
 *
 * Без этого оркестровые голоса звучали бы как стаккато: скрипка играет
 * шестнадцатую и молчит полтакта — это не скрипка, а пульс.
 *
 * @param {object} motif
 * @param {object} [options]
 * @param {number} [options.grid] сетка такта в 16-х (16 = такт)
 * @returns {string}
 */
export function motifToMini(motif, { grid = 16 } = {}) {
  const notes = [];
  motif.degrees.forEach((degree, index) => {
    const step = motif.steps[index];
    if (degree === null || degree === undefined) return;
    if (!Number.isFinite(step) || step < 0 || step >= grid) return;
    notes.push({ degree, step });
  });
  notes.sort((a, b) => a.step - b.step);
  if (!notes.length) return new Array(grid).fill('~').join(' ');
  return notes.map((note, index) => {
    const next = index + 1 < notes.length ? notes[index + 1].step : grid;
    const duration = Math.max(1, next - note.step);
    return `${note.degree}@${duration}`;
  }).join(' ');
}

/**
 * Четыре варианта темы: A | A' | B | A''.
 *
 *   A    — тема как есть, половинная каденция (конец на квинте аккорда);
 *   A'   — тема на доминанте (тоника + 4 ступени);
 *   B    — контраст: ретроград инверсии, тоже на квинте аккорда;
 *   A''  — возвращение с полным разрешением: квинта→корень аккорда
 *          в двух последних нотах (ступени 4→0 до сдвига корнем).
 *
 * @param {object} motif
 * @returns {Array<{role: string, motif: object, mini: string}>}
 */
export function phraseVariants(motif) {
  const a = withEnding(motif, 4);
  const aPrime = withEnding(transposeMotif(motif, 4), 4);
  const b = withEnding(retrogradeMotif(invertMotif(motif)), 4);
  const aDouble = withEnding(transposeMotif(motif, 2), 0);
  // Полное разрешение: предпоследняя нота — доминанта, последняя — тоника.
  const resolved = { ...aDouble, degrees: [...aDouble.degrees] };
  if (resolved.degrees.length >= 2) {
    resolved.degrees[resolved.degrees.length - 2] = 4;
    resolved.degrees[resolved.degrees.length - 1] = 0;
  }
  return [a, aPrime, b, resolved].map((item, index) => ({
    role: PHRASE_ROLES[index],
    motif: item,
    mini: motifToMini(item),
  }));
}

/**
 * Ровно N шагов на 16-й сетке: ровные доли такта.
 * @param {number} count
 * @returns {number[]}
 */
function evenSteps(count) {
  return Array.from({ length: count }, (_, index) => Math.floor((index * 16) / count));
}

/**
 * Как группа оркестра обращается с общей темой.
 *
 * Замысел: ТЕМА одна на весь трек (иначе оркестр звучит как набор
 * солистов), а группа берёт её по-своему:
 *   • струнные  — тема, три четверти: голоса делят варианты фразы (дивизи);
 *   • медные    — инверсия темы (ответ);
 *   • деревянные— тема в удлинённых нотах;
 *   • клавишные — тема ровными долями;
 *   • хор       — две половинные: та же тема, но дышащая;
 *   • солист    — тема как есть, её ритм;
 *   • арпеджио  — тема, разложенная на ровные доли.
 *
 * Ни одна группа не придумывает свой материал: все берут начало темы и
 * свои длительности. Поэтому материал трека остаётся связным.
 *
 * Возвращается ВСЯ тема (степени), а не её начало: сколько нот группа
 * споёт — решает голос (voiceMotifMini) по длине группы. Так видно, что
 * тема у всех одна, а не «у каждой группы своя».
 *
 * @param {object} options
 * @param {string} options.group группа оркестра
 * @param {number} options.seed зерно трека
 * @param {string} options.style стиль
 * @param {object} theme базовая тема трека
 * @returns {object} мотив группы
 */
export function groupTheme(group, { seed, style, theme }) {
  const length = MOTIF_LENGTH_BY_GROUP[group] ?? 3;
  const take = () => ({
    // Степени — вся тема: группа берёт её начало, а не свой материал.
    degrees: [...theme.degrees],
    // Сетка длительностей — своя у каждой группы: дивизи.
    steps: evenSteps(length),
    length,
  });
  switch (group) {
    case 'brass': {
      const inverted = invertMotif(theme, 4);
      return { ...inverted, degrees: [...inverted.degrees], steps: evenSteps(length) };
    }
    case 'lead':
      // Солист несёт тему в её собственном ритме.
      return { ...theme };
    default:
      return take();
  }
}

/**
 * Рисунок партии: мотив группы в нужном варианте фразы.
 *
 * Солист ведёт фразу сам — его вариант идёт по форме (A, A', B, A'').
 * Остальные группы — дивизи: голоса делят варианты между собой, чтобы
 * секция не звучала одним голосом.
 *
 * @param {object} options
 * @param {string} options.group группа
 * @param {number} options.seed зерно трека
 * @param {string} options.style стиль
 * @param {number} options.voiceIndex номер голоса в группе (дивизи)
 * @param {number} options.variantIndex вариант фразы (0..3)
 * @param {object} options.theme базовая тема
 * @returns {string} мини-нотация
 */
export function voiceMotifMini({ group, seed, style, voiceIndex = 0, variantIndex = 0, theme }) {
  const base = groupTheme(group, { seed, style, theme });
  const length = MOTIF_LENGTH_BY_GROUP[group] ?? 3;
  const trimmed = { ...base, degrees: base.degrees.slice(0, length), steps: base.steps.slice(0, length) };
  const variants = phraseVariants(trimmed);
  const offset = group === 'lead' ? 0 : voiceIndex;
  const index = (((variantIndex + offset) % variants.length) + variants.length) % variants.length;
  return variants[index].mini;
}

/**
 * Кому какой вариант фразы достаётся — по энергии секции.
 *
 * Классическая форма: тихая секция — предпосылка (A, половинная
 * каденция, конец на доминанте), громкая — вывод (A'', полное разрешение
 * V–I). Средние секции получают A' и B.
 *
 * @param {Array<{energy?: number}>} sections
 * @returns {Map<number, number>} индекс секции -> вариант фразы
 */
export function assignPhraseRoles(sections) {
  const list = (sections ?? []).map((section, index) => ({
    index,
    energy: Number.isFinite(section?.energy) ? section.energy : 0.5,
  }));
  const byEnergy = [...list].sort((a, b) => a.energy - b.energy);
  const roles = new Map();
  if (!byEnergy.length) return roles;
  if (byEnergy.length === 1) {
    roles.set(byEnergy[0].index, 3);
    return roles;
  }
  roles.set(byEnergy[0].index, 0);
  roles.set(byEnergy[byEnergy.length - 1].index, 3);
  const middle = byEnergy.slice(1, -1);
  middle.forEach((item, position) => roles.set(item.index, position % 2 === 0 ? 1 : 2));
  return roles;
}

/**
 * Базовая тема трека: одна на весь трек, детерминированная по зерну.
 * @param {object} options
 * @param {number} options.seed
 * @param {string} options.style
 * @returns {object} мотив
 */
export function trackTheme({ seed = 1, style = 'cinematic' } = {}) {
  return createMotif({ seed, style, length: 4, anchor: 0 });
}

/**
 * Интервальный рисунок мотива: разности соседних ступеней.
 * По нему судят, один ли это мотив: одинаковый рисунок — одна тема.
 * @param {object} motif
 * @returns {number[]}
 */
export function intervalSignature(motif) {
  const signature = [];
  for (let i = 1; i < motif.degrees.length; i += 1) {
    signature.push(motif.degrees[i] - motif.degrees[i - 1]);
  }
  return signature;
}

/**
 * Сходство двух интервальных рисунков: доля общих интервалов в том же
 * порядке (самая длинная общая подпоследовательность).
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} 0..1
 */
export function signatureSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i][j] = a[i - 1] === b[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table[rows - 1][cols - 1] / Math.max(a.length, b.length);
}
