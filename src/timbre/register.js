// Регистрация и прогрев пресетов Timbre Palette в браузере (D-128).
//
// Манифест ≠ загруженные файлы: samples(map) регистрирует имена, а сами
// OGG superdough грузит лениво при первом триггере. Поэтому перед первым
// звуком конкретного пресета его файлы прогреваются публичным loadBuffer
// (через адаптер). Прогреваем ТОЛЬКО пресеты, которые звучат в коде, и
// все их root-ноты (4–5 файлов на пресет, не всю коллекцию).
//
// Отказ загрузки пресета — ошибка, а не тихая подмена синтезатором:
// пользователь просил конкретный инструмент (образец D-119 poolSamples).

import { registerTimbreCatalogLoader } from '../../server/music/compiler/timbre-catalog.js';

let catalogPromise = null;
let catalogValue = null;
let registeredBase = null;

/** Ленивая загрузка каталога (не в основном чанке). */
export function fetchTimbreCatalog({ force = false } = {}) {
  if (catalogPromise && !force) return catalogPromise;
  catalogPromise = fetch('/api/timbre/catalog')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((body) => {
      catalogValue = body;
      return body;
    })
    .catch((error) => {
      catalogPromise = null;
      throw error;
    });
  return catalogPromise;
}

// Компилятор спеки общий с сервером и не читает файлы сам: в браузере
// каталог приходит по API. Пока каталог не загружен, компиляция партии
// с instrumentId — честная ошибка (fail-closed).
registerTimbreCatalogLoader(() => {
  if (!catalogValue) {
    throw new Error('Каталог Timbre ещё не загружен: сначала fetchTimbreCatalog()');
  }
  return { presets: Object.fromEntries((catalogValue.presets ?? []).map((preset) => [preset.id, preset])) };
});

/** Alias пресетов каталога, которые встречаются в коде (в кавычках). */
export function timbreAliasesInCode(code, catalog) {
  const text = String(code ?? '');
  const aliases = [];
  for (const preset of catalog?.presets ?? []) {
    const alias = preset.strudelAlias;
    if (!alias) continue;
    const quoted = new RegExp(`["']${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
    if (quoted.test(text)) aliases.push(alias);
  }
  return aliases.sort();
}

/** URL файлов пресета из Strudel-карты каталога. */
export function timbreUrlsForAlias(alias, catalog) {
  const map = catalog?.sampleMap ?? {};
  const base = map._base ?? '/timbre-audio/';
  const entries = map[alias];
  if (!entries || typeof entries !== 'object') return [];
  return Object.values(entries)
    .filter((file) => typeof file === 'string')
    .map((file) => (file.startsWith('http') || file.startsWith('/') ? file : base + file));
}

/**
 * Регистрирует карту каталога и прогревает пресеты, звучащие в коде.
 *
 * @param {string} code
 * @param {object} adapter адаптер движка (loadSamples/warmSamples)
 * @param {object|null} [catalogOverride] готовый каталог (realm получает его
 *   от родителя: свежий iframe не должен ходить в /api на каждый рендер —
 *   глобальный лимитер 20 req/min иначе ловит 429 на тембровых парах)
 * @returns {Promise<{ok:boolean, used:string[], warmed:number, errors:string[]}>}
 */
export async function ensureTimbreForCode(code, adapter, catalogOverride = null) {
  const catalog = catalogOverride ?? await fetchTimbreCatalog();
  const used = timbreAliasesInCode(code, catalog);
  if (!used.length) return { ok: true, used: [], warmed: 0, errors: [] };

  const map = catalog.sampleMap ?? {};
  if (registeredBase !== JSON.stringify(map)) {
    const loaded = await adapter.loadSamples({ sources: [map] });
    if (!loaded.ok || loaded.failed) {
      return { ok: false, used, warmed: 0, errors: loaded.errors ?? ['карта пресетов не зарегистрировалась'] };
    }
    registeredBase = JSON.stringify(map);
  }

  const urls = used.flatMap((alias) => timbreUrlsForAlias(alias, catalog));
  const warmed = await adapter.warmSamples(urls);
  if (!warmed.ok) {
    return {
      ok: false,
      used,
      warmed: warmed.total - warmed.failed,
      errors: warmed.errors ?? [],
    };
  }
  return { ok: true, used, warmed: warmed.total, errors: [] };
}