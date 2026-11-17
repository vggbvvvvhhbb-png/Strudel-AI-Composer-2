// Каталог Timbre Palette: asset-level реестр прав и его проверка (D-126).
//
// ЗАЧЕМ. Банки (sample-licenses.json) проверяются на уровне банка, и этого
// мало: у shabda:piano лицензия КАЖДОГО сэмпла своя. Новый каталог —
// релизный слой, поэтому права фиксируются до уровня файла:
//
//   sources (пакет) -> sample_assets (файл) -> instrument_presets -> sample_zones
//
// ПРАВИЛО. «Не нашёл запрета» ≠ «разрешено». Ассет без полной записи прав
// ломает механику реестра; ассет не approved блокирует публикацию.
// Пул «Охотника» (D-115) — локальный рабочий слой, он сюда не входит
// и релиз не блокирует.
//
// ИЗМЕРЕНИЯ. Паспорт ассета считается существующим модулем
// server/samples/passport.js (второй анализатор не пишется). Числовые
// измерения хранятся отдельно от семантических тегов; неизмеренное — null.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerTimbreCatalogLoader } from '../music/compiler/timbre-catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Каталог манифестов Timbre Palette (в git). */
export const TIMBRE_DIR = path.resolve(HERE, '..', 'music', 'data', 'timbre');
/**
 * Каталог с аудио каталога. OGG-пресеты — в git (D-130): Dockerfile копирует
 * этот каталог в образ, а CI собирает образ из чистого checkout. Банк-исходник
 * (originals/, WAV) остаётся вне git — он импортный, в рантайме не читается.
 */
export const TIMBRE_AUDIO_DIR = path.resolve(HERE, '..', '..', 'data', 'timbre', 'audio');

/** Alias пресета: только неймспейс tp_, строчные буквы/цифры/подчёркивание. */
export const ALIAS_RE = /^tp_[a-z0-9_]+$/;

/** Допустимые статусы прав ассета. */
export const RIGHTS_STATUSES = ['approved', 'pending', 'rejected'];

/** Лицензии, при которых ассет может быть approved (релизный слой). */
export const APPROVABLE_LICENSES = new Set(['cc0', 'cc-by']);

/** Обязательные поля прав ассета: без них запись — не запись, а опечатка. */
export const ASSET_RIGHTS_FIELDS = [
  'source', 'source_url', 'creator', 'license', 'license_url', 'licenseId',
  'checked_at', 'commercial_use', 'redistribution', 'derivatives', 'ai_use',
  'attribution', 'rights_status', 'sha256',
];

/** Обязательные поля источника (пакета). */
export const SOURCE_REQUIRED_FIELDS = [
  'name', 'source_url', 'creator', 'license', 'licenseId', 'license_url',
  'checked_at', 'commercial_use', 'redistribution', 'derivatives', 'ai_use',
  'rights_status',
];

/** Зарегистрированные синтезаторы (whitelist D-014) — для стража коллизий. */
export const SYNTH_NAMES = [
  'sawtooth', 'square', 'triangle', 'sine', 'supersaw', 'pulse', 'fm', 'am', 'organ',
];

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Читает каталог: источники, ассеты, пресеты, зоны.
 * @param {string} [dir]
 */
export function loadTimbreCatalog(dir = TIMBRE_DIR) {
  return {
    sources: readJson(path.join(dir, 'sources.json'), { sources: {} }).sources ?? {},
    assets: readJson(path.join(dir, 'assets.json'), { assets: {} }).assets ?? {},
    presets: readJson(path.join(dir, 'presets.json'), { presets: {} }).presets ?? {},
    zones: readJson(path.join(dir, 'zones.json'), { zones: [] }).zones ?? [],
  };
}

/**
 * Аудит каталога.
 *
 * Механика (ok): полнота записей, целостность ссылок, неймспейс alias.
 * Релиз (releaseBlocked): каждый ассет, на который ссылается пресет,
 * обязан быть approved. Пустой каталог релиз не блокирует — блокируют
 * только неподтверждённые права, а не отсутствие пресетов.
 *
 * @param {object} [catalog]
 * @param {{bankNames?: string[], synthNames?: string[]}} [options]
 */
