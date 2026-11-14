// Реестр метрик (бриф v2 §4.5 и §4.4).
//
// ПРАВИЛО: отчёты ссылаются на id из этого реестра, а не на ad-hoc имена.
// Каждая метрика знает: что она измеряет, в каких единицах, в каком
// диапазоне, к какой цели стремится, откуда пришла (рендер / символ /
// человек) и в какой версии определена.
//
// Зачем реестр, если метрики и так считаются:
//
//   1. ВЕСА СКОРА БЫЛИ РАЗМАЗАНЫ ПО ТРЁМ МОДУЛЯМ. Символьные веса живут в
//      src/oracle/score.js, «аудио-критерии» — в server/music/score-v2.js,
//      а формула смешивания v1/v2/аудио — в server/music/compose/
//      audio-score.js. Правило брифа §2.8: метрика, не проверенная против
//      человеческих суждений, не должна быть целью оптимизации. Пока вес
//      живёт в коде вперемешку с логикой, никто не может сказать, какие из
//      них проверены. Здесь у каждого веса есть явный статус.
//
//   2. ОТЧЁТ ДОЛЖЕН ССЫЛАТЬСЯ НА ID, А НЕ НА ИМЯ ПОЛЯ. Иначе переименование
//      поля в отчёте молча ломает потребителя, и никто об этом не узнаёт.
//
//   3. TASTE MODEL (§7.4) обучает ВЕСА. Обучение требует признаков,
//      сопоставимых между треками: значит, у признака должен быть
//      зафиксированный id, диапазон и источник.
//
// Статус `validated: false` означает честное «не проверено на людях».
// Механизм, который превращает его в true, — обучение на человеческих
// парах (src/taste/*), см. §7.4.

export const REGISTRY_VERSION = 1;

/**
 * Метрики уровня L1 — символьные: что можно узнать о треке, НЕ слушая его.
 * Источник: src/oracle/metrics.js → отчёт symbolicReport().
 */
