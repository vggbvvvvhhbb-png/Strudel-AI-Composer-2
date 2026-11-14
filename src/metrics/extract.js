// Извлечение значений метрик по id (бриф §4.5).
//
// Это единственное место, где отчёт превращается в числа, пригодные для
// сравнения: символьный отчёт (src/oracle/report.js) и отчёт о рендере
// (src/audio/metrics-report.js) → значения метрик из реестра.
//
// Почему не размазывать по потребителям: потребитель — это истина о том,
// «какой признак важен». Такая истина живёт в коде дважды: в реестре
// (объявление) и здесь (измерение). Пока объявление и измерение рядом,
// переименование не ломает молча.
//
// Правило честности: метрика, которую посчитать нельзя, возвращает null,
// а не 0. Ноль — это измерение («ноль шансов», «ноль клиппинга»); null —
// «нечем измерить». Смешивать их нельзя: иначе отсутствие данных будет
// выглядеть как идеальный трек.

import { METRICS } from './registry.js';

/** Роли, для которых считаем события на такт. */
const ROLE_PER_BAR = ['kick', 'snare', 'hats', 'bass', 'chords', 'lead'];

/** Роли, для которых считаем диапазон регистра. */
const REGISTER_ROLES = ['bass', 'chords', 'pad', 'lead', 'arp'];

/**
 * Извлекатели: id метрики → функция (отчёт) → число | null.
 *
 * @type {Record<string, (report:object) => number|null>}
 */
export const EXTRACTORS = {
  // --- форма ---
  'symbolic.form.sections': (report) => num(report?.sections?.length),
  'symbolic.form.minContrast': (report) => num(report?.metrics?.minContrast),
  'symbolic.form.contrastMean': (report) => meanOf(report?.metrics?.sectionContrasts),
  'symbolic.form.contrastMax': (report) => {
    const list = report?.metrics?.sectionContrasts;
    return Array.isArray(list) && list.length ? num(Math.max(...list)) : null;
  },

  // --- энергия ---
  'symbolic.energy.correlation': (report) => num(report?.metrics?.energyCorrelation),
  'symbolic.energy.range': (report) => num(report?.metrics?.energyRange),
  'symbolic.energy.profileMean': (report) => meanOf(report?.metrics?.energyProfile),
  'symbolic.energy.profileStd': (report) => stdOf(report?.metrics?.energyProfile),
  'symbolic.energy.profileSlope': (report) => slopeOf(report?.metrics?.energyProfile),

  // --- тональность ---
  'symbolic.tonality.scaleFit': (report) => num(report?.metrics?.scaleFit),
  'symbolic.tonality.harmonicFit': (report) => num(report?.metrics?.harmonicFit),

  // --- мотив и фраза ---
  'symbolic.motif.count': (report) => num(report?.metrics?.motifRecurrence?.count),
  'symbolic.motif.sectionCount': (report) => num(report?.metrics?.motifRecurrence?.sectionCount),
  'symbolic.motif.variations': (report) => num(report?.metrics?.motifRecurrence?.variations),
  'symbolic.motif.hook': (report) => boolNum(report?.metrics?.motifRecurrence?.hook),
  'symbolic.phrase.closureRatio': (report) => num(report?.metrics?.phraseClosure?.closureRatio),
  'symbolic.phrase.openRatio': (report) => num(report?.metrics?.phraseClosure?.openRatio),
  'symbolic.phrase.count': (report) => num(report?.metrics?.phraseClosure?.count),

  // --- грув ---
  'symbolic.groove.bassKickLock': (report) => num(report?.metrics?.bassKickLock),
  'symbolic.groove.microtimingStdMs': (report) => num(report?.metrics?.microtiming?.stdMs),
  'symbolic.groove.microtimingMeanMs': (report) => num(report?.metrics?.microtiming?.meanMs),

  // --- плотность и разнообразие ---
  'symbolic.density.eventsPerSecond': (report) => num(report?.metrics?.density),
  'symbolic.density.roleEntropy': (report) => entropyOf(report?.metrics?.roleBalance),
  'symbolic.variation.ratio': (report) => num(report?.metrics?.variation?.ratio),
  'symbolic.kinetics.distinctVelocities': (report) => num(report?.kinetics?.distinctVelocities),

  // --- регистры ---
  'symbolic.register.bassSpan': (report) => spanOf(report, 'bass'),
  'symbolic.register.chordsSpan': (report) => spanOf(report, 'chords'),
  'symbolic.register.padSpan': (report) => spanOf(report, 'pad'),
  'symbolic.register.leadSpan': (report) => spanOf(report, 'lead'),
  'symbolic.register.arpSpan': (report) => spanOf(report, 'arp'),

  // --- роли на такт ---
  'symbolic.role.perBar.kick': (report) => perBar(report, 'kick'),
  'symbolic.role.perBar.snare': (report) => perBar(report, 'snare'),
  'symbolic.role.perBar.hats': (report) => perBar(report, 'hats'),
  'symbolic.role.perBar.bass': (report) => perBar(report, 'bass'),
  'symbolic.role.perBar.chords': (report) => perBar(report, 'chords'),
  'symbolic.role.perBar.lead': (report) => perBar(report, 'lead'),

  // --- аудио (L0) ---
  'audio.lufsI': (report) => num(report?.lufsI),
  'audio.lufsS': (report) => num(report?.lufsS),
  'audio.truePeakDbtp': (report) => num(report?.truePeakDbtp),
  'audio.peakDbfs': (report) => num(report?.peakDbfs),
  'audio.crestDb': (report) => num(report?.crestDb),
  'audio.clipCount': (report) => num(report?.clipCount),
  'audio.silenceInternal': (report) => num(report?.silence?.internal),
};

