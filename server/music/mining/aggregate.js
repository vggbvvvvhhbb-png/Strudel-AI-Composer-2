// Фичи паспортов → библиотека стилей (D-112).
//
// ПРАВИЛА АГРЕГАЦИИ.
//   1. В библиотеку попадают только распределения, гистограммы, средние и
//      квантили. Никаких нотных последовательностей: из источника не
//      переносится даже тройка подряд идущих высот (страж `melodyLeak`).
//   2. Стилю нужно не меньше MIN_SOURCES источников, иначе он помечается
//      `sparse: true` и в промпт композитора не попадает: вывод по двум
//      трекам — это не «стиль», а выдумка.
//   3. Сборка идемпотентна: тот же вход даёт тот же JSON (ключи отсортированы,
//      числа округлены). Иначе библиотека дрожала бы от запуска к запуску.
//
// ЧЕСТНОСТЬ. Пустой вход даёт пустую библиотеку и честную запись о числе
// источников. Ничего не добирается синтетикой.

/** Минимум источников, чтобы стиль считался стилем. */
export const MIN_SOURCES = 5;

/**
 * Страж: в библиотеке нет нотных последовательностей.
 *
 * Проверяем структуру: ни один раздел библиотеки не должен содержать
 * массивов высот или времён нот. Допустимы только числа-агрегаты.
 *
 * @param {object} library
 * @returns {{ok:boolean, reason:string|null}}
 */
export function melodyLeak(library) {
  const forbidden = ['notes', 'midi', 'pitches', 'heights', 'melody', 'sequence'];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      // Массив чисел — это агрегат (гистограмма, кривая). Массив объектов с
      // нотными полями — утечка.
      for (const item of node) {
        if (item && typeof item === 'object') {
          const found = walk(item, path);
          if (found) return found;
        }
      }
      return null;
    }
    if (!node || typeof node !== 'object') return null;
    for (const [key, value] of Object.entries(node)) {
      if (forbidden.includes(key)) return `${path}.${key}`;
      const found = walk(value, `${path}.${key}`);
      if (found) return found;
    }
    return null;
  };
  const found = walk(library, 'library');
  return found
    ? { ok: false, reason: `в библиотеке есть последовательность нот: ${found}` }
    : { ok: true, reason: null };
}

/**
 * Среднее по списку чисел; null, если значений нет.
 * @param {number[]} values
 * @returns {number|null}
 */
function mean(values) {
  const list = values.filter(Number.isFinite);
  if (!list.length) return null;
  return Number((list.reduce((sum, value) => sum + value, 0) / list.length).toFixed(6));
}

/**
 * Квантиль списка чисел.
 * @param {number[]} values
 * @param {number} q
 * @returns {number|null}
 */
function quantile(values, q) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const position = (list.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return Number(list[lower].toFixed(6));
  const value = list[lower] + (list[upper] - list[lower]) * (position - lower);
  return Number(value.toFixed(6));
}

/**
 * Среднее по двум гистограммам одинаковой длины.
 * @param {number[][]} histograms
 * @returns {number[]|null}
 */
function averageHistogram(histograms) {
  const usable = histograms.filter((item) => Array.isArray(item) && item.length);
  if (!usable.length) return null;
  const length = usable[0].length;
  const same = usable.filter((item) => item.length === length);
  if (!same.length) return null;
  const result = new Array(length).fill(0);
  for (const histogram of same) {
    for (let i = 0; i < length; i += 1) result[i] += histogram[i];
  }
  const total = same.length;
  const averaged = result.map((value) => Number((value / total).toFixed(6)));
  const diff = Number((1 - averaged.reduce((sum, value) => sum + value, 0)).toFixed(6));
  averaged[0] = Number((averaged[0] + diff).toFixed(6));
  return averaged;
}

/**
 * Сводит фичи одного стиля в статистику.
 * @param {object[]} features
 * @returns {object}
 */
