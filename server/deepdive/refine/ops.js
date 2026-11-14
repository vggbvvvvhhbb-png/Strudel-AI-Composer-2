// Операции: проверка по измерениям и применение к плану.
//
// Здесь живёт белый список операций (OP_RULES) и их исполнители. Модель
// присылает типизированные операции, каждая проверяется по измерениям:
// если значение не подтверждается измерениями — операция отклоняется с
// причиной, а план остаётся прежним.

import {
  clone,
  currentGain,
  fmt,
  groupsOf,
  rolesOfLayer,
  scaleGainPattern,
} from './helpers.js';

// Карты слоёв живут в helpers.js (их использует и подбор партий слоя, и
// разбор измеренной сетки), но по смыслу относятся к операциям —
// поэтому переэкспортируем их отсюда.
export { LAYER_ROLES, GM_TO_ROLE } from './helpers.js';

import { LAYER_ROLES } from './helpers.js';

/** Слои, о которых думает модель. */
export const LAYERS = ['drums', 'bass', 'other'];

/** Псевдонимы операций: модель может назвать операцию как угодно близко. */
const OP_ALIASES = {
  set_gain: 'set_layer_gain',
  set_tempo: 'set_bpm',
  set_layer_on_off: 'set_layer_enabled',
};

/**
 * Белый список операций. Всё, чего здесь нет, отклоняется с причиной.
 * Операция — это структурированный объект, а не текст.
 */
export const OP_RULES = {
  set_bpm: {
    fields: ['value'],
    rule: 'value — BPM. Допустимо только в пределах измеренного темпа (± bpmTolerancePct %).',
  },
  set_layer_gain: {
    fields: ['layer', 'value'],
    rule: 'layer — drums|bass|other; value — громкость слоя в диапазоне [gainMin..gainMax]. Для ударных это динамика групп ударов, для остальных — множитель громкости.',
  },
  set_group_gain: {
    fields: ['layer', 'role?', 'group', 'value'],
    rule: 'Динамика одной группы ударных: layer — drums, role — партия (kick/snare/hats/perc), group — номер группы, value — 0..2.',
  },
  set_group_late: {
    fields: ['layer', 'role?', 'group', 'value'],
    rule: 'Микротайминг группы ударных в миллисекундах: value — сдвиг, допустим ±lateToleranceMs мс вокруг измеренного.',
  },
  set_layer_enabled: {
    fields: ['layer', 'value'],
    rule: 'Включить или выключить слой целиком: value — true или false.',
  },
  set_group_steps: {
    fields: ['layer', 'role?', 'group', 'steps'],
    rule: 'Шаги сетки одной группы ударных: steps — массив целых 0..15, каждый шаг должен быть ИЗМЕРЕН для этой партии.',
  },
  set_note_pattern: {
    fields: ['layer', 'value'],
    rule: 'Паттерн нот слоя bass в mini-нотации ("c2 ~ c2 ~"). Каждая нота должна быть измеренной, число токенов — как в плане.',
  },
};

/** Слой -> поле, по которому считается его оценка (для дельт по слоям). */
export const LAYER_SCORE_FIELD = {
  rhythm: 'f1',
  bass: 'note_match_ratio',
  timbre: 'cosine',
  groove: 'envelope_correlation',
};

function fail(reason) {
  return { ok: false, reason };
}

function ok(description) {
  return { ok: true, description };
}

/** Цели операции по слою: конкретная партия или все партии слоя. */
function targetRoles(plan, op, layer) {
  const role = op?.role ? String(op.role) : null;
  if (role) {
    if (!plan?.parts?.roles?.[role]) return fail(`в плане нет партии «${role}»`);
    if (!LAYER_ROLES[layer].includes(role)) return fail(`партия «${role}» не входит в слой «${layer}»`);
    return { ok: true, roles: [role] };
  }
  const roles = rolesOfLayer(plan, layer);
  if (!roles.length) return fail(`в плане нет партий слоя «${layer}»`);
  return { ok: true, roles };
}

