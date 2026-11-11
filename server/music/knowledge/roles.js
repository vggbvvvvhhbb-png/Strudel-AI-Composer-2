// Матрица «стиль × роль»: как звучит каждая партия в каждом жанре.
//
// Роли (12): kick, snare, hats, perc, sub, bass, pad, chords, lead, arp, fx, texture.
// Для каждой роли в каждом стиле задано:
//   octave   — регистр (для ударных: 0 = «бас-бумбокс», 1 = средний, 2 = верхний)
//   density  — атак на такт (ориентир для проверки метрик)
//   patterns — 2–4 ритмических шаблона (мини-нотация) на выбор
//   sounds   — имена сэмплов из белого списка
//   synth    — синтезатор для ролей без сэмплов
//
// Белый список сэмплов взят из server/prompts/system.md и проверен
// tests/unit/knowledge.test.js: каждый шаблон реально разбирается движком.

export const ROLES = ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'pad', 'chords', 'lead', 'arp', 'fx', 'texture'];

/** Синтезаторы, которые гарантированно зарегистрированы в Strudel. */
export const SYNTHS = ['sawtooth', 'square', 'triangle', 'sine', 'piano', 'supersaw', 'pulse', 'fm', 'organ', 'am'];

/**
 * Матрица. Ключ — стиль, значение — объект по ролям.
 * density — среднее число атак на такт; octave — 0 (низ) … 2 (верх).
 */
