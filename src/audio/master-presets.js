// Пресеты мастер-цепочки по стилям.
//
// Значения — стартовые точки для приёмки, а не «научные» константы: их
// подбирают по метрикам (GR 1–3 дБ на пиках) и на слух. Поэтому у каждого
// пресета есть `source: 'project'` — измеренным коридором это не является.
//
// Правила, общие для всех пресетов:
//   - потолок лимитера −1 dBTP (приёмка по true peak, не по sample peak);
//   - lookahead 5 мс (окно 4–16 мс по §7);
//   - glue-компрессор мягкий: ratio ≤ 4, threshold −18…−24 дБ;
//   - полочные фильтры не трогают середину: ±3 дБ максимум.

export const MASTER_PRESETS = {
  flat: {
    id: 'flat',
    label: 'Нейтральный',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      comp: { thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 20, releaseMs: 200 },
      eq: { lowShelfHz: 120, lowShelfDb: 0, highShelfHz: 8000, highShelfDb: 0 },
    },
  },
  lofi: {
    id: 'lofi',
    label: 'Lo-fi',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      comp: { thresholdDb: -22, ratio: 3, kneeDb: 6, attackMs: 25, releaseMs: 220 },
      // Тёплый низ, чуть приглушённая верха: у lo-fi верх обычно мягкий.
      eq: { lowShelfHz: 160, lowShelfDb: 1.5, highShelfHz: 7000, highShelfDb: -1 },
    },
  },
  techno: {
    id: 'techno',
    label: 'Techno',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      comp: { thresholdDb: -20, ratio: 3, kneeDb: 4, attackMs: 15, releaseMs: 180 },
      eq: { lowShelfHz: 100, lowShelfDb: 1, highShelfHz: 9000, highShelfDb: 1 },
    },
  },
  house: {
    id: 'house',
    label: 'House',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      comp: { thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 20, releaseMs: 200 },
      eq: { lowShelfHz: 120, lowShelfDb: 0.5, highShelfHz: 8000, highShelfDb: 0.5 },
    },
  },
  ambient: {
    id: 'ambient',
    label: 'Ambient',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      // Мягче glue: у эмбиентных треков динамика и так широкая.
      comp: { thresholdDb: -24, ratio: 2, kneeDb: 8, attackMs: 40, releaseMs: 300 },
      eq: { lowShelfHz: 100, lowShelfDb: -0.5, highShelfHz: 10000, highShelfDb: 1 },
    },
  },
  dnb: {
    id: 'dnb',
    label: 'Drum & Bass',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      comp: { thresholdDb: -18, ratio: 3, kneeDb: 4, attackMs: 15, releaseMs: 180 },
      eq: { lowShelfHz: 90, lowShelfDb: 1, highShelfHz: 9000, highShelfDb: 0.5 },
    },
  },
  synthwave: {
    id: 'synthwave',
    label: 'Synthwave',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      comp: { thresholdDb: -19, ratio: 3.5, kneeDb: 5, attackMs: 20, releaseMs: 200 },
      eq: { lowShelfHz: 110, lowShelfDb: 0.5, highShelfHz: 9000, highShelfDb: 1.5 },
    },
  },
  trap: {
    id: 'trap',
    label: 'Trap',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      comp: { thresholdDb: -18, ratio: 4, kneeDb: 4, attackMs: 10, releaseMs: 160 },
      eq: { lowShelfHz: 80, lowShelfDb: 1, highShelfHz: 11000, highShelfDb: 1.5 },
    },
  },
  jazz: {
    id: 'jazz',
    label: 'Jazz',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      // Минимум компрессии: у джаза важен динамический разброс.
      comp: { thresholdDb: -24, ratio: 2, kneeDb: 8, attackMs: 40, releaseMs: 300 },
      eq: { lowShelfHz: 120, lowShelfDb: 0, highShelfHz: 8000, highShelfDb: 0.5 },
    },
  },
  rock: {
    id: 'rock',
    label: 'Rock',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      comp: { thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 20, releaseMs: 200 },
      eq: { lowShelfHz: 110, lowShelfDb: 0.5, highShelfHz: 8000, highShelfDb: 1 },
    },
  },
  cinematic: {
    id: 'cinematic',
    label: 'Cinematic',
    source: 'project',
    params: {
      ceilingDb: -1,
      lookaheadMs: 5,
      comp: { thresholdDb: -21, ratio: 3, kneeDb: 6, attackMs: 30, releaseMs: 250 },
      eq: { lowShelfHz: 90, lowShelfDb: 1, highShelfHz: 9000, highShelfDb: 0.5 },
    },
  },
};

/** Пресет по стилю; неизвестный стиль → нейтральный. */
export function masterPresetFor(style) {
  return MASTER_PRESETS[style] ?? MASTER_PRESETS.flat;
}
