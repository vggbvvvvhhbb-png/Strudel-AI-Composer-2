// Библиотека знаний: единая точка входа.
//
// Каждая запись проверена настоящим парсером Strudel (tests/unit/knowledge.test.js).
// Запись с verified: false в репозиторий не попадает — тест это проверяет.

import { PROGRESSIONS, progressionsForStyle, progressionById, PROGRESSION_STYLES } from './progressions.js';
import { FORMS, formsForStyle, formBars, SECTION_KINDS, FORM_STYLES } from './forms.js';
import { ROLE_MATRIX, ROLES, rolesForStyle, roleFor, SYNTHS, ROLE_STYLES, RECIPES, patternDensity, normalizeRecipe, selectPattern } from './roles.js';
import { TRANSITIONS, TRANSITION_TYPES, applyTransition } from './transitions.js';
import { CURVES, CURVE_NAMES, CURVE_RANGES, rangeFor, buildCurve } from './automation.js';
import * as descriptor from './descriptor.js';

export {
  PROGRESSIONS,
  progressionsForStyle,
  progressionById,
  PROGRESSION_STYLES,
  FORMS,
  formsForStyle,
  formBars,
  SECTION_KINDS,
  FORM_STYLES,
  ROLE_MATRIX,
  ROLES,
  rolesForStyle,
  roleFor,
  ROLE_STYLES,
  SYNTHS,
  RECIPES,
  patternDensity,
  normalizeRecipe,
  selectPattern,
  TRANSITIONS,
  TRANSITION_TYPES,
  applyTransition,
  CURVES,
  CURVE_NAMES,
  CURVE_RANGES,
  rangeFor,
  buildCurve,
  descriptor,
};

/** Стили, для которых есть ПОЛНЫЙ набор: прогрессии + формы + все роли. */
export const COMPLETE_STYLES = (() => {
  const fromProgressions = new Set(PROGRESSIONS.map((p) => p.style));
  const fromForms = new Set(Object.keys(FORMS));
  const fromRoles = new Set(Object.keys(ROLE_MATRIX));
  return [...fromProgressions].filter(
    (style) => fromForms.has(style) && fromRoles.has(style),
  );
})();

/**
 * Ищет формы и прогрессии, подходящие стилю.
 * @param {string} style
 */
export function knowledgeForStyle(style) {
  return {
    progressions: progressionsForStyle(style),
    forms: formsForStyle(style),
    roles: rolesForStyle(style),
  };
}