export const ROLE_MATRIX = {
  lofi: {
    kick: { octave: 0, density: 2, patterns: ['bd ~ ~ bd', 'bd ~ bd ~', 'bd ~ ~ ~'], sounds: ['bd'], synth: null },
    snare: { octave: 1, density: 1, patterns: ['~ sd ~ ~', 'sd ~ ~ ~', '~ ~ sd ~'], sounds: ['sd', 'rim'], synth: null },
    hats: { octave: 2, density: 8, patterns: ['hh*8', 'hh ~ hh ~', '~ hh ~ hh'], sounds: ['hh', 'hh27'], synth: null },
    perc: { octave: 1, density: 2, patterns: ['perc ~ perc ~', '~ perc ~ perc'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 2, patterns: ['0 ~ 0 ~', '0 ~ ~ 0'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 4, patterns: ['0 ~ 2 ~', '0 2 ~ 4 ~', '0 ~ 4 ~ 2'], sounds: [], synth: 'triangle' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sine' },
    chords: { octave: 1, density: 2, patterns: ['0 2 4', '0 ~ 2 4'], sounds: [], synth: 'piano' },
    lead: { octave: 1, density: 3, patterns: ['7 ~ 4 ~ 2 ~', '4 ~ 2 ~ 0 ~'], sounds: [], synth: 'piano' },
    arp: { octave: 2, density: 8, patterns: ['0 2 4 7', '7 4 2 0'], sounds: [], synth: 'square' },
    fx: { octave: 2, density: 1, patterns: ['~ ~ ~ perc', '~ ~ perc ~'], sounds: ['perc'], synth: null },
    texture: { octave: 1, density: 1, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
  techno: {
    kick: { octave: 0, density: 4, patterns: ['bd*4', 'bd*4', 'bd ~ bd ~'], sounds: ['bd', '808bd'], synth: null },
    snare: { octave: 1, density: 2, patterns: ['~ sd ~ ~', 'cp ~ cp ~', 'sd ~ ~ sd'], sounds: ['sd', 'cp'], synth: null },
    hats: { octave: 2, density: 16, patterns: ['hh*16', 'hh*8', 'hh ~ hh ~ hh ~ hh ~'], sounds: ['hh', 'hh27'], synth: null },
    perc: { octave: 1, density: 3, patterns: ['perc*3', '~ perc ~ perc'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 4, patterns: ['0*4', '0 ~ 0 ~'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 8, patterns: ['[0 0 3 5]', '0 0 ~ 3 5 ~', '0 0 3 5 7 5'], sounds: [], synth: 'sawtooth' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sawtooth' },
    chords: { octave: 1, density: 2, patterns: ['0 2 4', '0 ~ 2 ~ 4'], sounds: [], synth: 'square' },
    lead: { octave: 2, density: 4, patterns: ['7 ~ 4 2 ~', '0 2 4 7'], sounds: [], synth: 'square' },
    arp: { octave: 2, density: 16, patterns: ['0 2 4 7', '0 4 2 7'], sounds: [], synth: 'square' },
    fx: { octave: 2, density: 1, patterns: ['industrial ~ ~ ~', '~ ~ ~ perc'], sounds: ['perc', 'industrial'], synth: null },
    texture: { octave: 1, density: 1, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
  house: {
    kick: { octave: 0, density: 4, patterns: ['bd*4', 'bd*4', 'bd ~ bd ~'], sounds: ['bd', 'house'], synth: null },
    snare: { octave: 1, density: 2, patterns: ['~ cp ~ cp', 'cp ~ cp ~', '~ sd ~ ~'], sounds: ['cp', 'sd', 'realclaps'], synth: null },
    hats: { octave: 2, density: 16, patterns: ['hh*16', 'hh*8', '[hh*2 hh]*4'], sounds: ['hh', 'hh27'], synth: null },
    perc: { octave: 1, density: 2, patterns: ['perc ~ perc ~', '~ ~ perc ~'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 4, patterns: ['0*4', '0 ~ 0 ~'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 8, patterns: ['0 ~ 0 2', '0 2 ~ 4 ~', '[0 0 7 7]'], sounds: [], synth: 'sawtooth' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sawtooth' },
    chords: { octave: 1, density: 4, patterns: ['0 2 4', '0 ~ 2 4'], sounds: [], synth: 'square' },
    lead: { octave: 2, density: 4, patterns: ['4 ~ 5 7 ~', '0 4 7 4'], sounds: [], synth: 'square' },
    arp: { octave: 2, density: 16, patterns: ['0 2 4 7', '7 4 2 0'], sounds: [], synth: 'square' },
    fx: { octave: 2, density: 1, patterns: ['~ ~ ~ stab', 'stab ~ ~ ~'], sounds: ['stab'], synth: null },
    texture: { octave: 1, density: 1, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
  ambient: {
    kick: { octave: 0, density: 1, patterns: ['bd ~ ~ ~', 'bd ~ ~ ~ ~'], sounds: ['bd'], synth: null },
    snare: { octave: 1, density: 1, patterns: ['sd ~ ~ ~', '~ ~ sd ~'], sounds: ['sd'], synth: null },
    hats: { octave: 2, density: 2, patterns: ['hh ~ ~ ~', '~ ~ hh ~'], sounds: ['hh'], synth: null },
    perc: { octave: 1, density: 1, patterns: ['~ ~ perc ~', 'perc ~ ~ ~'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 2, patterns: ['0 ~ ~ ~', '0 ~ 0 ~'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 2, patterns: ['0 ~ ~ ~', '0 ~ 4 ~'], sounds: [], synth: 'sine' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sine' },
    chords: { octave: 1, density: 1, patterns: ['0 2 4', '0 ~ ~ ~'], sounds: [], synth: 'piano' },
    lead: { octave: 2, density: 2, patterns: ['4 ~ ~ ~', '7 ~ 4 ~'], sounds: [], synth: 'triangle' },
    arp: { octave: 2, density: 4, patterns: ['0 2 4 7', '4 2 0 2'], sounds: [], synth: 'sine' },
    fx: { octave: 2, density: 1, patterns: ['perc ~ ~ ~', '~ ~ perc ~'], sounds: ['perc'], synth: null },
    texture: { octave: 1, density: 2, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
  dnb: {
    kick: { octave: 0, density: 4, patterns: ['bd*2 ~ bd', 'bd ~ bd ~ bd ~ bd ~', 'bd*2'], sounds: ['bd', '808bd'], synth: null },
    snare: { octave: 1, density: 2, patterns: ['~ sd ~ sd', 'sd ~ ~ sd', 'breaks157'], sounds: ['sd', 'breaks157'], synth: null },
    hats: { octave: 2, density: 16, patterns: ['hh*16', 'hh*8', '~ hh*2 ~ hh*2'], sounds: ['hh'], synth: null },
    perc: { octave: 1, density: 2, patterns: ['perc ~ perc ~', '~ perc ~ perc'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 4, patterns: ['0*2 ~ 0 ~', '0 ~ 0 ~'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 8, patterns: ['0 0 ~ 3 5 ~ 7', '[0 0 0 3]'], sounds: [], synth: 'sawtooth' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sawtooth' },
    chords: { octave: 1, density: 2, patterns: ['0 2 4', '0 ~ 2 4'], sounds: [], synth: 'square' },
    lead: { octave: 2, density: 4, patterns: ['7 5 4 2', '0 4 7 4'], sounds: [], synth: 'square' },
    arp: { octave: 2, density: 8, patterns: ['0 2 4 7', '0 4 7 4'], sounds: [], synth: 'square' },
    fx: { octave: 2, density: 1, patterns: ['perc ~ ~ ~', '~ ~ perc ~'], sounds: ['perc'], synth: null },
    texture: { octave: 1, density: 1, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
  synthwave: {
    kick: { octave: 0, density: 4, patterns: ['bd*4', 'bd*4', 'bd ~ bd ~'], sounds: ['bd', '808bd'], synth: null },
    snare: { octave: 1, density: 2, patterns: ['~ sd ~ ~', 'sd ~ ~ sd', '~ cp ~ cp'], sounds: ['sd', 'cp'], synth: null },
    hats: { octave: 2, density: 8, patterns: ['hh*8', '~ hh ~ hh ~ hh ~ hh', 'hh*4'], sounds: ['hh', 'hh27'], synth: null },
    perc: { octave: 1, density: 2, patterns: ['~ perc ~ perc', 'perc ~ ~ ~'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 4, patterns: ['0*4', '0 ~ 0 ~'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 8, patterns: ['0 0 7 7', '[0 0 3 5]', '0 0 ~ 7 7 ~'], sounds: [], synth: 'sawtooth' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sawtooth' },
    chords: { octave: 1, density: 4, patterns: ['0 2 4', '0 2 4 7'], sounds: [], synth: 'sawtooth' },
    lead: { octave: 2, density: 4, patterns: ['7 ~ 4 ~ 2 ~', '4 5 7 9'], sounds: [], synth: 'sawtooth' },
    arp: { octave: 2, density: 16, patterns: ['0 2 4 7', '7 4 2 0'], sounds: [], synth: 'square' },
    fx: { octave: 2, density: 1, patterns: ['perc ~ ~ ~', '~ ~ perc ~'], sounds: ['perc'], synth: null },
    texture: { octave: 1, density: 1, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
  trap: {
    kick: { octave: 0, density: 6, patterns: ['bd*2 ~ bd ~ bd', 'bd ~ ~ bd ~ ~ bd ~', '808bd*2'], sounds: ['808bd', 'bd'], synth: null },
    snare: { octave: 1, density: 2, patterns: ['~ sd ~ sd', 'sd ~ ~ sd', '808sd ~ ~ 808sd'], sounds: ['sd', '808sd'], synth: null },
    hats: { octave: 2, density: 16, patterns: ['hh*16', '[hh*3 hh]*4', 'hh*8'], sounds: ['hh', '808oh'], synth: null },
    perc: { octave: 1, density: 2, patterns: ['~ perc ~ perc', 'perc ~ ~ ~'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 4, patterns: ['0*2 ~ 0 ~', '0 ~ 0 ~'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 8, patterns: ['0 ~ 0 0 ~ 5', '0 0 7 5', '[0 0 0 3]'], sounds: [], synth: 'sawtooth' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sine' },
    chords: { octave: 1, density: 2, patterns: ['0 2 4', '0 ~ 2 4'], sounds: [], synth: 'square' },
    lead: { octave: 2, density: 4, patterns: ['7 ~ 4 2 ~', '0 4 7 4'], sounds: [], synth: 'square' },
    arp: { octave: 2, density: 16, patterns: ['0 2 4 7', '0 4 2 7'], sounds: [], synth: 'square' },
    fx: { octave: 2, density: 1, patterns: ['perc ~ ~ ~', '~ ~ perc ~'], sounds: ['perc'], synth: null },
    texture: { octave: 1, density: 1, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
  jazz: {
    kick: { octave: 0, density: 4, patterns: ['bd*4', 'bd ~ ~ bd', 'bd ~ bd ~'], sounds: ['bd'], synth: null },
    snare: { octave: 1, density: 4, patterns: ['~ sd ~ sd', 'sd ~ sd ~', 'rim ~ rim ~'], sounds: ['sd', 'rim'], synth: null },
    hats: { octave: 2, density: 8, patterns: ['hh*8', '~ hh ~ hh ~ hh ~ hh', 'hh*4'], sounds: ['hh'], synth: null },
    perc: { octave: 1, density: 2, patterns: ['~ perc ~ perc', 'perc ~ ~ ~'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 2, patterns: ['0 ~ ~ ~', '0 ~ 0 ~'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 4, patterns: ['0 ~ 2 ~ 4 ~', '0 2 4 ~ 7 ~', '0 ~ 4 ~ 2'], sounds: [], synth: 'triangle' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sine' },
    chords: { octave: 1, density: 4, patterns: ['0 2 4 6', '0 2 4', '0 ~ 2 4 6'], sounds: [], synth: 'piano' },
    lead: { octave: 2, density: 4, patterns: ['4 ~ 5 ~ 7 ~', '2 ~ 4 ~ 5 ~'], sounds: [], synth: 'organ' },
    arp: { octave: 2, density: 8, patterns: ['0 2 4 6', '6 4 2 0'], sounds: [], synth: 'square' },
    fx: { octave: 2, density: 1, patterns: ['stab ~ ~ ~', '~ ~ stab ~'], sounds: ['stab'], synth: null },
    texture: { octave: 1, density: 1, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
  rock: {
    kick: { octave: 0, density: 4, patterns: ['bd*4', 'bd*2 bd*2', 'bd ~ bd ~'], sounds: ['bd'], synth: null },
    snare: { octave: 1, density: 2, patterns: ['~ sd ~ ~', 'sd ~ ~ sd', '~ sd ~ sd'], sounds: ['sd'], synth: null },
    hats: { octave: 2, density: 8, patterns: ['hh*8', 'hh*4', '~ hh ~ hh ~ hh ~ hh'], sounds: ['hh'], synth: null },
    perc: { octave: 1, density: 2, patterns: ['~ perc ~ perc', 'perc ~ ~ ~'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 4, patterns: ['0*4', '0 ~ 0 ~'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 8, patterns: ['0 0 0 0', '0 ~ 0 0', '0 0 ~ 0 ~ 0'], sounds: [], synth: 'sawtooth' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sawtooth' },
    chords: { octave: 1, density: 2, patterns: ['0 2 4', '0 ~ 2 4'], sounds: [], synth: 'square' },
    lead: { octave: 2, density: 4, patterns: ['4 ~ 5 7 ~', '0 2 4 7'], sounds: [], synth: 'square' },
    arp: { octave: 2, density: 8, patterns: ['0 2 4 7', '7 4 2 0'], sounds: [], synth: 'square' },
    fx: { octave: 2, density: 1, patterns: ['perc ~ ~ ~', '~ ~ perc ~'], sounds: ['perc'], synth: null },
    texture: { octave: 1, density: 1, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
  cinematic: {
    kick: { octave: 0, density: 4, patterns: ['bd*4', 'bd ~ ~ bd', 'bd ~ bd ~'], sounds: ['bd'], synth: null },
    snare: { octave: 1, density: 2, patterns: ['~ sd ~ ~', 'sd ~ ~ ~', '~ ~ sd ~'], sounds: ['sd'], synth: null },
    hats: { octave: 2, density: 8, patterns: ['hh*8', 'hh*4', '~ hh ~ hh ~ hh ~ hh'], sounds: ['hh'], synth: null },
    perc: { octave: 1, density: 2, patterns: ['~ perc ~ perc', 'perc ~ ~ ~'], sounds: ['perc'], synth: null },
    sub: { octave: 0, density: 4, patterns: ['0 ~ ~ ~', '0*2 ~ 0 ~'], sounds: [], synth: 'sine' },
    bass: { octave: 0, density: 4, patterns: ['0 ~ ~ ~', '0 ~ 0 ~', '0 0 ~ 4 ~'], sounds: [], synth: 'sine' },
    pad: { octave: 1, density: 1, patterns: ['0 2 4', '<0 2 4>'], sounds: [], synth: 'sine' },
    chords: { octave: 1, density: 2, patterns: ['0 2 4', '0 ~ 2 4'], sounds: [], synth: 'sine' },
    lead: { octave: 2, density: 4, patterns: ['4 ~ 7 ~ 9 ~', '0 4 7 4'], sounds: [], synth: 'triangle' },
    arp: { octave: 2, density: 8, patterns: ['0 2 4 7', '7 4 2 0'], sounds: [], synth: 'triangle' },
    fx: { octave: 2, density: 1, patterns: ['perc ~ ~ ~', '~ ~ perc ~'], sounds: ['perc'], synth: null },
    texture: { octave: 1, density: 2, patterns: ['0 ~ ~ ~', '7 ~ ~ ~'], sounds: [], synth: 'sine' },
  },
};

/** Стили, для которых заполнена вся матрица ролей. */
export const ROLE_STYLES = Object.keys(ROLE_MATRIX);

/**
 * Рецепты партии: что модель может попросить у библиотеки.
 *
 *   default — обычная плотность роли, рисунок чередуется по секциям;
 *   busy    — плотнее обычного (больше атак на такт);
 *   sparse  — реже обычного (воздух, место для других партий).
 *
 * Рецепт влияет на выбор ритмического шаблона, а не на гармонию.
 */
export const RECIPES = ['default', 'busy', 'sparse'];

/**
 * Разбивает мини-строку на верхнеуровневые шаги (скобки не разрывают шаг).
 * @param {string} text
 * @returns {string[]}
 */
function splitTop(text) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of String(text)) {
    if (ch === '[' || ch === '<' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '>' || ch === ')') depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Плотность одного шага в атаках.
 * @param {string} token
 * @returns {number}
 */
function tokenDensity(token) {
  if (!token) return 0;
  if (token === '~' || token === '_' || token === '?') return 0;
  const mul = token.match(/^(.*)\*(\d+)$/);
  if (mul) {
    const inner = mul[1];
    const count = Number(mul[2]);
    return inner.startsWith('[') ? tokenDensity(inner) * count : count;
  }
  if (token.startsWith('[') && token.endsWith(']')) {
    return splitTop(token.slice(1, -1)).reduce((sum, t) => sum + tokenDensity(t), 0);
  }
  if (token.startsWith('<') && token.endsWith('>')) {
    // Альтернативы: берём самую плотную ветку.
    return splitTop(token.slice(1, -1)).reduce((max, t) => Math.max(max, tokenDensity(t)), 0);
  }
  return 1;
}

/**
 * Плотность ритмического шаблона в атаках на такт.
 *
 * Нужна, чтобы рецепт ('busy'/'sparse') выбирал шаблон осмысленно:
 * 'hh*16' — 16 атак, 'bd ~ bd ~' — 2, 'x ~ x x' — 3.
 *
 * @param {string} text мини-строка
 * @returns {number}
 */
export function patternDensity(text) {
  return splitTop(text).reduce((sum, t) => sum + tokenDensity(t), 0);
}

/**
 * Приводит имя рецепта к одному из известных.
 * @param {string} recipe
 * @returns {'default'|'busy'|'sparse'}
 */
export function normalizeRecipe(recipe) {
  const raw = String(recipe || '').trim().toLowerCase();
  if (raw === 'busy' || raw === 'dense' || raw === 'fast') return 'busy';
  if (raw === 'sparse' || raw === 'calm' || raw === 'minimal') return 'sparse';
  return 'default';
}

/**
 * Выбирает ритмический шаблон роли под рецепт и секцию.
 *
 * Правила:
 *   • 'busy'   — самый плотный подходящий шаблон;
 *   • 'sparse' — самый редкий подходящий шаблон;
 *   • 'default'— ближайший к плотности роли, но со сдвигом по секциям,
 *     чтобы соседние секции не звучали одинаково.
 *
 * Выбор детерминирован: зависит только от роли, рецепта, индекса секции и
 * зерна. Один и тот же вход — один и тот же результат.
 *
 * @param {object} role описание роли из ROLE_MATRIX
 * @param {string} recipe имя рецепта
 * @param {number} index индекс секции
 * @param {number|string} seed зерно трека
 * @returns {string|null} мини-строка шаблона
 */
export function selectPattern(role, recipe, index, seed) {
  const patterns = Array.isArray(role?.patterns) ? role.patterns : [];
  if (!patterns.length) return null;

  // Дубли в матрице (например, 'bd*4' дважды) не дают разнообразия:
  // оставляем по одному вхождению каждого шаблона.
  const unique = [];
  for (const pattern of patterns) {
    if (!unique.includes(pattern)) unique.push(pattern);
  }

  const mode = normalizeRecipe(recipe);
  const density = role.density || 2;
  const scored = unique.map((pattern, i) => ({ pattern, i, d: patternDensity(pattern) }));

  let pool;
  if (mode === 'busy') {
    pool = scored.filter((x) => x.d >= density * 0.8);
    if (!pool.length) pool = scored;
  } else if (mode === 'sparse') {
    pool = scored.filter((x) => x.d <= density * 0.8);
    if (!pool.length) pool = scored;
  } else {
    pool = scored.filter((x) => x.d >= density * 0.35 && x.d <= density * 1.6);
    if (!pool.length) pool = scored;
  }

  // Ближе к плотности роли — раньше. Сортировка стабильная, поэтому при равной
  // плотности порядок matrix не меняется, а выбор делает фаза (сдвиг по секциям).
  const target = density;
  const phase = hashPhase(`${seed}|${role.octave}|${role.density}|${role.synth || ''}`, pool.length);
  pool.sort((a, b) => Math.abs(a.d - target) - Math.abs(b.d - target));

  if (mode === 'busy') {
    const max = Math.max(...pool.map((x) => x.d));
    const tied = pool.filter((x) => x.d === max);
    return tied[(phase + index) % tied.length].pattern;
  }
  if (mode === 'sparse') {
    const min = Math.min(...pool.map((x) => x.d));
    const tied = pool.filter((x) => x.d === min);
    return tied[(phase + index) % tied.length].pattern;
  }
  return pool[(phase + index) % pool.length].pattern;
}

/**
 * Устойчивая фаза по строке — число в диапазоне [0, length).
 * @param {string} text
 * @param {number} length
 */
function hashPhase(text, length) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.max(1, length);
}

/**
 * Описание роли для стиля.
 * @param {string} style
 * @param {string} role
 */
export function roleFor(style, role) {
  const matrix = ROLE_MATRIX[style];
  if (!matrix) return null;
  return matrix[role] || null;
}

/** Все роли, для которых есть данные в стиле. */
export function rolesForStyle(style) {
  const matrix = ROLE_MATRIX[style];
  if (!matrix) return [];
  return ROLES.filter((role) => Boolean(matrix[role]));
}
