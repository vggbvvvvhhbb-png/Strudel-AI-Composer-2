// Компиляция ProjectModel в Strudel-код и EnginePlan.
//
// Детерминированность — обязательное свойство: один и тот же ProjectModel
// всегда даёт один и тот же код и один и тот же хеш. Никаких Date.now(),
// Math.random() и порядков обхода объектов, зависящих от вставки ключей.
//
// Музыкальное содержание собирает существующий компилятор спеки v2
// (`server/music/compiler/index.js`) — чтобы студия и конвейер генерации
// давали один и тот же звук. Студийный слой (микс, автоматизация, мастер)
// добавляется поверх.

import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { roleFor } from '../../server/music/knowledge/index.js';
import { selectPattern } from '../../server/music/knowledge/roles.js';
import { labelIndex, listParts, roleOf } from '../schemas/parts.js';
import { ENGINE_VERSION_STRING } from '../audio/engine-version.js';
import { canonicalJson, sectionTimeline, totalBars } from './model.js';
import { codeHash } from './roundtrip.js';

const dbToLin = (db) => Math.pow(10, db / 20);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Автоматизация раскладывается по секциям спеки.
 * gain — в дБ (приводится к линейному), cutoff — в Гц, energy — 0..1.
 */
function applyAutomation(spec, automation) {
  const out = clone(spec);
  const sections = out.structure.sections;
  for (const item of automation) {
    if (item.target.kind !== 'section') continue;
    const index = sections.findIndex((section) => section.name === item.target.id);
    if (index === -1) continue;
    const section = sections[index];
    if (item.param === 'energy') {
      section.energy = Math.min(1, Math.max(0, item.curve.to));
    } else if (item.param === 'gain') {
      const from = dbToLin(item.curve.from);
      const to = dbToLin(item.curve.to);
      section.parameters = section.parameters || {};
      section.parameters.gain = [from, to];
    } else if (item.param === 'cutoff') {
      section.parameters = section.parameters || {};
      section.parameters.cutoff = [item.curve.from, item.curve.to];
    }
  }
  return out;
}

/** Рецепт партии выбирает ритмический шаблон из библиотеки знаний. */
function applyVariants(spec, variantsById, seed) {
  const out = clone(spec);
  for (const [id, variants] of Object.entries(variantsById)) {
    const recipe = variants.find((variant) => variant.kind === 'recipe');
    if (!recipe) continue;
    // Шаблон выбирается по РОЛИ партии, а вариант хранится у конкретной
    // дорожки (id) — у 100 дорожек одной роли у каждой свой рецепт.
    const role = roleOf(id, out.parts.roles[id]);
    const roleDesc = role ? roleFor(spec.meta.style, role) : null;
    const pattern = selectPatternSafe(roleDesc, recipe.value, seed);
    if (pattern && out.parts.roles[id]) out.parts.roles[id].pattern = pattern;
  }
  return out;
}

function selectPatternSafe(roleDesc, recipe, seed) {
  if (!roleDesc) return null;
  return selectPattern(roleDesc, recipe, 0, seed);
}

/**
 * Цепочка микса для партии — методы Strudel, которые добавляются к константе
 * секции. Порядок важен: фильтры до панорамы, панорама — последней.
 */
function mixChain(role, mix, { hasSectionCutoff }) {
  const chain = [];
  if (mix.hpf > 0) chain.push(`.hpf(${Math.round(mix.hpf)})`);
  if (mix.lpf < 20000 && !hasSectionCutoff) chain.push(`.lpf(${Math.round(mix.lpf)})`);
  if (mix.sends.room > 0) chain.push(`.room(${Number(mix.sends.room.toFixed(3))})`);
  if (mix.sends.delay > 0) chain.push(`.delay(${Number(mix.sends.delay.toFixed(3))})`);
  if (mix.pan !== 0) chain.push(`.pan(${Number(mix.pan.toFixed(3))})`);
  return chain;
}

/**
 * Ищет в выражении gain-параметр и умножает оба значения на коэффициент.
 *
 * Поддерживаются два вида: `.gain(a, b)` и `.gain(sine.slow(16).range(a, b))`
 * — во втором случае масштабируются границы диапазона. Скобки считаются
 * с балансировкой, чтобы вложенные вызовы не рвали разбор.
 */
function scaleGainRange(expression, factor) {
  const marker = '.gain(';
  const start = expression.indexOf(marker);
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start + marker.length - 1; i < expression.length; i += 1) {
    if (expression[i] === '(') depth += 1;
    else if (expression[i] === ')') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  const inner = expression.slice(start + marker.length, end);

  // Границы диапазона: либо «a, b» напрямую, либо после .range(a, b).
  const rangeIndex = inner.lastIndexOf('.range(');
  let tail = inner;
  let head = '';
  if (rangeIndex !== -1) {
    head = inner.slice(0, rangeIndex + '.range('.length);
    const rangeStart = rangeIndex + '.range('.length;
    let rangeDepth = 1;
    let rangeEnd = -1;
    for (let i = rangeStart; i < inner.length; i += 1) {
      if (inner[i] === '(') rangeDepth += 1;
      else if (inner[i] === ')') {
        rangeDepth -= 1;
        if (rangeDepth === 0) { rangeEnd = i; break; }
      }
    }
    if (rangeEnd === -1) return null;
    tail = inner.slice(rangeStart, rangeEnd);
  }
  const numbers = tail.split(',').map((value) => Number(value.trim()));
  if (numbers.length !== 2 || numbers.some((value) => !Number.isFinite(value))) return null;

  const scaled = [numbers[0] * factor, numbers[1] * factor];
  const replacement = `${head}${scaled[0].toFixed(4)}, ${scaled[1].toFixed(4)}`;
  return `${expression.slice(0, start)}.gain(${replacement})${expression.slice(end + 1)}`;
}

