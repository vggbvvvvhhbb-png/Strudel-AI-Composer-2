// Детерминированная починка ответа модели.
//
// Архитектурный принцип брифа: «LLM решает что, код решает как». Модель
// отвечает за музыкальное намерение (роли, энергия, гармония, плотность),
// а механика — за код. Поэтому то, что можно восстановить по правилам,
// восстанавливается здесь, а не гоняется ремонтным ретраем.
//
// Что чинится (замеренные на живой модели ошибки):
//   • модель пишет в enum-поле описание вместо значения:
//     `plan: "тихий виниловый шум"` → plan по роли (planForRole);
//   • модель выдумывает роль: `layers.guitar` → роль не в списке, слой
//     отбрасывается (с записью в notes);
//   • модель забывает `register` или `density` → берутся значения по роли;
//   • числа вне диапазона (bpm 240, density 1.7) → обрезаются по границам;
//   • `rn` не римская цифра («IV/3») → берётся основа («IV»).
//
// Ничего музыкального здесь не выдумывается: если модель не сказала, что
// играть, — починить нечем, и план остаётся невалидным (тогда работает
// ремонтный ретрай с текстом ошибки).

import {
  IR_PLANS, IR_ROLES, IR_MODES, IR_GROOVE_TEMPLATES, IR_SECTION_KINDS,
} from '../../src/ir/schema.js';
import { planForRole, registerForRole } from '../../src/ir/arrangement.js';

const PLANS = new Set(IR_PLANS);
const ROLES = new Set(IR_ROLES);
const MODES = new Set(IR_MODES);
const GROOVES = new Set(IR_GROOVE_TEMPLATES);
const KINDS = new Set(IR_SECTION_KINDS);

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Римская цифра: оставляем только основу («IV/3» → «IV», «bVII» → «bVII»).
 * @param {string} rn
 * @returns {string|null}
 */