/**
 * Список id, для которых есть извлекатель.
 * @returns {Array<string>}
 */
export function extractableIds() {
  return Object.keys(EXTRACTORS);
}

/**
 * Извлекает значения метрик из отчёта.
 *
 * @param {object} report символьный отчёт или отчёт о рендере
 * @param {Array<string>} [ids] какие метрики нужны (по умолчанию все)
 * @returns {{values:Record<string, number|null>, missing:Array<string>}}
 */
export function extractMetrics(report, ids) {
  const wanted = ids && ids.length ? ids : extractableIds();
  const values = {};
  const missing = [];
  for (const id of wanted) {
    const extractor = EXTRACTORS[id];
    if (!extractor) {
      missing.push(id);
      values[id] = null;
      continue;
    }
    let value = null;
    try {
      value = extractor(report);
    } catch {
      value = null;
    }
    if (!Number.isFinite(value)) {
      missing.push(id);
      values[id] = null;
      continue;
    }
    values[id] = value;
  }
  return { values, missing };
}

/**
 * Сколько метрик реестра вообще извлекается — самопроверка полноты.
 * @returns {{registered:number, extractable:number, uncovered:Array<string>}}
 */
export function registryCoverage() {
  const uncovered = METRICS.map((metric) => metric.id).filter((id) => !EXTRACTORS[id]);
  return {
    registered: METRICS.length,
    extractable: METRICS.length - uncovered.length,
    uncovered,
  };
}

// --- вспомогательные ---

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolNum(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

function meanOf(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const values = list.filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdOf(list) {
  if (!Array.isArray(list) || list.length < 2) return null;
  const values = list.filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Наклон профиля (линейная регрессия по индексу), нормированный в [−1, 1].
 * Нормировка нужна, чтобы «наклон» можно было сравнивать с «корреляцией»
 * в одном векторе признаков.
 */
function slopeOf(list) {
  if (!Array.isArray(list) || list.length < 2) return null;
  const values = list.filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let num_ = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num_ += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  if (den === 0) return null;
  const slope = num_ / den;
  // Максимальный возможный |наклон| при значениях 0…1: (n−1)/2.
  const max = (n - 1) / 2;
  if (!max) return null;
  return Math.max(-1, Math.min(1, slope / max));
}

/** Нормированная энтропия распределения по ролям: 0 = одна роль, 1 = все. */
function entropyOf(balance) {
  if (!balance || typeof balance !== 'object') return null;
  const values = Object.values(balance).filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  let entropy = 0;
  for (const value of values) {
    const p = value / total;
    entropy -= p * Math.log(p);
  }
  const max = Math.log(values.length);
  return max > 0 ? Math.max(0, Math.min(1, entropy / max)) : 0;
}

/** Диапазон регистра роли в полутонах. */
function spanOf(report, role) {
  const entry = report?.registers?.[role];
  if (!entry || !Number.isFinite(entry.min) || !Number.isFinite(entry.max)) return null;
  return Math.max(0, entry.max - entry.min);
}

/** Событий роли на такт. */
function perBar(report, role) {
  const count = report?.metrics?.roleCounts?.[role];
  const bars = report?.bars ?? report?.metrics?.bars;
  if (!Number.isFinite(count) || !Number.isFinite(bars) || bars <= 0) return null;
  return count / bars;
}