function applySetBpm(op, plan, ctx) {
  const value = Number(op.value);
  if (!Number.isFinite(value)) return fail('value — не число');
  const measured = ctx.measuredBpm;
  if (measured === null) return fail('измеренного темпа нет — менять BPM нельзя');
  const tolerance = ctx.options.bpmTolerancePct / 100;
  const min = measured * (1 - tolerance);
  const max = measured * (1 + tolerance);
  if (value < min || value > max) {
    return fail(`BPM ${value} вне измеренного диапазона ${fmt(min)}..${fmt(max)} (измерено ${measured})`);
  }
  if (value < 60 || value > 180) return fail(`BPM ${value} вне диапазона схемы 60..180`);
  const before = plan.meta.bpm;
  if (before === value) return fail(`темп уже ${value} BPM — менять нечего`);
  plan.meta.bpm = value;
  return ok(`темп: ${before} → ${value} BPM (измерено ${measured})`);
}

function applySetLayerGain(op, plan, ctx) {
  const layer = String(op.layer ?? '').trim();
  if (!LAYERS.includes(layer)) {
    return fail(`неизвестный слой «${op.layer}» (доступны: ${LAYERS.join(', ')})`);
  }
  const value = Number(op.value);
  if (!Number.isFinite(value)) return fail('value — не число');
  if (value < ctx.options.gainMin || value > ctx.options.gainMax) {
    return fail(`громкость ${value} вне диапазона ${ctx.options.gainMin}..${ctx.options.gainMax}`);
  }
  const roles = rolesOfLayer(plan, layer);
  if (!roles.length) return fail(`в плане нет партий слоя «${layer}»`);
  const parts = [];
  for (const role of roles) {
    const part = plan.parts.roles[role];
    const groups = groupsOf(part);
    if (groups.length) {
      // Ударные: громкость слоя — это динамика каждой группы ударов.
      for (const { group } of groups) group.gain = value;
      parts.push(`${role}: динамика групп → ${value}`);
      continue;
    }
    const current = currentGain(part);
    if (part.gainPattern) {
      const factor = current > 0 ? value / current : value;
      part.gainPattern = scaleGainPattern(part.gainPattern, factor);
      parts.push(`${role}: огибающая динамики ×${fmt(factor)}`);
      continue;
    }
    part.effects = [
      ...(part.effects ?? []).filter((effect) => effect.name !== 'gain'),
      { name: 'gain', params: [value] },
    ];
    parts.push(`${role}: громкость → ${value}`);
  }
  return ok(`громкость слоя ${layer}: ${value} (${parts.join('; ')})`);
}

function applySetGroupGain(op, plan, ctx) {
  const layer = String(op.layer ?? 'drums').trim();
  if (layer !== 'drums') return fail('группы есть только у слоя drums');
  const value = Number(op.value);
  if (!Number.isFinite(value)) return fail('value — не число');
  if (value < ctx.options.gainMin || value > ctx.options.gainMax) {
    return fail(`громкость ${value} вне диапазона ${ctx.options.gainMin}..${ctx.options.gainMax}`);
  }
  const index = Number(op.group);
  if (!Number.isInteger(index) || index < 0) return fail('group — не неотрицательное целое число');
  const targets = targetRoles(plan, op, layer);
  if (!targets.ok) return targets;
  const touched = [];
  for (const role of targets.roles) {
    const part = plan.parts.roles[role];
    const groups = groupsOf(part).filter((entry) => entry.index === index);
    if (!groups.length) continue;
    for (const { group } of groups) group.gain = value;
    touched.push(role);
  }
  if (!touched.length) return fail(`в указанных партиях нет группы ${index}`);
  return ok(`динамика группы ${index}: ${touched.join(', ')} → ${value}`);
}

