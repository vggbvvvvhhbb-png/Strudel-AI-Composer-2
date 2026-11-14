// Мелкие утилиты цикла самоулучшения: копирование, округление, работа со
// слоями и партиями плана, а также выбор измеренных фактов.
//
// Модуль «нижний» в графе зависимостей: из соседних модулей цикла он ничего
// не импортирует. Поэтому отсюда можно свободно тянуть и операции, и промпт,
// и сам цикл — без риска циклических импортов.

import { midiToNoteName } from '../transpiler.js';

/** Слой -> партии плана, которые в него входят. */
export const LAYER_ROLES = {
  drums: ['kick', 'snare', 'hats', 'perc', 'fx'],
  bass: ['bass', 'sub'],
  other: ['chords', 'pad', 'lead', 'arp', 'texture'],
};

/** Роли ударных по нотам GM — та же карта, что в транспайлере. */
export const GM_TO_ROLE = {
  36: 'kick', 35: 'kick',
  38: 'snare', 40: 'snare', 37: 'snare',
  42: 'hats', 44: 'hats', 46: 'hats',
};

export function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

export function round4(value) {
  return Number(Number(value).toFixed(4));
}

export function fmt(value) {
  return Number(Number(value).toFixed(3));
}

/** Все группы партии: верхнего уровня и по секциям. */
export function groupsOf(part) {
  const out = [];
  if (Array.isArray(part?.groups)) {
    part.groups.forEach((group, index) => out.push({ group, index, scope: 'part' }));
  }
  for (const [section, override] of Object.entries(part?.sections ?? {})) {
    (override?.groups ?? []).forEach((group, index) => out.push({ group, index, scope: section }));
  }
  return out;
}

export function rolesOfLayer(plan, layer) {
  const names = LAYER_ROLES[layer] ?? [];
  return Object.keys(plan?.parts?.roles ?? {}).filter((role) => names.includes(role));
}

/** Текущая громкость партии: параметр gain эффекта либо 1. */
export function currentGain(part) {
  const effect = (part?.effects ?? []).find((item) => item.name === 'gain');
  const value = Number(effect?.params?.[0]);
  return Number.isFinite(value) ? value : 1;
}

/** Умножение огибающей динамики ("0.8 0.5 ~") на коэффициент. */
export function scaleGainPattern(pattern, factor) {
  return String(pattern)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (token === '~') return token;
      const value = Number(token);
      if (!Number.isFinite(value)) return token;
      return String(round4(value * factor));
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Измеренные факты — то, чем правки проверяются
// ---------------------------------------------------------------------------

export function pickTempo(input) {
  const sources = [
    input?.measurements?.tempo,
    input?.descriptors?.measurements?.tempo,
    input?.options?.measurements?.tempo,
    input?.tempo,
  ];
  for (const tempo of sources) {
    const bpm = Number(tempo?.bpm);
    if (Number.isFinite(bpm) && bpm > 0) return bpm;
    const candidate = Number(tempo?.candidates?.[0]?.bpm);
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return null;
}

export function pickStemDescriptors(input) {
  const sources = [
    input?.stem_descriptors,
    input?.measurements?.stem_descriptors,
    input?.descriptors?.stem_descriptors,
    input?.options?.stem_descriptors,
  ];
  for (const stems of sources) {
    if (stems && typeof stems === 'object' && Object.keys(stems).length) return stems;
  }
  return {};
}

/**
 * Измеренные шаги сетки по партиям ударных. Шаг считается по решётке 1/16
 * (её же использует компилятор: .beat("0,4,8,12",16)).
 */
export function measuredStepsByRole(stems, plan) {
  const sets = new Map();
  const add = (role, step) => {
    if (!Number.isInteger(step) || step < 0 || step > 15) return;
    if (!sets.has(role)) sets.set(role, new Set());
    sets.get(role).add(step);
  };
  const bpm = Number(plan?.meta?.bpm);
  const barSec = Number.isFinite(bpm) && bpm > 0 ? 240 / bpm : null;
  for (const hit of stems?.drums?.onsets?.hits ?? []) {
    const role = GM_TO_ROLE[hit?.gm] ?? 'perc';
    const time = Number(hit?.time_s ?? hit?.time);
    if (!Number.isFinite(time) || !barSec) continue;
    const withinBar = ((time % barSec) + barSec) % barSec;
    add(role, Math.round((withinBar / barSec) * 16) % 16);
  }
  // Шаги, уже стоящие в плане: план собран из тех же измерений.
  for (const [role, part] of Object.entries(plan?.parts?.roles ?? {})) {
    for (const { group } of groupsOf(part)) {
      for (const step of group?.steps ?? []) add(role, Number(step));
    }
  }
  const out = {};
  for (const [role, set] of sets.entries()) out[role] = [...set].sort((a, b) => a - b);
  return out;
}

/**
 * Измеренные ноты баса (с компенсацией transpose(-24) компилятора) плюс ноты,
 * уже стоящие в плане: и те, и другие пришли из измерений.
 */
export function measuredBassNotes(stems, plan) {
  const set = new Set();
  for (const note of stems?.bass?.pitch?.notes ?? []) {
    const midi = Number(note?.midi);
    if (!Number.isFinite(midi)) continue;
    set.add(midiToNoteName(midi + 24));
  }
  const pattern = plan?.parts?.roles?.bass?.pattern ?? '';
  for (const token of String(pattern).split(/\s+/)) {
    const match = token.match(/^([a-g](?:#|b)?\d+)(\*\d+)?$/);
    if (match) set.add(match[1]);
  }
  return set;
}