export function auditTimbre(catalog = loadTimbreCatalog(), { bankNames = [], synthNames = SYNTH_NAMES } = {}) {
  const issues = [];
  const { sources, assets, presets, zones } = catalog;

  for (const [id, source] of Object.entries(sources)) {
    const gaps = SOURCE_REQUIRED_FIELDS.filter((field) => source[field] === undefined || source[field] === null || source[field] === '');
    if (gaps.length) issues.push({ kind: 'source-incomplete', detail: `${id}: нет ${gaps.join(', ')}` });
    if (source.rights_status && !RIGHTS_STATUSES.includes(source.rights_status)) {
      issues.push({ kind: 'source-status', detail: `${id}: неизвестный rights_status «${source.rights_status}»` });
    }
  }

  for (const [id, asset] of Object.entries(assets)) {
    const gaps = ASSET_RIGHTS_FIELDS.filter((field) => asset[field] === undefined || asset[field] === null || asset[field] === '');
    if (gaps.length) issues.push({ kind: 'asset-incomplete', detail: `${id}: нет ${gaps.join(', ')}` });
    if (!sources[asset.source]) {
      issues.push({ kind: 'asset-source-missing', detail: `${id}: источник «${asset.source}» не зарегистрирован` });
    }
    if (asset.rights_status && !RIGHTS_STATUSES.includes(asset.rights_status)) {
      issues.push({ kind: 'asset-status', detail: `${id}: неизвестный rights_status «${asset.rights_status}»` });
    }
    // Fail-closed: approved возможен только со свободной лицензией.
    if (asset.rights_status === 'approved' && !APPROVABLE_LICENSES.has(asset.licenseId)) {
      issues.push({ kind: 'asset-license', detail: `${id}: approved с лицензией «${asset.licenseId ?? '—'}» невозможен (только cc0/cc-by)` });
    }
  }

  const taken = new Set([...bankNames, ...synthNames].map((name) => String(name).toLowerCase()));
  const aliases = new Map();
  for (const [id, preset] of Object.entries(presets)) {
    for (const field of ['name', 'family', 'strudelAlias', 'version']) {
      if (!preset[field]) issues.push({ kind: 'preset-incomplete', detail: `${id}: нет ${field}` });
    }
    if (!Array.isArray(preset.roles) || !preset.roles.length) {
      issues.push({ kind: 'preset-incomplete', detail: `${id}: нет roles` });
    }
    const alias = String(preset.strudelAlias ?? '').toLowerCase();
    if (preset.strudelAlias && !ALIAS_RE.test(preset.strudelAlias)) {
      issues.push({ kind: 'alias-namespace', detail: `${id}: alias «${preset.strudelAlias}» вне неймспейса tp_` });
    }
    if (alias && taken.has(alias)) {
      issues.push({ kind: 'alias-collision', detail: `${id}: alias «${alias}» занят банком или синтезатором` });
    }
    if (alias && aliases.has(alias)) {
      issues.push({ kind: 'alias-duplicate', detail: `${id}: alias «${alias}» уже у пресета «${aliases.get(alias)}»` });
    }
    if (alias) aliases.set(alias, id);
  }

  const presetIds = new Set(Object.keys(presets));
  const assetIds = new Set(Object.keys(assets));
  const usedAssets = new Set();
  const zonesByPreset = new Map();
  for (const zone of zones) {
    if (!presetIds.has(zone.instrument_id)) {
      issues.push({ kind: 'zone-dangling', detail: `зона ссылается на несуществующий пресет «${zone.instrument_id}»` });
    }
    if (!assetIds.has(zone.asset_id)) {
      issues.push({ kind: 'zone-dangling', detail: `зона ссылается на несуществующий ассет «${zone.asset_id}»` });
    }
    if (!Number.isInteger(zone.root_key) || zone.root_key < 0 || zone.root_key > 127) {
      issues.push({ kind: 'zone-root', detail: `зона ${zone.instrument_id}/${zone.asset_id}: root_key вне 0..127` });
    }
    usedAssets.add(zone.asset_id);
    zonesByPreset.set(zone.instrument_id, (zonesByPreset.get(zone.instrument_id) ?? 0) + 1);
  }
  for (const id of presetIds) {
    if (!zonesByPreset.get(id)) {
      issues.push({ kind: 'preset-silent', detail: `${id}: пресет без зон — он молчит` });
    }
  }

  const unapprovedAssets = [...usedAssets]
    .filter((id) => assets[id] && assets[id].rights_status !== 'approved')
    .sort();

  const totals = {
    sources: Object.keys(sources).length,
    assets: Object.keys(assets).length,
    presets: Object.keys(presets).length,
    zones: zones.length,
    approvedAssets: Object.values(assets).filter((asset) => asset.rights_status === 'approved').length,
    usedAssets: usedAssets.size,
  };

  return {
    ok: issues.length === 0,
    issues,
    totals,
    unapprovedAssets,
    releaseBlocked: unapprovedAssets.length > 0,
  };
}

/**
 * Строка атрибуции ассета (TASL + Changes).
 *
 * Для CC-BY атрибуция обязательна; для CC0 кредит необязателен, но
 * происхождение сохраняется. Changes — что сделано с оригиналом
 * (например «Converted to OGG, trimmed technical silence»).
 *
 * @param {object} asset
 * @param {{changes?: string}} [options]
 * @returns {string}
 */
