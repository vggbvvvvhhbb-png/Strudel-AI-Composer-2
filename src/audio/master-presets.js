// Пресеты мастер-цепочки по стилям.
//
// Значения — стартовые точки для приёмки, а не «научные» константы: их
// подбирают по метрикам (GR 1–3 дБ на пиках) и на слух. Поэтому у каждого
// пресета есть `source: 'project'` — измеренным коридором это не является.
//
// Правила, общие для пресетов:
//   - потолок лимитера −1 dBTP (приёмка по true peak, не по sample peak);
//   - lookahead 5 мс (окно 4–16 мс по §7);
//   - glue-компрессор мягкий: ratio ≤ 4, threshold −18…−24 дБ;
//   - полочные фильтры не трогают середину: ±3 дБ максимум.
//
// ИСКЛЮЧЕНИЕ — оркестр (D-121). Замер демо-оперы (SESSION_REPORT §1.4):
// общий порог −20 дБ жал 66-дорожечный оркестр примерно на 5 дБ — плотный
// микс постоянно сидел выше порога. Оркестровый пресет поднят по замеру:
// порог −7 дБ, ratio 4, makeup +1 дБ, потолок −1.2 dBTP.

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
  orchestral: {
    id: 'orchestral',
    label: 'Оркестр',
    source: 'project',
    params: {
      ceilingDb: -1.2,
      lookaheadMs: 5,
      comp: { thresholdDb: -7, ratio: 4, kneeDb: 6, attackMs: 30, releaseMs: 250, makeupDb: 1 },
      eq: { lowShelfHz: 90, lowShelfDb: 0, highShelfHz: 9000, highShelfDb: 0 },
    },
  },
};

/** Пресет по стилю; неизвестный стиль → нейтральный. */
export function masterPresetFor(style) {
  return MASTER_PRESETS[style] ?? MASTER_PRESETS.flat;
}

/** Стиль спека (`lo-fi`) → идентификатор пресета (`lofi`). */
const STYLE_ALIASES = { 'lo-fi': 'lofi', 'drum-and-bass': 'dnb' };

/**
 * Пресет мастера по коду трека.
 *
 * Стиль читается из первой строки компилятора (`// cinematic — 90 BPM, …`).
 * Оркестровый пресет включается, когда стиль cinematic/orchestral и партий
 * много (≥24): плотный оркестр нельзя жать порогом −20 дБ (D-121).
 * Малый cinematic-состав остаётся на обычном cinematic-пресете.
 *
 * @param {string} code
 * @returns {object} пресет из MASTER_PRESETS
 */
export function masterPresetForCode(code) {
  const text = String(code ?? '');
  const style = (/^[ \t]*\/\/[ \t]*([a-z-]+)/i.exec(text)?.[1] ?? '').toLowerCase();
  const parts = (text.match(/^[ \t]*[_S]?\$[ \t]*[A-Za-z]\w*[ \t]*:/gm) ?? []).length;
  if ((style === 'cinematic' || style === 'orchestral') && parts >= 24) {
    return MASTER_PRESETS.orchestral;
  }
  return masterPresetFor(STYLE_ALIASES[style] ?? style);
}
