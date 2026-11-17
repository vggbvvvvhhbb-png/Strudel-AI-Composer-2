// Timbre Resolver v1 (D-128): детерминированный подбор пресета под партию.
//
// Каскад, без ML и без эмбеддингов:
//   1. Жёсткий фильтр: роль/семейство, перекрытие диапазона партии с
//      зонами пресета, rights_status=approved у ВСЕХ ассетов пресета.
//   2. Текстовое соответствие: timbreProfile и теги пресета, стиль трека.
//   3. Ранжирование по DSP-дескрипторам паспорта (центроид и др.):
//      «тёплый» — ниже центроид, «яркий» — выше. Числа — измерения,
//      профиль — интерпретация; они хранятся раздельно (D-126).
//
// Скор детерминирован и воспроизводим по входу. Каждый кандидат несёт
// обоснование: какие фильтры и числа сработали. «Басовый one-shot вместо
// пианино» невозможен: роль и диапазон — жёсткие фильтры, а не веса.

import { loadTimbreCatalog } from './timbre.js';

/** Целевые центроиды профилей (Гц) — интерпретация, калибруется по корпусу. */
const PROFILE_CENTROID = { warm: 1200, bright: 2600, dark: 600, soft: 900 };

/** Семейства, близкие стилю (детерминированная эвристика, не обучение). */
const STYLE_FAMILY_AFFINITY = {
  'lo-fi': ['keys'],
  jazz: ['keys', 'bass'],
  cinematic: ['strings', 'keys'],
  ambient: ['strings', 'keys'],
  house: ['keys', 'bass'],
  techno: ['keys', 'bass'],
  synthwave: ['keys'],
  trap: ['bass'],
  dubstep: ['bass'],
  rock: ['keys', 'bass'],
};

/** Допустимый питч-шифт от ближайшего root (полутоны): дальше слышны артефакты. */
const PLAYABLE_MARGIN = 6;

/** Покрытие пресета нотами: root-ноты зон ± допустимый шифт (не 0..127). */
function presetCoverage(presetId, catalog) {
  const zones = catalog.zones.filter((zone) => zone.instrument_id === presetId);
  if (!zones.length) return null;
  const roots = zones.map((zone) => zone.root_key).sort((a, b) => a - b);
  return {
    low: Math.max(0, roots[0] - PLAYABLE_MARGIN),
    high: Math.min(127, roots[roots.length - 1] + PLAYABLE_MARGIN),
    roots,
  };
}

/** Все ассеты пресета approved? (релизный слой, fail-closed) */
function presetApproved(presetId, catalog) {
  const assetIds = catalog.zones
    .filter((zone) => zone.instrument_id === presetId)
    .map((zone) => zone.asset_id);
  if (!assetIds.length) return false;
  return assetIds.every((id) => catalog.assets[id]?.rights_status === 'approved');
}

/**
 * Подбор пресетов под партию.
 *
 * @param {{role?: string, family?: string, range?: [number, number],
 *          profile?: string, style?: string, limit?: number}} query
 *   range — MIDI-ноты партии [min, max] из событий/паттерна.
 * @param {object} [catalog]
 * @returns {Array<{id, name, strudelAlias, family, roles, score, reasons, descriptor}>}
 */
export function resolveTimbre(query = {}, catalog = loadTimbreCatalog()) {
  const { role = null, family = null, range = null, profile = null, style = null } = query;
  const limit = Math.max(1, Math.min(5, query.limit ?? 5));
  const candidates = [];

  for (const [id, preset] of Object.entries(catalog.presets)) {
    const reasons = [];

    // --- 1. Жёсткие фильтры ---
    if (role && !(preset.roles ?? []).includes(role)) continue;
    if (family && preset.family !== family) continue;
    if (!presetApproved(id, catalog)) {
      continue; // неapproved не предлагается даже как кандидат
    }
    const coverage = presetCoverage(id, catalog);
    if (!coverage) continue;
    if (range) {
      const [low, high] = range;
      if (high < coverage.low || low > coverage.high) continue;
      reasons.push(`диапазон партии ${low}..${high} перекрыт покрытием пресета ${coverage.low}..${coverage.high} (root-ноты ${coverage.roots.join(', ')})`);
    }
    if (role) reasons.push(`роль «${role}» есть у пресета`);

    // --- 2. Текстовое соответствие ---
    let score = 1; // прошёл жёсткие фильтры
    const tags = preset.tags ?? [];
    if (profile) {
      if (preset.timbreProfile === profile) {
        score += 2;
        reasons.push(`профиль «${profile}» совпал с timbreProfile пресета`);
      } else if (tags.includes(profile)) {
        score += 1;
        reasons.push(`тег «${profile}» есть у пресета`);
      }
    }
    if (style) {
      if (tags.includes(style)) {
        score += 1;
        reasons.push(`тег стиля «${style}»`);
      } else if ((STYLE_FAMILY_AFFINITY[style] ?? []).includes(preset.family)) {
        score += 0.5;
        reasons.push(`семейство ${preset.family} близко стилю «${style}»`);
      }
    }

    // --- 3. DSP-ранжирование по паспорту ---
    const descriptor = preset.descriptor ?? null;
    const centroid = descriptor?.spectral?.centroidHz ?? null;
    if (profile && PROFILE_CENTROID[profile] !== undefined && centroid !== null) {
      const target = PROFILE_CENTROID[profile];
      // Близость центроида к целевому: 1 при совпадении, спадает с расстоянием.
      const proximity = Math.max(0, 1 - Math.abs(centroid - target) / Math.max(target, 1));
      score += proximity;
      reasons.push(`центроид ${Math.round(centroid)} Гц против цели ${target} Гц (профиль «${profile}»): +${proximity.toFixed(2)}`);
    } else if (centroid !== null) {
      reasons.push(`центроид ${Math.round(centroid)} Гц (измерение паспорта)`);
    } else {
      reasons.push('центроид: нет данных (паспорт не измерен)');
    }

    candidates.push({
      id,
      name: preset.name,
      strudelAlias: preset.strudelAlias,
      family: preset.family,
      roles: preset.roles ?? [],
      timbreProfile: preset.timbreProfile ?? null,
      score: Number(score.toFixed(3)),
      reasons,
      descriptor: descriptor ? {
        centroidHz: descriptor.spectral?.centroidHz ?? null,
        lufsI: descriptor.loudness?.lufsI ?? null,
        durationS: descriptor.durationS ?? null,
        character: descriptor.character ?? null,
      } : null,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return candidates.slice(0, limit);
}