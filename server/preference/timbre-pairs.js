// Тембровые пары для суждения (этап 4 сессии Timbre Palette, D-132).
//
// Пара = ОДНА И ТА ЖЕ партия (ноты, ритм, темп, гармония, структура)
// с двумя разными instrumentId из каталога Timbre Palette. Меняется
// только источник звука — инвариант D-128 проверяется здесь же:
// коды сторон обязаны совпадать после замены alias одного пресета
// на alias другого (никаких других отличий быть не может).
//
// Очередь детерминирована: состав пар, стороны и повторы — функции
// индекса, не PRNG. Случайная панорама при показе — на клиенте
// (src/tinder.js), как и у трековых пар.
//
// Метки тембровых пар НЕ входят в счётчики человеческого гейта
// композиции (≥50 промтов / ≥60 пар для Taste Model): это суждение
// о тембре, а не о композиции. Разделение — по type в реестре пар
// (server/preference/ledger.js) и pairType в метке.

import { compileTrackSpec } from '../music/compiler/index.js';
import { validateTrackSpec } from '../../src/schemas/track-spec.schema.js';
// Импорт регистрирует загрузчик каталога для общего компилятора (D-128).
import { loadTimbreCatalog } from '../samples/timbre.js';
import { presetApproved } from '../samples/timbre-resolver.js';
import { hashCode, upsertPair } from './ledger.js';

/** Семейства каталога → русская подпись для контекста рецензента. */
export const FAMILY_LABELS = { keys: 'клавишные', strings: 'струнные', bass: 'бас' };

/** Стили контекста: по одному на круг, чтобы суждение не скатывалось в один жанр. */
const STYLES = ['lo-fi', 'cinematic', 'ambient', 'jazz', 'house'];

/** Тональности и гармония контекста (детерминированный выбор по зерну). */
const KEYS = [
  { key: 'Cmin', harmony: 'Cm Ab' },
  { key: 'Amin', harmony: 'Am F' },
  { key: 'Dmin', harmony: 'Dm Bb' },
  { key: 'Gmin', harmony: 'Gm Eb' },
  { key: 'Emin', harmony: 'Em C' },
];

/** Рисунок партии по роли: один и тот же для обеих сторон пары. */
const ROLE_PATTERNS = {
  chords: '0 2 4 6',
  lead: '0 2 4 2 5 4 2 0',
  bass: '0 ~ 0 ~ 4 ~ 3 ~',
  pad: '0 4 7 ~',
  arp: '0 2 4 7 4 2',
  sub: '0 ~ ~ ~',
  texture: '0 ~ 4 ~',
};

/**
 * Комбинации пресетов для пар: два approved-пресета одного семейства
 * с общей ролью (партия должна быть играбельна обоими). Порядок
 * детерминирован — по id пресетов.
 *
 * @param {object} [catalog]
 * @returns {Array<{a:string, b:string, family:string, role:string}>}
 */
export function timbreCombos(catalog = loadTimbreCatalog()) {
  const presets = Object.entries(catalog.presets)
    .filter(([id]) => presetApproved(id, catalog))
    .map(([id, preset]) => ({ id, ...preset }))
    .sort((x, y) => x.id.localeCompare(y.id));
  const combos = [];
  for (let i = 0; i < presets.length; i += 1) {
    for (let j = i + 1; j < presets.length; j += 1) {
      const a = presets[i];
      const b = presets[j];
      if (a.family !== b.family) continue;
      const shared = (a.roles ?? []).filter((role) => (b.roles ?? []).includes(role));
      if (!shared.length) continue;
      combos.push({ a: a.id, b: b.id, family: a.family, role: shared[0] });
    }
  }
  return combos;
}

/** Базовая спека контекста: одна тональная партия, две секции, без override.
 * 16 тактов — минимум компилятора (MIN_BARS); тиндер рендерит первые 8. */
