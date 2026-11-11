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
