// Чтение библиотеки стилей, собранной из паспортов разбора (D-112).
//
// БИБЛИОТЕКА ЖИВЁТ РЯДОМ С КОДОМ: server/music/knowledge/mined/. Это
// единственное место, где лежат числа, извлечённые из глубоких разборов.
//
// ЧТО ПОПАДЁТ В ПРОМПТ. Только стили, где источников не меньше MIN_SOURCES:
// статистика по двум-трём трекам — это не «стиль», а выдумка. Редкий стиль
// помечается sparse и в промпт не идёт.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_SOURCES } from './aggregate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Каталог библиотеки по умолчанию. */
export const MINED_ROOT = path.resolve(HERE, '..', 'knowledge', 'mined');

/**
 * Каталог библиотеки: из окружения или по умолчанию.
 *
 * Через MINED_LIBRARY_DIR библиотеку можно указать сбоку — это нужно и
 * владельцу (своя папка разборов), и тестам (фикстура вместо пустой библиотеки).
 */
export function resolveMinedRoot() {
  const override = process.env.MINED_LIBRARY_DIR;
  return override ? path.resolve(override) : MINED_ROOT;
}

let cache = null;

/**
 * Загружает библиотеку (индекс + файлы стилей).
 *
 * @param {string} [root]
 * @returns {{index:object, styles:object}}
 */
export function loadMinedLibrary(root = resolveMinedRoot()) {
  if (cache && cache.root === root) return cache.value;
  const indexPath = path.join(root, 'index.json');
  let index = { sources: 0, styles: [], minSources: MIN_SOURCES };
  const styles = {};
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      index = { sources: 0, styles: [], minSources: MIN_SOURCES };
    }
  }
  for (const style of index.styles ?? []) {
    const stylePath = path.join(root, `${style}.json`);
    if (!existsSync(stylePath)) continue;
    try {
      styles[style] = JSON.parse(readFileSync(stylePath, 'utf8'));
    } catch {
      // Битый файл стиля — как его отсутствие: стиль просто не попадёт в промпт.
    }
  }
  const value = { index, styles };
  cache = { root, value };
  return value;
}

/** Сброс кэша (нужно тестам, которые подменяют каталог). */
export function resetMinedLibraryCache() {
  cache = null;
}

/**
 * Статистика стиля — только если стиль не редкий.
 * @param {string} style
 * @param {object} [library]
 * @returns {object|null}
 */
export function minedStats(style, library = loadMinedLibrary()) {
  const stats = library?.styles?.[style] ?? null;
  if (!stats) return null;
  if (stats.sparse || (stats.sources ?? 0) < MIN_SOURCES) return null;
  return stats;
}

/**
 * Текстовый блок для промпта композитора: числа, а не сэмплы.
 * @param {string} style
 * @param {object} [library]
 * @returns {string} пустая строка, если статистики нет
 */
export function minedDigest(style, library = loadMinedLibrary()) {
  const stats = minedStats(style, library);
  if (!stats) return '';
  const lines = [];
  const histogram = stats.groove?.onsetHistogram16;
  if (Array.isArray(histogram)) {
    lines.push(`- грув (${stats.sources} разборов): доля атак по долям [${histogram.map((value) => value.toFixed(3)).join(', ')}]`);
  }
  if (Number.isFinite(stats.groove?.swingRatio)) {
    lines.push(`- свинг: ${stats.groove.swingRatio.toFixed(3)}; вес бэкбита: ${Number(stats.groove.backbeatWeight ?? 0).toFixed(3)}`);
  }
  if (Number.isFinite(stats.bpm?.mean)) {
    lines.push(`- темп: средний ${stats.bpm.mean.toFixed(1)}, p25 ${Number(stats.bpm.p25 ?? 0).toFixed(1)}, p75 ${Number(stats.bpm.p75 ?? 0).toFixed(1)}`);
  }
  if (Array.isArray(stats.energy?.perSectionCurve)) {
    lines.push(`- энергия по секциям: [${stats.energy.perSectionCurve.map((value) => Number(value ?? 0).toFixed(2)).join(', ')}]`);
  }
  if (Number.isFinite(stats.contour?.entropy)) {
    lines.push(`- контур: энтропия ${stats.contour.entropy.toFixed(3)}, диапазон ${Number(stats.contour.rangeSemitones ?? 0).toFixed(1)} полутонов`);
  }
  return lines.length ? ['Измеренная статистика стиля (числа, не сэмплы):', ...lines].join('\n') : '';
}