export const SYMBOLIC_METRICS = [
  // --- форма ---
  { id: 'symbolic.form.sections', label: 'Секции', unit: 'count', range: [0, 32], target: '≥ 3', source: 'symbolic', version: 1 },
  { id: 'symbolic.form.minContrast', label: 'Мин. контраст соседних секций', unit: 'ratio', range: [0, 1], target: '≥ 0.25', source: 'symbolic', version: 1 },
  { id: 'symbolic.form.contrastMean', label: 'Средний контраст секций', unit: 'ratio', range: [0, 1], target: '≥ 0.4', source: 'symbolic', version: 1 },
  { id: 'symbolic.form.contrastMax', label: 'Максимальный контраст секций', unit: 'ratio', range: [0, 1], target: '≥ 0.6', source: 'symbolic', version: 1 },

  // --- энергия ---
  { id: 'symbolic.energy.correlation', label: 'Корреляция энергии с аркой', unit: 'ratio', range: [-1, 1], target: '≥ 0.7', source: 'symbolic', version: 1 },
  { id: 'symbolic.energy.range', label: 'Размах энергии', unit: 'ratio', range: [0, 1], target: '≥ 0.3', source: 'symbolic', version: 1 },
  { id: 'symbolic.energy.profileMean', label: 'Средняя энергия такта', unit: 'ratio', range: [0, 1], target: '—', source: 'symbolic', version: 1 },
  { id: 'symbolic.energy.profileStd', label: 'Разброс энергии по тактам', unit: 'ratio', range: [0, 1], target: '—', source: 'symbolic', version: 1 },
  { id: 'symbolic.energy.profileSlope', label: 'Наклон профиля энергии', unit: 'ratio', range: [-1, 1], target: '—', source: 'symbolic', version: 1 },

  // --- тональность ---
  { id: 'symbolic.tonality.scaleFit', label: 'Ноты мелодии в ладу', unit: 'ratio', range: [0, 1], target: '≥ 0.9', source: 'symbolic', version: 1 },
  { id: 'symbolic.tonality.harmonicFit', label: 'Ноты гармонии в ладу', unit: 'ratio', range: [0, 1], target: '—', source: 'symbolic', version: 1 },

  // --- мотив и фраза ---
  { id: 'symbolic.motif.count', label: 'Повторов мотива', unit: 'count', range: [0, 64], target: '≥ 3', source: 'symbolic', version: 1 },
  { id: 'symbolic.motif.sectionCount', label: 'Секций с мотивом', unit: 'count', range: [0, 32], target: '≥ 2', source: 'symbolic', version: 1 },
  { id: 'symbolic.motif.variations', label: 'Вариаций мотива', unit: 'count', range: [0, 32], target: '≥ 2', source: 'symbolic', version: 1 },
  { id: 'symbolic.motif.hook', label: 'Хук', unit: 'bool', range: [0, 1], target: '= 1', source: 'symbolic', version: 1 },
  { id: 'symbolic.phrase.closureRatio', label: 'Доля закрытых консеквентов', unit: 'ratio', range: [0, 1], target: '≥ 0.7', source: 'symbolic', version: 1 },
  { id: 'symbolic.phrase.openRatio', label: 'Доля открытых антецедентов', unit: 'ratio', range: [0, 1], target: '≥ 0.7', source: 'symbolic', version: 1 },
  { id: 'symbolic.phrase.count', label: 'Фраз', unit: 'count', range: [0, 128], target: '—', source: 'symbolic', version: 1 },

  // --- грув ---
  { id: 'symbolic.groove.bassKickLock', label: 'Связка бас–кик', unit: 'ratio', range: [0, 1], target: '≥ 0.6', source: 'symbolic', version: 1 },
  { id: 'symbolic.groove.microtimingStdMs', label: 'Разброс микротайминга', unit: 'ms', range: [0, 60], target: '12…25', source: 'symbolic', version: 1 },
  { id: 'symbolic.groove.microtimingMeanMs', label: 'Смещение микротайминга', unit: 'ms', range: [-30, 30], target: '≈ 0', source: 'symbolic', version: 1 },

  // --- плотность и разнообразие ---
  { id: 'symbolic.density.eventsPerSecond', label: 'Событий в секунду', unit: 'ev/s', range: [0, 60], target: 'жанр', source: 'symbolic', version: 1 },
  { id: 'symbolic.density.roleEntropy', label: 'Разнообразие ролей', unit: 'ratio', range: [0, 1], target: '—', source: 'symbolic', version: 1 },
  { id: 'symbolic.variation.ratio', label: 'Доля уникальных тактов', unit: 'ratio', range: [0, 1], target: '≥ 0.4', source: 'symbolic', version: 1 },
  { id: 'symbolic.kinetics.distinctVelocities', label: 'Разных velocity ударных', unit: 'count', range: [0, 32], target: '≥ 2', source: 'symbolic', version: 1 },

  // --- регистры ---
  { id: 'symbolic.register.bassSpan', label: 'Диапазон баса', unit: 'semitones', range: [0, 48], target: '—', source: 'symbolic', version: 1 },
  { id: 'symbolic.register.chordsSpan', label: 'Диапазон аккордов', unit: 'semitones', range: [0, 48], target: '—', source: 'symbolic', version: 1 },
  { id: 'symbolic.register.padSpan', label: 'Диапазон пада', unit: 'semitones', range: [0, 48], target: '—', source: 'symbolic', version: 1 },
  { id: 'symbolic.register.leadSpan', label: 'Диапазон лида', unit: 'semitones', range: [0, 48], target: '—', source: 'symbolic', version: 1 },
  { id: 'symbolic.register.arpSpan', label: 'Диапазон арпеджио', unit: 'semitones', range: [0, 48], target: '—', source: 'symbolic', version: 1 },

  // --- роли: сколько событий на такт ---
  { id: 'symbolic.role.perBar.kick', label: 'Кик на такт', unit: 'ev/bar', range: [0, 8], target: 'жанр', source: 'symbolic', version: 1 },
  { id: 'symbolic.role.perBar.snare', label: 'Малый барабан на такт', unit: 'ev/bar', range: [0, 8], target: 'жанр', source: 'symbolic', version: 1 },
  { id: 'symbolic.role.perBar.hats', label: 'Хэты на такт', unit: 'ev/bar', range: [0, 16], target: 'жанр', source: 'symbolic', version: 1 },
  { id: 'symbolic.role.perBar.bass', label: 'Бас на такт', unit: 'ev/bar', range: [0, 16], target: 'жанр', source: 'symbolic', version: 1 },
  { id: 'symbolic.role.perBar.chords', label: 'Аккорды на такт', unit: 'ev/bar', range: [0, 16], target: 'жанр', source: 'symbolic', version: 1 },
  { id: 'symbolic.role.perBar.lead', label: 'Лид на такт', unit: 'ev/bar', range: [0, 16], target: 'жанр', source: 'symbolic', version: 1 },
];

/**
 * Метрики уровня L0 — аудио: только то, что видно в отчёте о рендере.
 * Источник: src/audio/metrics-report.js → buildMetricsReport().
 * Считает браузер (или рендер-воркер); сервер принимает числа по форме (§2.5).
 */
export const AUDIO_METRICS = [
  { id: 'audio.lufsI', label: 'Громкость (интегрированная)', unit: 'LUFS', range: [-40, 0], target: '−14 ± 1', source: 'render', version: 1 },
  { id: 'audio.lufsS', label: 'Громкость (короткое окно)', unit: 'LUFS', range: [-40, 0], target: '—', source: 'render', version: 1 },
  { id: 'audio.truePeakDbtp', label: 'Истинный пик', unit: 'dBTP', range: [-40, 0], target: '≤ −1', source: 'render', version: 1 },
  { id: 'audio.peakDbfs', label: 'Пик сэмпла', unit: 'dBFS', range: [-40, 0], target: '—', source: 'render', version: 1 },
  { id: 'audio.crestDb', label: 'Крест-фактор', unit: 'dB', range: [0, 30], target: '—', source: 'render', version: 1 },
  { id: 'audio.clipCount', label: 'Клиппинг', unit: 'count', range: [0, 100000], target: '= 0', source: 'render', version: 1 },
  { id: 'audio.silenceInternal', label: 'Внутренняя тишина', unit: 's', range: [0, 120], target: '= 0', source: 'render', version: 1 },
];

