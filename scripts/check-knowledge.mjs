// Проверка библиотеки знаний: запускается как отдельная проверка в CI.
//
//   npm run check:knowledge
//
// Проверяет то же, что tests/unit/knowledge.test.js, но отдельным процессом:
// чтобы падение библиотеки было заметно в списке проверок, а не только
// в отчёте vitest.

import { loadStrudel } from '../server/music/strudel-runtime.mjs';
import {
  PROGRESSIONS,
  FORMS,
  ROLES,
  ROLE_MATRIX,
  COMPLETE_STYLES,
  TRANSITIONS,
  TRANSITION_TYPES,
  CURVES,
  CURVE_NAMES,
  descriptor,
} from '../server/music/knowledge/index.js';

const api = await loadStrudel();
const problems = [];
const fail = (message) => problems.push(message);

const STYLES = [
  'lofi', 'techno', 'house', 'ambient', 'dnb', 'synthwave', 'trap', 'jazz', 'rock', 'cinematic',
];
const STRUDEL_MODES = new Set([
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian',
  'ionian', 'aeolian', 'pentatonic', 'blues', 'chromatic',
]);

// 1. Полнота набора по стилям.
for (const style of STYLES) {
  if (!COMPLETE_STYLES.includes(style)) fail(`стиль ${style}: неполный набор знаний`);
  if (PROGRESSIONS.filter((p) => p.style === style).length < 4) {
    fail(`стиль ${style}: меньше 4 прогрессий`);
  }
}

// 2. Прогрессии: лад из белого списка, степени целые, аккорд исполняется.
for (const p of PROGRESSIONS) {
  if (!STRUDEL_MODES.has(p.mode)) fail(`${p.id}: лад "${p.mode}" не понимается Strudel`);
  for (const d of p.degrees) {
    if (!Number.isInteger(d) || d < 0 || d > 6) fail(`${p.id}: некорректная степень ${d}`);
  }
  for (const d of p.degrees) {
    const haps = api.n([d, d + 2, d + 4].join(' ')).scale(`c:${p.mode}`).queryArc(0, 1);
    if (haps.length !== 3) fail(`${p.id}: аккорд из степеней не исполнился`);
  }
  if (p.verified !== true) fail(`${p.id}: verified не true`);
}

// 3. Роли: 2–4 паттерна, каждый исполняется.
for (const style of STYLES) {
  for (const role of ROLES) {
    const entry = ROLE_MATRIX[style]?.[role];
    if (!entry) {
      fail(`${style}/${role}: нет описания`);
      continue;
    }
    if (entry.patterns.length < 2 || entry.patterns.length > 4) {
      fail(`${style}/${role}: ${entry.patterns.length} паттернов (нужно 2–4)`);
    }
    const percussive = entry.sounds.length > 0;
    for (const pattern of entry.patterns) {
      const haps = percussive
        ? api.s(pattern).queryArc(0, 1)
        : api.n(pattern).scale('c:minor').queryArc(0, 1);
      if (haps.length === 0) fail(`${style}/${role}: "${pattern}" не даёт ни одного события`);
    }
  }
}

// 4. Формы: длина 32–96, секции кратны 4, роли существуют.
for (const [style, forms] of Object.entries(FORMS)) {
  for (const form of forms) {
    const bars = form.sections.reduce((sum, section) => sum + section.bars, 0);
    if (bars < 32 || bars > 96) fail(`${form.id}: ${bars} тактов (нужно 32–96)`);
    for (const section of form.sections) {
      if (section.bars % 4 !== 0) fail(`${form.id}/${section.kind}: ${section.bars} тактов (не кратно 4)`);
      if (section.energy < 0 || section.energy > 1) fail(`${form.id}/${section.kind}: энергия вне 0..1`);
      for (const role of section.roles) {
        if (!ROLE_MATRIX[style]?.[role]) fail(`${form.id}/${section.kind}: неизвестная роль ${role}`);
      }
      if (section.transition && !TRANSITION_TYPES.includes(section.transition.type)) {
        fail(`${form.id}/${section.kind}: неизвестный переход ${section.transition.type}`);
      }
    }
  }
}

// 5. Переходы — функции, не мутируют исходник, используют разрешённые методы.
const ALLOWED_METHODS = new Set([
  'gain', 'lpf', 'hpf', 'room', 'delay', 'pan', 'ply', 'fast', 'slow',
  'rev', 'off', 'every', 'degradeBy', 'sometimesBy', 'chunk', 'mask',
]);
for (const type of TRANSITION_TYPES) {
  const recipe = TRANSITIONS[type];
  if (typeof recipe !== 'function') fail(`переход ${type}: не функция`);
  if (recipe.length !== 2) fail(`переход ${type}: ожидается (pattern, barsLen)`);
  const base = descriptor.degrees('0 5 2 6');
  const snapshot = JSON.stringify(base);
  const result = recipe(base, 8);
  if (JSON.stringify(base) !== snapshot) fail(`переход ${type}: мутирует исходный дескриптор`);
  for (const step of result.chain) {
    if (!ALLOWED_METHODS.has(step.method)) fail(`переход ${type}: неизвестный метод ${step.method}`);
  }
}

// 6. Кривые автоматизации — валидные сигналы.
for (const name of CURVE_NAMES) {
  for (const style of [...STYLES, 'generic']) {
    const curve = CURVES[name](style, 8);
    if (!curve || curve.kind !== 'signal') fail(`кривая ${name}/${style}: не сигнал`);
    else {
      if (curve.range[0] >= curve.range[1]) fail(`кривая ${name}/${style}: диапазон не по возрастанию`);
      if (!['up', 'down'].includes(curve.direction)) fail(`кривая ${name}/${style}: неизвестное направление`);
    }
  }
}

if (problems.length) {
  console.log(`\n✗ ${problems.length} проблем в библиотеке знаний:`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

console.log(
  `\n✓ библиотека знаний целостна: ${PROGRESSIONS.length} прогрессий, ` +
    `${Object.values(FORMS).flat().length} форм, ${TRANSITION_TYPES.length} переходов, ` +
    `${CURVE_NAMES.length} кривых, ${STYLES.length} стилей`,
);