export function normalizeRoman(rn) {
  const text = String(rn ?? '').trim();
  if (!text) return null;
  if (/^[b#]?[ivIV]+(maj7|min7|7)?$/.test(text)) return text;
  const base = text.match(/^([b#]?[ivIV]+)/);
  if (base && /^[b#]?[ivIV]+(maj7|min7|7)?$/.test(base[1])) return base[1];
  return null;
}

/**
 * Чинит один слой секции.
 * @param {object} layer
 * @param {string} role
 * @param {Array<string>} notes куда писать, что поправили
 * @returns {object|null} исправленный слой или null (слой выброшен)
 */
function normalizeLayer(layer, role, notes) {
  if (!layer || typeof layer !== 'object') return null;

  const out = { ...layer };

  // plan: описание вместо enum → берём по роли.
  if (!PLANS.has(out.plan)) {
    if (out.plan !== undefined) notes.push(`layers.${role}.plan: «${out.plan}» → план по роли`);
    out.plan = planForRole(role);
  }

  // density
  if (!Number.isFinite(out.density)) {
    out.density = 0.5;
  } else {
    out.density = clamp(out.density, 0, 1);
  }

  // weight
  if (!Number.isFinite(out.weight)) out.weight = 1;
  else out.weight = clamp(out.weight, 0, 1);

  // register: пара MIDI-номеров.
  const fallback = registerForRole(role);
  if (!Array.isArray(out.register) || out.register.length !== 2) {
    out.register = fallback;
    notes.push(`layers.${role}.register: заменён на ${fallback.join('–')}`);
  } else {
    const low = clamp(Math.round(out.register[0]), 24, 96);
    const high = clamp(Math.round(out.register[1]), 24, 96);
    out.register = low <= high ? [low, high] : [high, low];
  }

  if (out.gainDb !== undefined && Number.isFinite(out.gainDb)) {
    out.gainDb = clamp(out.gainDb, -24, 6);
  } else if (out.gainDb !== undefined) {
    delete out.gainDb;
  }

  if (out.lpf !== undefined) {
    out.lpf = Number.isFinite(out.lpf) ? clamp(Math.round(out.lpf), 120, 20000) : undefined;
    if (out.lpf === undefined) delete out.lpf;
  }

  if (out.motifId !== undefined && typeof out.motifId !== 'string') delete out.motifId;

  return out;
}

/**
 * Приводит ответ модели к форме, которую принимает Zod.
 *
 * @param {any} candidate сырой разобранный JSON от модели
 * @returns {{ir: object, notes: string[]}} починенный план и список правок
 */
export function normalizeIR(candidate) {
  const notes = [];
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const ir = { ...source };

  // v и seed
  ir.v = 1;
  if (!Number.isFinite(ir.seed)) ir.seed = 1;
  else ir.seed = Math.abs(Math.round(ir.seed)) % 2147483647;

  // meta
  const meta = { ...(ir.meta && typeof ir.meta === 'object' ? ir.meta : {}) };
  meta.title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim().slice(0, 120) : 'Без названия';
  meta.bpm = Number.isFinite(meta.bpm) ? clamp(Math.round(meta.bpm), 40, 200) : 120;
  if (!['4/4', '3/4', '6/8'].includes(meta.meter)) meta.meter = '4/4';

  const key = { ...(meta.key && typeof meta.key === 'object' ? meta.key : {}) };
  if (!/^[A-G][#b]?$/.test(String(key.tonic ?? ''))) key.tonic = 'C';
  if (!MODES.has(key.mode)) key.mode = 'minor';
  meta.key = key;

  const mood = { ...(meta.mood && typeof meta.mood === 'object' ? meta.mood : {}) };
  mood.valence = Number.isFinite(mood.valence) ? clamp(mood.valence, -1, 1) : 0;
  mood.arousal = Number.isFinite(mood.arousal) ? clamp(mood.arousal, -1, 1) : 0;
  mood.modifiers = Array.isArray(mood.modifiers)
    ? mood.modifiers.filter((item) => typeof item === 'string').slice(0, 8)
    : [];
  meta.mood = mood;
  ir.meta = meta;

  // palette: только известные роли.
  const palette = {};
  for (const [role, entry] of Object.entries(ir.palette && typeof ir.palette === 'object' ? ir.palette : {})) {
    if (!ROLES.has(role)) {
      notes.push(`palette.${role}: роль не в списке — выброшено`);
      continue;
    }
    if (!entry || typeof entry !== 'object' || typeof entry.ref !== 'string' || !entry.ref.trim()) continue;
    palette[role] = { ...entry, ref: entry.ref.trim().slice(0, 80) };
  }
  ir.palette = palette;

  // motifs
  const motifs = {};
  for (const [id, motif] of Object.entries(ir.motifs && typeof ir.motifs === 'object' ? ir.motifs : {})) {
    if (!motif || typeof motif !== 'object') continue;
    const degrees = Array.isArray(motif.degrees)
      ? motif.degrees.map((degree) => (Number.isFinite(degree) ? clamp(Math.round(degree), -14, 14) : null)).slice(0, 32)
      : null;
    const steps = Array.isArray(motif.steps)
      ? motif.steps.filter((step) => Number.isFinite(step)).map((step) => clamp(Math.round(step), 0, 15)).slice(0, 32)
      : null;
    if (!degrees?.length || !steps?.length) {
      notes.push(`motifs.${id}: без степеней или шагов — выброшен`);
      continue;
    }
    const entry = { degrees, steps };
    if (Array.isArray(motif.durations)) {
      entry.durations = motif.durations
        .filter((duration) => Number.isFinite(duration))
        .map((duration) => clamp(duration, 0.25, 8))
        .slice(0, 32);
    }
    motifs[String(id).slice(0, 40)] = entry;
  }
  ir.motifs = motifs;

  // sections
  const sections = [];
  for (const [index, section] of Array.isArray(ir.sections) ? ir.sections.entries() : []) {
    if (!section || typeof section !== 'object') continue;
    const out = { ...section };
    out.id = typeof out.id === 'string' && out.id.trim() ? out.id.trim().slice(0, 40) : `sec-${index + 1}`;
    if (!KINDS.has(out.kind)) out.kind = 'verse';
    out.bars = Number.isFinite(out.bars) ? clamp(Math.round(out.bars), 1, 32) : 8;
    out.energy = Number.isFinite(out.energy) ? clamp(out.energy, 0, 1) : 0.5;
    out.tension = Number.isFinite(out.tension) ? clamp(out.tension, 0, 1) : 0.5;

    const harmony = [];
    for (const step of Array.isArray(out.harmony) ? out.harmony : []) {
      if (!step || typeof step !== 'object') continue;
      const rn = normalizeRoman(step.rn);
      if (!rn) {
        notes.push(`sections.${out.id}.harmony: «${step.rn}» не римская цифра — пропущено`);
        continue;
      }
      const item = { rn, bars: Number.isFinite(step.bars) ? clamp(Math.round(step.bars), 1, 16) : 1 };
      if (['major', 'minor', 'dim', 'aug'].includes(step.quality)) item.quality = step.quality;
      if (['sus', 'add9', '7', 'borrowed', 'picardy', 'pedal'].includes(step.color)) item.color = step.color;
      harmony.push(item);
    }
    if (!harmony.length) harmony.push({ rn: 'I', bars: Math.min(4, out.bars) });
    out.harmony = harmony.slice(0, 16);

    const layers = {};
    for (const [role, layer] of Object.entries(out.layers && typeof out.layers === 'object' ? out.layers : {})) {
      if (!ROLES.has(role)) {
        notes.push(`sections.${out.id}.layers.${role}: роль не в списке — слой выброшен`);
        continue;
      }
      const fixed = normalizeLayer(layer, role, notes);
      if (fixed) layers[role] = fixed;
    }
    out.layers = layers;

    if (['riser', 'filter-open', 'fill', 'silence', 'none'].includes(out.enter)) {
      out.enter = out.enter;
    } else if (out.enter !== undefined) {
      delete out.enter;
    }

    sections.push(out);
  }
  ir.sections = sections.slice(0, 12);

  // groove
  const groove = { ...(ir.groove && typeof ir.groove === 'object' ? ir.groove : {}) };
  if (!GROOVES.has(groove.template)) {
    if (groove.template !== undefined) notes.push(`groove.template: «${groove.template}» → straight`);
    groove.template = 'straight';
  }
  groove.amount = Number.isFinite(groove.amount) ? clamp(groove.amount, 0, 1) : 1;
  if (groove.swing !== undefined) {
    groove.swing = Number.isFinite(groove.swing) ? clamp(groove.swing, 0.5, 0.68) : undefined;
    if (groove.swing === undefined) delete groove.swing;
  }
  if (typeof groove.bassRhythm === 'string') groove.bassRhythm = groove.bassRhythm.slice(0, 32);
  else delete groove.bassRhythm;
  if (groove.offsetMs !== undefined) {
    groove.offsetMs = Number.isFinite(groove.offsetMs) ? clamp(groove.offsetMs, -20, 20) : 0;
  }
  ir.groove = groove;

  // mix
  const mix = { ...(ir.mix && typeof ir.mix === 'object' ? ir.mix : {}) };
  mix.sidechain = (Array.isArray(mix.sidechain) ? mix.sidechain : [])
    .filter((link) => link && ROLES.has(link.src) && ROLES.has(link.dst))
    .map((link) => ({ src: link.src, dst: link.dst, depth: clamp(link.depth ?? 0.5, 0, 1) }))
    .slice(0, 16);
  const pan = {};
  for (const [role, value] of Object.entries(mix.pan && typeof mix.pan === 'object' ? mix.pan : {})) {
    if (!ROLES.has(role) || !Number.isFinite(value)) continue;
    pan[role] = clamp(value, -1, 1);
  }
  mix.pan = pan;
  const orbit = {};
  for (const [role, value] of Object.entries(mix.orbit && typeof mix.orbit === 'object' ? mix.orbit : {})) {
    if (!ROLES.has(role) || !Number.isFinite(value)) continue;
    orbit[role] = clamp(Math.round(value), 1, 8);
  }
  mix.orbit = orbit;
  ir.mix = mix;

  return { ir, notes };
}