/** Все метрики одним списком. */
export const METRICS = [...SYMBOLIC_METRICS, ...AUDIO_METRICS];

/** Метрики по id: быстрый доступ без поиска перебором. */
const BY_ID = new Map(METRICS.map((metric) => [metric.id, metric]));

/**
 * Метрика по id.
 * @param {string} id
 * @returns {object|null}
 */
export function metricById(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Все метрики источника.
 * @param {'symbolic'|'render'} source
 * @returns {Array<object>}
 */
export function metricsBySource(source) {
  return METRICS.filter((metric) => metric.source === source);
}

/**
 * Описание реестра — для документации и для проверки, что потребитель
 * ссылается на существующий id.
 * @returns {{version:number, count:number, metrics:Array}}
 */
export function describeRegistry() {
  return {
    version: REGISTRY_VERSION,
    count: METRICS.length,
    metrics: METRICS.map((metric) => ({ ...metric })),
  };
}

/**
 * Критерии символьного скора (составляющие, из которых складывается
 * число 0…100). Порядок и веса — как в src/oracle/score.js; здесь они
 * описаны ОДИН раз, чтобы отчёт и код не расходились.
 *
 * `key` — короткое имя, под которым критерий живёт в отчёте скора
 * (совместимость с UI), `id` — имя в реестре.
 *
 * `validated: false` — обязательное поле, а не украшение: пока вес не
 * сверен с человеческими парами, оптимизировать его нельзя (§2.8).
 */
export const SCORE_CRITERIA = [
  { id: 'score.form', key: 'form', label: 'Форма', weight: 20, describe: 'секций ≥ 3, соседние секции контрастны', validated: false },
  { id: 'score.energy', key: 'energy', label: 'Энергия', weight: 20, describe: 'профиль энергии совпадает с целевой кривой арки', validated: false },
  { id: 'score.motif', key: 'motif', label: 'Мотив и фраза', weight: 15, describe: 'мотив возвращается и варьируется, фразы закрываются', validated: false },
  { id: 'score.groove', key: 'groove', label: 'Грув', weight: 15, describe: 'бас с киком в lock, микротайминг живой', validated: false },
  { id: 'score.tonality', key: 'tonality', label: 'Тональность', weight: 10, describe: 'ноты внутри лада', validated: false },
  { id: 'score.density', key: 'density', label: 'Плотность', weight: 10, describe: 'плотность в рабочем диапазоне', validated: false },
  { id: 'score.variation', key: 'variation', label: 'Разнообразие', weight: 10, describe: 'такты не копируют друг друга', validated: false },
];

/**
 * Критерии аудио-блока (внутри блока рендера, сумма 100).
 * `check` — имя проверки в src/audio/qa.js.
 */
export const AUDIO_SCORE_CRITERIA = [
  { id: 'audio.score.repeatability', check: 'repeatability', label: 'Повторяемость рендера', weight: 25, validated: false },
  { id: 'audio.score.clipping', check: 'clipping', label: 'Отсутствие клиппинга', weight: 20, validated: false },
  { id: 'audio.score.truePeak', check: 'truePeak', label: 'True peak в потолке', weight: 20, validated: false },
  { id: 'audio.score.lufs', check: 'lufs', label: 'LUFS в коридоре', weight: 25, validated: false },
  { id: 'audio.score.silence', check: 'silence', label: 'Тишина', weight: 10, validated: false },
];

/**
 * Веса смешивания блоков скора (v1 — текстовый разбор, v2 — музыкальный
 * анализ, audio — рендер). Было: 0.6 / 0.4 и 0.8 / 0.2 «на глаз», в трёх
 * модулях. Теперь — здесь, с явным признаком «не проверено на людях».
 *
 * Замена на выученные веса допускается только если Taste Model прошёл
 * допуск (§7.4) — см. src/taste/cv.js → admitDecision().
 */
export const SCORE_COMBINE = {
  v1: { id: 'score.block.v1', label: 'Текстовый разбор', weight: 0.6, validated: false },
  v2: { id: 'score.block.v2', label: 'Музыкальный анализ', weight: 0.4, validated: false },
  audio: { id: 'score.block.audio', label: 'Рендер', weight: 0.2, validated: false },
};

/**
 * Проверяет, что все id критериев и блоков известны реестру.
 * Используется в тестах и в гейте: если кто-то добавит критерий мимо
 * реестра, гейт упадёт.
 * @returns {{ok:boolean, unknown:Array<string>}}
 */
export function validateRegistryLinks() {
  const unknown = [];
  for (const criterion of SCORE_CRITERIA) {
    if (!criterion.id.startsWith('score.')) unknown.push(criterion.id);
  }
  for (const block of Object.values(SCORE_COMBINE)) {
    if (!block.id.startsWith('score.')) unknown.push(block.id);
  }
  return { ok: unknown.length === 0, unknown };
}