export function attributionForAsset(asset, { changes } = {}) {
  if (!asset) return 'Сэмпл: источник неизвестен';
  const name = asset.name ?? asset.id ?? 'без названия';
  const author = asset.creator ? ` by ${asset.creator}` : '';
  const license = asset.license ?? 'лицензия неизвестна';
  const source = asset.source_url ?? 'источник не указан';
  const base = `«${name}»${author} — ${license} — ${source}`;
  const changeNote = changes ?? asset.rights_notes_changes ?? null;
  return changeNote ? `${base} — Changes: ${changeNote}` : base;
}

/** Пресеты каталога, чьи alias встречаются в коде (в кавычках). */
export function presetsUsedInCode(code, catalog = loadTimbreCatalog()) {
  const text = String(code ?? '');
  const used = [];
  for (const [id, preset] of Object.entries(catalog.presets)) {
    const alias = preset.strudelAlias;
    if (!alias) continue;
    const quoted = new RegExp(`["']${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
    if (quoted.test(text)) used.push({ id, preset });
  }
  return used.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Строки атрибуции для экспорта трека/кода: только пресеты, которые
 * реально звучат в коде. CC-BY обязателен, CC0 — происхождение.
 *
 * @param {string} code
 * @param {object} [catalog]
 * @returns {string[]}
 */
export function attributionLinesForCode(code, catalog = loadTimbreCatalog()) {
  const lines = [];
  for (const { id, preset } of presetsUsedInCode(code, catalog)) {
    const zoneAssets = catalog.zones
      .filter((zone) => zone.instrument_id === id)
      .map((zone) => catalog.assets[zone.asset_id])
      .filter(Boolean);
    const unique = new Map();
    for (const asset of zoneAssets) {
      const key = asset.attribution ?? attributionForAsset(asset);
      if (!unique.has(key)) unique.set(key, asset);
    }
    for (const [line, asset] of unique) {
      const required = asset.licenseId === 'cc-by' ? 'обязательная атрибуция' : 'происхождение (CC0)';
      lines.push(`${preset.name ?? id}: ${line} [${required}]`);
    }
  }
  return lines;
}

/**
 * Отчёт каталога для API и ворот: аудит + публичные метаданные пресетов.
 * @param {object} [catalog]
 * @param {{bankNames?: string[]}} [options]
 */
export function timbreReport(catalog = loadTimbreCatalog(), options = {}) {
  const audit = auditTimbre(catalog, options);
  return {
    ok: audit.ok,
    releaseBlocked: audit.releaseBlocked,
    totals: audit.totals,
    issues: audit.issues,
    unapprovedAssets: audit.unapprovedAssets,
    presets: Object.entries(catalog.presets).map(([id, preset]) => ({
      id,
      name: preset.name,
      family: preset.family,
      roles: preset.roles ?? [],
      strudelAlias: preset.strudelAlias,
      tags: preset.tags ?? [],
      version: preset.version,
      timbreProfile: preset.timbreProfile ?? null,
    })),
  };
}

/**
 * Файл аудио каталога для same-origin раздачи (по образцу poolAudioFile, D-119).
 *
 * Доступ разрешён ТОЛЬКО к файлу, зарегистрированному в реестре за пресетом:
 * запись в каталоге — единственный пропуск, произвольные файлы каталога
 * (и тем более вне его) не читаются. Обход пути отвергается.
 *
 * @param {string} alias strudelAlias пресета
 * @param {string} file имя файла (например c4.ogg)
 * @param {{catalog?: object, audioDir?: string}} [options]
 * @returns {string|null} абсолютный путь или null
 */
export function timbreAudioFile(alias, file, { catalog = loadTimbreCatalog(), audioDir = TIMBRE_AUDIO_DIR } = {}) {
  if (typeof alias !== 'string' || typeof file !== 'string') return null;
  if (!/^[\w.-]+\.ogg$/.test(file)) return null;
  const preset = Object.values(catalog.presets).find((entry) => entry.strudelAlias === alias);
  if (!preset) return null;
  const relative = `${alias}/${file}`;
  const asset = Object.values(catalog.assets).find((entry) => entry.file === relative);
  if (!asset) return null;
  const base = path.resolve(audioDir);
  const full = path.resolve(base, relative);
  if (!full.startsWith(base + path.sep)) return null;
  return existsSync(full) ? full : null;
}

// Общий компилятор не имеет права импортировать node:fs (его тянет и
// браузер), поэтому серверный загрузчик каталога регистрируется здесь —
// при импорте этого модуля (D-128).
registerTimbreCatalogLoader(() => loadTimbreCatalog());