function baseSpec({ role, style, seed }) {
  const tonality = KEYS[seed % KEYS.length];
  return validateTrackSpec({
    meta: { style, bpm: 84 + (seed % 4) * 12, key: tonality.key },
    structure: {
      sections: [
        { name: 'intro', cycles: 4, energy: 0.4, harmony: tonality.harmony },
        { name: 'verse', cycles: 12, energy: 0.65, harmony: tonality.harmony },
      ],
    },
    parts: {
      roles: {
        TIMBRE_1: {
          role,
          activeIn: ['intro', 'verse'],
          pattern: ROLE_PATTERNS[role] ?? '0 2 4 6',
          sound: 'sine',
        },
      },
    },
  });
}

/**
 * Очередь тембровых пар. Механика повторов и перестановки сторон —
 * образец buildQueue: каждая десятая пара повторяет пару index−9
 * с переставленными сторонами (надёжность рецензента).
 *
 * @param {{limit?: number, offset?: number, catalog?: object}} [options]
 * @returns {Array<object>}
 */
export function buildTimbreQueue({ limit = 10, offset = 0, catalog = loadTimbreCatalog() } = {}) {
  const count = Math.max(1, Math.min(60, Number(limit) || 10));
  const from = Math.max(0, Number(offset) || 0);
  const combos = timbreCombos(catalog);
  if (!combos.length) return []; // пустой каталог — честно пустая очередь

  const pairs = [];
  for (let index = from; index < from + count; index += 1) {
    const isRepeat = index % 10 === 9;
    const sourceIndex = isRepeat ? index - 9 : index;
    const combo = combos[sourceIndex % combos.length];
    const lap = Math.floor(sourceIndex / combos.length);
    const seed = 5000 + lap * 7919 + (sourceIndex % combos.length);
    const style = STYLES[sourceIndex % STYLES.length];
    const spec = baseSpec({ role: combo.role, style, seed });

    const specA = structuredClone(spec);
    specA.parts.roles.TIMBRE_1.instrumentId = combo.a;
    const specB = structuredClone(spec);
    specB.parts.roles.TIMBRE_1.instrumentId = combo.b;
    const codeA = compileTrackSpec(specA);
    const codeB = compileTrackSpec(specB);

    // Инвариант тембровой пары (D-128): стороны отличаются ТОЛЬКО
    // alias пресета. Не сошлось — пара не публикуется, а не «чинится».
    const aliasA = catalog.presets[combo.a].strudelAlias;
    const aliasB = catalog.presets[combo.b].strudelAlias;
    if (codeA.split(aliasA).join(aliasB) !== codeB) {
      throw new Error(`тембровая пара ${combo.a}/${combo.b}: коды отличаются не только инструментом`);
    }

    const baseSwapped = sourceIndex % 2 === 1;
    const swapped = isRepeat ? !baseSwapped : baseSwapped;
    const leftId = swapped ? combo.b : combo.a;
    const rightId = swapped ? combo.a : combo.b;
    const leftCode = swapped ? codeB : codeA;
    const rightCode = swapped ? codeA : codeB;

    const id = `timbre-${String(index + 1).padStart(3, '0')}`;
    // Промт нейтральный: имена пресетов не показываются — слепое сравнение.
    const prompt = `Какой тембр лучше подходит партии ${combo.role} (${style})?`;
    const record = {
      pairId: id,
      type: 'timbre',
      prompt,
      role: combo.role,
      family: combo.family,
      style,
      seed,
      swapped,
      repeat: isRepeat,
      index,
      createdAt: new Date().toISOString(),
      spec,
      a: { hash: hashCode(leftCode), instrumentId: leftId },
      b: { hash: hashCode(rightCode), instrumentId: rightId },
    };
    upsertPair(record);
    pairs.push({
      id,
      pairId: id,
      type: 'timbre',
      prompt,
      role: combo.role,
      family: combo.family,
      style,
      seed,
      swapped,
      repeat: isRepeat,
      index,
      a: { code: leftCode, hash: record.a.hash, instrumentId: leftId },
      b: { code: rightCode, hash: record.b.hash, instrumentId: rightId },
    });
  }
  return pairs;
}