function applySetGroupLate(op, plan, ctx) {
  const layer = String(op.layer ?? 'drums').trim();
  if (layer !== 'drums') return fail('сдвиг задаётся только для групп ударных');
  const value = Number(op.value);
  if (!Number.isFinite(value)) return fail('value — не число (миллисекунды)');
  if (value < -50 || value > 50) return fail(`сдвиг ${value} мс вне диапазона -50..50 мс`);
  const index = Number(op.group);
  if (!Number.isInteger(index) || index < 0) return fail('group — не неотрицательное целое число');
  const targets = targetRoles(plan, op, layer);
  if (!targets.ok) return targets;
  const touched = [];
  for (const role of targets.roles) {
    const part = plan.parts.roles[role];
    const groups = groupsOf(part).filter((entry) => entry.index === index);
    if (!groups.length) continue;
    for (const { group } of groups) {
      const measured = Number(group.lateMs ?? 0);
      const min = measured - ctx.options.lateToleranceMs;
      const max = measured + ctx.options.lateToleranceMs;
      if (value < min || value > max) {
        return fail(`сдвиг ${value} мс вне измеренного ${measured} ±${ctx.options.lateToleranceMs} мс (${fmt(min)}..${fmt(max)})`);
      }
      group.lateMs = value;
      touched.push(role);
    }
  }
  if (!touched.length) return fail(`в указанных партиях нет группы ${index}`);
  return ok(`микротайминг группы ${index}: ${touched.join(', ')} → ${value} мс`);
}

function applySetLayerEnabled(op, plan, ctx) {
  const layer = String(op.layer ?? '').trim();
  if (!LAYERS.includes(layer)) {
    return fail(`неизвестный слой «${op.layer}» (доступны: ${LAYERS.join(', ')})`);
  }
  if (typeof op.value !== 'boolean') return fail('value — не true/false');
  const roles = rolesOfLayer(plan, layer);
  if (op.value === false) {
    if (!roles.length) return fail(`в плане нет партий слоя «${layer}»`);
    const remaining = Object.keys(plan.parts.roles).length - roles.length;
    if (remaining <= 0) return fail('нельзя выключить единственный слой плана');
    for (const role of roles) delete plan.parts.roles[role];
    return ok(`слой ${layer} выключен (партии: ${roles.join(', ')})`);
  }
  if (roles.length) return fail(`слой «${layer}» уже включён`);
  const baseRoles = rolesOfLayer(ctx.basePlan, layer);
  if (!baseRoles.length) return fail(`в исходном плане нет слоя «${layer}» — включать нечего`);
  for (const role of baseRoles) plan.parts.roles[role] = clone(ctx.basePlan.parts.roles[role]);
  return ok(`слой ${layer} включён (партии: ${baseRoles.join(', ')})`);
}

function applySetGroupSteps(op, plan, ctx) {
  const layer = String(op.layer ?? 'drums').trim();
  if (layer !== 'drums') return fail('шаги задаются только для групп ударных');
  if (!Array.isArray(op.steps) || !op.steps.length) return fail('steps — непустой массив чисел');
  const steps = op.steps.map((value) => Number(value));
  if (steps.some((value) => !Number.isInteger(value) || value < 0 || value > 15)) {
    return fail('steps — целые числа 0..15');
  }
  if (new Set(steps).size !== steps.length) return fail('steps — повторяющиеся шаги');
  const index = Number(op.group);
  if (!Number.isInteger(index) || index < 0) return fail('group — не неотрицательное целое число');
  const targets = targetRoles(plan, op, layer);
  if (!targets.ok) return targets;
  const touched = [];
  for (const role of targets.roles) {
    const allowed = ctx.measuredStepsByRole[role];
    if (!allowed || !allowed.length) {
      return fail(`для партии «${role}» нет измеренных шагов — менять сетку нельзя`);
    }
    const foreign = steps.filter((step) => !allowed.includes(step));
    if (foreign.length) {
      return fail(`шаг(ы) ${foreign.join(', ')} не измерены для партии «${role}» (измерены: ${allowed.join(', ')})`);
    }
    const part = plan.parts.roles[role];
    const groups = groupsOf(part).filter((entry) => entry.index === index);
    if (!groups.length) continue;
    for (const { group } of groups) group.steps = [...steps];
    touched.push(role);
  }
  if (!touched.length) return fail(`в указанных партиях нет группы ${index}`);
  return ok(`шаги группы ${index}: ${touched.join(', ')} → [${steps.join(', ')}]`);
}