export function aggregateStyle(features) {
  const list = Array.isArray(features) ? features : [];
  const bpms = list.map((item) => item?.bpm).filter(Number.isFinite);
  const swings = list.map((item) => item?.groove?.swingRatio).filter(Number.isFinite);
  const backbeats = list.map((item) => item?.groove?.backbeatWeight).filter(Number.isFinite);
  const entropies = list.map((item) => item?.contour?.entropy).filter(Number.isFinite);
  const ranges = list.map((item) => item?.contour?.rangeSemitones).filter(Number.isFinite);
  const pauses = list.map((item) => item?.contour?.pauseShare).filter(Number.isFinite);
  const peaks = list.map((item) => item?.energy?.peakPosition).filter(Number.isFinite);

  const curves = list
    .map((item) => item?.energy?.perSectionCurve)
    .filter((curve) => Array.isArray(curve) && curve.length);
  const curveLength = curves.length ? curves[0].length : 0;
  const perSection = curveLength
    ? new Array(curveLength).fill(0).map((_, index) => {
      const values = curves.filter((curve) => curve.length === curveLength)
        .map((curve) => curve[index]);
      return mean(values);
    })
    : null;

  const intervalTotals = {};
  for (const item of list) {
    const distribution = item?.contour?.intervalDistribution;
    if (!distribution || typeof distribution !== 'object') continue;
    for (const [step, share] of Object.entries(distribution)) {
      intervalTotals[step] = (intervalTotals[step] ?? 0) + Number(share);
    }
  }
  const intervalCount = list.filter((item) => item?.contour?.intervalDistribution).length;
  const intervalDistribution = intervalCount
    ? Object.fromEntries(Object.keys(intervalTotals).sort((a, b) => Number(a) - Number(b))
      .map((step) => [step, Number((intervalTotals[step] / intervalCount).toFixed(6))]))
    : null;

  const centroids = {};
  for (const item of list) {
    for (const [role, descriptor] of Object.entries(item?.timbre?.byRole ?? {})) {
      const value = Number(descriptor?.centroidHz);
      if (!Number.isFinite(value)) continue;
      (centroids[role] ??= []).push(value);
    }
  }

  return {
    sources: list.length,
    sparse: list.length < MIN_SOURCES,
    bpm: {
      mean: mean(bpms),
      p25: quantile(bpms, 0.25),
      p75: quantile(bpms, 0.75),
    },
    groove: {
      onsetHistogram16: averageHistogram(list.map((item) => item?.groove?.onsetHistogram16)),
      swingRatio: mean(swings),
      backbeatWeight: mean(backbeats),
    },
    contour: {
      intervalDistribution,
      entropy: mean(entropies),
      rangeSemitones: mean(ranges),
      pauseShare: mean(pauses),
    },
    energy: {
      perSectionCurve: perSection,
      peakPosition: mean(peaks),
    },
    timbre: {
      centroidHzByRole: Object.fromEntries(Object.keys(centroids).sort()
        .map((role) => [role, mean(centroids[role])])),
    },
  };
}

/**
 * Собирает библиотеку из фичей.
 *
 * @param {object[]} features фичи, у каждой есть style
 * @returns {{index:object, styles:object}}
 */
export function buildLibrary(features) {
  const list = Array.isArray(features) ? features : [];
  const byStyle = {};
  for (const item of list) {
    const style = item?.style;
    if (!style) continue;
    (byStyle[style] ??= []).push(item);
  }
  const styles = {};
  for (const style of Object.keys(byStyle).sort()) {
    styles[style] = aggregateStyle(byStyle[style]);
  }
  const index = {
    schemaVersion: '1.0',
    sources: list.length,
    styles: Object.keys(styles),
    minSources: MIN_SOURCES,
    note: 'библиотека собрана из измеренных паспортов разбора; нотные последовательности не переносятся',
  };
  return { index, styles };
}

/**
 * Проверяет библиотеку стражем и возвращает её либо причину отказа.
 * @param {object} library
 * @returns {{ok:boolean, reason:string|null}}
 */
export function verifyLibrary(library) {
  return melodyLeak(library);
}