/**
 * Собирает код из базовой компиляции спеки и правит константы секций:
 * добавляет цепочку микса и комментарии с заметками.
 */
function applyMixAndNotes(code, model, spec) {
  const variantsById = {};
  for (const [id, part] of Object.entries(model.spec.parts.roles)) {
    const variants = (part.variants || []);
    if (variants.length) variantsById[id] = variants;
  }

  const activeSectionsById = {};
  for (const [id, part] of Object.entries(spec.parts.roles)) {
    const sections = spec.structure.sections.filter((section) => part.activeIn.includes(section.name));
    activeSectionsById[id] = {
      hasSectionGain: sections.some((section) => section.parameters?.gain),
      hasSectionCutoff: sections.some((section) => section.parameters?.cutoff),
    };
  }

  const notesById = {};
  for (const [id, part] of Object.entries(model.spec.parts.roles)) {
    const notes = (part.variants || []).filter((variant) => variant.kind === 'notes');
    if (notes.length) notesById[id] = notes.map((variant) => variant.value).join(' | ');
  }

  // Метка в коде -> идентификатор партии: `$VIOLIN_1:` -> `VIOLIN_1`.
  const idByLabel = labelIndex(spec.parts);

  const masterFactor = dbToLin(model.mix.masterGainDb);
  const lines = code.split('\n');
  const out = [];
  for (const line of lines) {
    const match = line.match(/^const ([A-Z][A-Z0-9_]*)_(\d+) = (.*)$/);
    if (!match) {
      out.push(line);
      continue;
    }
    const [, label, , expression] = match;
    const id = idByLabel.get(label);
    if (!id) {
      out.push(line);
      continue;
    }
    const mix = model.mix.parts[id];
    const flags = activeSectionsById[id] || { hasSectionGain: false, hasSectionCutoff: false };
    let text = expression;

    // Общий множитель: микс партии + мастер-шина. Если у секции своя
    // gain-автоматизация, множитель вписывается в её диапазон, а не затирает её.
    const factor = dbToLin(mix?.gainDb ?? 0) * masterFactor;
    if (Math.abs(factor - 1) > 1e-6) {
      const scaled = scaleGainRange(text, factor);
      text = scaled ?? `${text}.gain(${factor.toFixed(4)})`;
    }
    if (mix) {
      for (const item of mixChain(id, mix, flags)) text += item;
    }
    out.push(`const ${label}_${match[2]} = ${text}`);
  }

  const result = out.join('\n');
  // Заметки (вариант 'notes') — как комментарии над строкой партии.
  const withNotes = result.split('\n').flatMap((line) => {
    const partMatch = line.match(/^\$([A-Z][A-Z0-9_]*):/);
    if (!partMatch) return [line];
    const id = idByLabel.get(partMatch[1]);
    const notes = id ? notesById[id] : null;
    return notes ? [`// ${id}: ${notes.replace(/\n/g, ' ')}`, line] : [line];
  });
  return withNotes.join('\n');
}

/**
 * Компилирует модель в код и план.
 * @param {object} model
 * @returns {{code:string, plan:object, hash:string}}
 */
export function compileProject(model) {
  const variantsById = {};
  for (const [id, part] of Object.entries(model.spec.parts.roles)) {
    if (part.variants?.length) variantsById[id] = part.variants;
  }

  const specWithVariants = applyVariants(model.spec, variantsById, model.seed);
  const specWithAutomation = applyAutomation(specWithVariants, model.automation);
  const base = compileTrackSpec(specWithAutomation);
  const code = applyMixAndNotes(base, model, specWithAutomation);

  const timeline = sectionTimeline({ spec: specWithAutomation });
  const plan = {
    engineVersion: ENGINE_VERSION_STRING,
    seed: model.seed,
    style: specWithAutomation.meta.style,
    bpm: specWithAutomation.meta.bpm,
    cps: specWithAutomation.meta.bpm / 60 / 4,
    key: specWithAutomation.meta.key,
    bars: totalBars({ spec: specWithAutomation }),
    sections: timeline.map((section) => ({
      name: section.name,
      startBar: section.startBar,
      endBar: section.endBar,
      cycles: section.cycles,
      energy: section.energy,
    })),
    // План партий: идентичность (id), роль (атрибут) и метка в коде.
    parts: listParts(specWithAutomation.parts).map(({ id, role, label, part }) => ({
      id,
      role,
      label,
      sound: part.sound,
      activeIn: part.activeIn,
    })),
    mix: model.mix,
    master: model.master,
  };

  return { code, plan, hash: codeHash(code) };
}

/** Канонический хеш модели — для undo и round-trip. */
export function modelHash(model) {
  return codeHash(canonicalJson(model));
}