function applySetNotePattern(op, plan, ctx) {
  const layer = String(op.layer ?? '').trim();
  if (layer === 'other') {
    return fail('паттерн аккордов нельзя собрать из измеренных нот — доступен только слой bass');
  }
  if (layer !== 'bass') return fail(`неизвестный слой «${op.layer}» для паттерна нот (доступен: bass)`);
  const roles = rolesOfLayer(plan, layer);
  if (!roles.length) return fail('в плане нет партии bass');
  const raw = String(op.value ?? '').trim();
  if (!raw) return fail('value — пустой паттерн');
  const tokens = raw.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token === '~') continue;
    const match = token.match(/^([a-g](?:#|b)?\d+)(\*\d+)?$/);
    if (!match) return fail(`токен «${token}» не понимается (нужна нота вида c2 или c2*2, либо ~)`);
    if (!ctx.measuredBassNotes.has(match[1])) {
      return fail(`нота «${match[1]}» не измерена (измеренные: ${[...ctx.measuredBassNotes].join(', ')})`);
    }
  }
  const part = plan.parts.roles[roles[0]];
  const current = String(part.pattern ?? '').split(/\s+/).filter(Boolean).length;
  if (current && tokens.length !== current) {
    return fail(`в паттерне ${tokens.length} токенов, а в плане ${current} — сетка должна совпадать`);
  }
  part.pattern = tokens.join(' ');
  for (const override of Object.values(part.sections ?? {})) {
    if (override && typeof override === 'object') override.pattern = tokens.join(' ');
  }
  return ok(`паттерн нот bass: ${tokens.join(' ')}`);
}

/**
 * Проверка одной операции и её применение к плану.
 * @returns {{ok:boolean, reason?:string, description?:string}}
 */
function checkAndApply(op, plan, ctx) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return fail('операция — не объект');
  const name = typeof op.op === 'string' ? op.op.trim() : '';
  if (!name) return fail('в операции нет поля op');
  const canonical = OP_ALIASES[name] ?? name;
  if (!OP_RULES[canonical]) {
    return fail(`операция «${name}» не входит в белый список (${Object.keys(OP_RULES).join(', ')})`);
  }
  switch (canonical) {
    case 'set_bpm': return applySetBpm(op, plan, ctx);
    case 'set_layer_gain': return applySetLayerGain(op, plan, ctx);
    case 'set_group_gain': return applySetGroupGain(op, plan, ctx);
    case 'set_group_late': return applySetGroupLate(op, plan, ctx);
    case 'set_layer_enabled': return applySetLayerEnabled(op, plan, ctx);
    case 'set_group_steps': return applySetGroupSteps(op, plan, ctx);
    case 'set_note_pattern': return applySetNotePattern(op, plan, ctx);
    default: return fail(`операция «${name}» не реализована`);
  }
}

/**
 * Применение списка операций к плану. План не меняется, если операция
 * не прошла проверку по измерениям.
 *
 * @returns {{plan:object, applied:Array<{op:string, description:string}>, rejected:Array<{op:any, reason:string}>}}
 */
export function applyOperations(plan, operations, ctx) {
  const next = clone(plan);
  const applied = [];
  const rejected = [];
  for (const op of Array.isArray(operations) ? operations : []) {
    const result = checkAndApply(op, next, ctx);
    if (result.ok) {
      applied.push({ op: typeof op?.op === 'string' ? op.op : '', description: result.description });
    } else {
      rejected.push({ op, reason: result.reason });
    }
  }
  return { plan: next, applied, rejected };
}
