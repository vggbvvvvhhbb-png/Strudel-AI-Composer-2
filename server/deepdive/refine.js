// Цикл самоулучшения «код-двойника» (этап D режима «Разбор»).
//
// ЧТО ЭТО. Замкнутый цикл «измерить → предложить правку плана → применить →
// отрендерить → сравнить» над ПЛАНОМ (TrackSpec) двойника. Код на каждой
// итерации собирается заново существующим компилятором
// (server/music/compiler/index.js), метрики считаются существующим сравнением
// (server/deepdive/compare.js). Свой компилятор и свой DSP здесь не нужны —
// и не пишутся.
//
// ГЛАВНОЕ ПРАВИЛО. Модель НЕ пишет ни кода, ни свободного текста, ни чисел
// «из воздуха». Она возвращает ТОЛЬКО типизированные операции над планом из
// белого списка, и каждая операция проверяется по измерениям: если значение
// не подтверждается измерениями (темп вне измеренного диапазона, нота не из
// измеренных, шаг не из измеренной сетки) — операция ОТКЛОНЯЕТСЯ с причиной,
// а план остаётся прежним. Это проверка, а не просьба: модель её не может
// обойти, даже если очень захочет.
//
// ТОЧКА ОТСЧЁТА. Baseline (iteration 0) — единственная точка отсчёта: все
// дельты считаются относительно него, а не относительно предыдущей
// итерации. Иначе «улучшение на 0.001» накапливалось бы незаметно.
//
// СТОП-УСЛОВИЯ. Плато (улучшение общей оценки меньше порога) или бюджет
// итераций. Причина остановки пишется в журнал.
//
// ЧТО МОДЕЛЬ ВИДИТ. Только JSON измерений и JSON метрик. Никаких аудиофайлов,
// никаких стектрейсов, никаких путей к файлам (см. sanitize).

import { compileTrackSpec } from '../music/compiler/index.js';
import { compareTwin } from './compare.js';
import { midiToNoteName } from './transpiler.js';
import { decodeWav } from '../../src/core/wav.js';

export const REFINE_METHOD = 'deep-dive/refine@0.1.0';

/** Значения по умолчанию. Пороги узкие: план не должен уезжать от измерений. */
export const DEFAULT_OPTIONS = {
  iterations: 3,
  plateauThreshold: 0.01,
  bpmTolerancePct: 3,
  gainMin: 0,
  gainMax: 2,
  lateToleranceMs: 15,
  maxOperations: 8,
  temperature: 0.2,
};

/** Слои, о которых думает модель. */
export const LAYERS = ['drums', 'bass', 'other'];

/** Слой -> партии плана, которые в него входят. */
const LAYER_ROLES = {
  drums: ['kick', 'snare', 'hats', 'perc', 'fx'],
  bass: ['bass', 'sub'],
  other: ['chords', 'pad', 'lead', 'arp', 'texture'],
};

/** Роли ударных по нотам GM — та же карта, что в транспайлере. */
const GM_TO_ROLE = {
  36: 'kick', 35: 'kick',
  38: 'snare', 40: 'snare', 37: 'snare',
  42: 'hats', 44: 'hats', 46: 'hats',
};

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
const OP_RULES = {
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
const LAYER_SCORE_FIELD = {
  rhythm: 'f1',
  bass: 'note_match_ratio',
  timbre: 'cosine',
  groove: 'envelope_correlation',
};

/** Системный промпт цикла самоулучшения. */
export const REFINE_SYSTEM_PROMPT = `Ты — редактор ПЛАНА музыкального трека для Strudel (https://strudel.cc).

Тебе дают три вещи:
1. JSON измерений оригинала (темп, лад, громкость, сетка ударов, ноты баса, аккорды);
2. JSON метрик сравнения код-двойника с оригиналом (общая оценка и оценки по слоям);
3. краткую сводку плана (TrackSpec) и список допустимых значений.

Твоя задача — предложить ТИПИЗИРОВАННЫЕ ПРАВКИ ПЛАНА, чтобы двойник лучше совпадал с оригиналом.

Правила ответа:
- Отвечай ТОЛЬКО одним JSON-объектом вида {"operations": [ {...} ]}. Без пояснений, без markdown-обёрток, без текста вокруг.
- Каждая операция — объект {"op": "<имя операции>", ...поля}. Список операций и их поля — в блоке allowed_operations.
- НИКАКОГО Strudel-кода: код собирается из плана компилятором, а не тобой.
- НИКАКОГО свободного текста: план принимает только операции из белого списка.
- Не выдумывай числа. Значение операции должно подтверждаться тем, что есть в измерениях: темп — только из measurements.tempo, ноты — только из измеренных нот, шаги — только из измеренной сетки, громкость — в диапазоне 0..2. Операции вне этого будут отклонены и ничего не изменят.
- Правь только то, что видно по метрикам, и не ломай то, что уже хорошо.
- Если по метрикам нечего менять — верни {"operations": []}.

Примеры формата операций:
{"op": "set_bpm", "value": 92}
{"op": "set_layer_gain", "layer": "drums", "value": 0.7}
{"op": "set_group_gain", "layer": "drums", "role": "kick", "group": 0, "value": 0.85}
{"op": "set_group_late", "layer": "drums", "role": "snare", "group": 0, "value": 8}
{"op": "set_layer_enabled", "layer": "bass", "value": false}
{"op": "set_group_steps", "layer": "drums", "role": "hats", "group": 0, "steps": [0, 4, 8, 12]}
{"op": "set_note_pattern", "layer": "bass", "value": "c2 ~ c2 ~"}`;

// ---------------------------------------------------------------------------
// Мелкие утилиты
// ---------------------------------------------------------------------------

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function round4(value) {
  return Number(Number(value).toFixed(4));
}

function fmt(value) {
  return Number(Number(value).toFixed(3));
}

/** Ключи, которые не должны попасть к модели: пути, файлы, аудио. */
const PRIVATE_KEYS = new Set([
  'path', 'file', 'file_name', 'filename', 'dir', 'temp_dir', 'tmp',
  'url', 'wav', 'wav_url', 'audio', 'audio_path', 'channels', 'samples', 'buffer',
]);

/**
 * JSON-очистка измерений: только числа, строки, булевы, null, массивы и
 * объекты. Никаких путей, никаких аудио, ничего, что нельзя показать модели.
 */
export function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    if (depth > 6) return null;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_KEYS.has(key)) continue;
      out[key] = sanitize(item, depth + 1);
    }
    return out;
  }
  return null;
}

/** Все группы партии: верхнего уровня и по секциям. */
function groupsOf(part) {
  const out = [];
  if (Array.isArray(part?.groups)) {
    part.groups.forEach((group, index) => out.push({ group, index, scope: 'part' }));
  }
  for (const [section, override] of Object.entries(part?.sections ?? {})) {
    (override?.groups ?? []).forEach((group, index) => out.push({ group, index, scope: section }));
  }
  return out;
}

function rolesOfLayer(plan, layer) {
  const names = LAYER_ROLES[layer] ?? [];
  return Object.keys(plan?.parts?.roles ?? {}).filter((role) => names.includes(role));
}

/** Текущая громкость партии: параметр gain эффекта либо 1. */
function currentGain(part) {
  const effect = (part?.effects ?? []).find((item) => item.name === 'gain');
  const value = Number(effect?.params?.[0]);
  return Number.isFinite(value) ? value : 1;
}

/** Умножение огибающей динамики ("0.8 0.5 ~") на коэффициент. */
function scaleGainPattern(pattern, factor) {
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

function pickTempo(input) {
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

function pickStemDescriptors(input) {
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
function measuredStepsByRole(stems, plan) {
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
function measuredBassNotes(stems, plan) {
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

// ---------------------------------------------------------------------------
// Операции: проверка по измерениям и применение к плану
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Ответ модели
// ---------------------------------------------------------------------------

/**
 * Разбор ответа модели в список операций.
 * @throws {Error} если ответ не JSON или в нём нет списка операций
 */
export function parseModelOperations(raw) {
  let text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  text = String(text).trim();
  if (!text) throw new Error('пустой ответ модели');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`невалидный JSON: ${err?.message ?? err}`);
  }
  let operations = null;
  if (Array.isArray(data)) {
    operations = data;
  } else if (data && typeof data === 'object') {
    operations = data.operations ?? data.ops ?? data.changes ?? null;
    if (operations === null && typeof data.op === 'string') operations = [data];
  }
  if (!Array.isArray(operations)) {
    throw new Error('в ответе нет списка операций (ожидался ключ operations)');
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Что видит модель
// ---------------------------------------------------------------------------

function planSummary(plan) {
  const roles = {};
  for (const [role, part] of Object.entries(plan?.parts?.roles ?? {})) {
    roles[role] = {
      activeIn: part.activeIn,
      pattern: part.pattern,
      groups: groupsOf(part).map(({ group, index }) => ({
        index,
        sample: group.sample,
        steps: group.steps,
        gain: group.gain,
        lateMs: group.lateMs ?? 0,
      })),
    };
  }
  return {
    bpm: plan?.meta?.bpm,
    key: plan?.meta?.key,
    style: plan?.meta?.style,
    sections: (plan?.structure?.sections ?? []).map((section) => ({
      name: section.name,
      cycles: section.cycles,
      energy: section.energy,
    })),
    roles,
  };
}

/** Описание белого списка операций для промпта. */
function describeOperations() {
  return Object.entries(OP_RULES).map(([op, rule]) => ({
    op,
    fields: rule.fields,
    rule: rule.rule,
  }));
}

/**
 * Полезная нагрузка для модели: только JSON измерений и метрик плюс
 * разрешённые значения. Никакого аудио, никаких путей.
 */
export function buildModelPayload({ iteration, baseline, current, measurements, stems, plan, ctx }) {
  const tolerance = ctx.options.bpmTolerancePct / 100;
  const measured = ctx.measuredBpm;
  const bpmRange = measured === null
    ? null
    : { measured, min: round4(measured * (1 - tolerance)), max: round4(measured * (1 + tolerance)) };
  const stemView = {
    drums: {
      grid_step: stems?.drums?.onsets?.grid?.step ?? null,
      swing: stems?.drums?.onsets?.swing ?? null,
      hit_count: Number(stems?.drums?.onsets?.count ?? (stems?.drums?.onsets?.hits ?? []).length) || null,
      measured_steps_by_role: ctx.measuredStepsByRole,
    },
    bass: {
      measured_note_names: [...ctx.measuredBassNotes].sort(),
    },
    other: {
      chords: sanitize(stems?.other?.chords ?? []),
    },
  };
  return {
    iteration,
    task: 'предложить типизированные правки плана, чтобы код-двойник лучше совпадал с оригиналом',
    measurements: { ...sanitize(measurements ?? {}), stems: stemView },
    metrics: {
      baseline: { overall: baseline.overall, layers: baseline.layers },
      current: { overall: current.overall, layers: current.layers },
      improvement_vs_baseline: round4(current.overall - baseline.overall),
    },
    plan: planSummary(plan),
    allowed_values: {
      bpm: bpmRange,
      gain: { min: ctx.options.gainMin, max: ctx.options.gainMax },
      layers: LAYERS,
      roles: Object.keys(plan?.parts?.roles ?? {}),
      late_ms: { tolerance: ctx.options.lateToleranceMs },
    },
    allowed_operations: describeOperations(),
    rules: [
      'отвечай только JSON: {"operations": [...]}',
      'каждое значение должно подтверждаться измерениями',
      'операции вне белого списка будут отклонены',
      'не возвращай код и не возвращай текст',
    ],
  };
}

// ---------------------------------------------------------------------------
// Рендер
// ---------------------------------------------------------------------------

/**
 * Рендерер на базе браузерного воркера (server/deepdive/render/render-worker.mjs).
 * Микс рендерится целиком, слои — по одной партии за раз: движок не умеет
 * сольный рендер, поэтому слой собирается из отдельных рендеров партий.
 */
export function createWorkerRenderer(worker, { fromCycle = 0, toCycle = 16, sampleRate = 48000, cps } = {}) {
  const renderCode = async (code) => {
    const result = await worker.render({ code, fromCycle, toCycle, sampleRate, cps });
    if (!result?.ok) throw new Error('рендер не удался');
    const audio = decodeWav(result.wav);
    return { channels: audio.channels, sampleRate: audio.sampleRate };
  };
  return async function renderCandidate({ code, spec }) {
    const mix = await renderCode(code);
    const layers = { mix };
    for (const [layer, roles] of Object.entries(LAYER_ROLES)) {
      const present = roles.filter((role) => spec?.parts?.roles?.[role]);
      if (!present.length) continue;
      const layerSpec = {
        ...spec,
        parts: { roles: Object.fromEntries(present.map((role) => [role, spec.parts.roles[role]])) },
      };
      layers[layer] = await renderCode(compileTrackSpec(layerSpec));
    }
    return layers;
  };
}

// ---------------------------------------------------------------------------
// Цикл
// ---------------------------------------------------------------------------

function normalizeOptions(input) {
  const raw = input?.options ?? {};
  const pick = (key, fallback) => {
    for (const source of [raw, input]) {
      if (source && source[key] !== undefined && source[key] !== null) return source[key];
    }
    return fallback;
  };
  const iterations = Number(pick('iterations', DEFAULT_OPTIONS.iterations));
  const plateau = Number(pick('plateauThreshold', DEFAULT_OPTIONS.plateauThreshold));
  const tolerance = Number(pick('bpmTolerancePct', DEFAULT_OPTIONS.bpmTolerancePct));
  const gainMin = Number(pick('gainMin', DEFAULT_OPTIONS.gainMin));
  const gainMax = Number(pick('gainMax', DEFAULT_OPTIONS.gainMax));
  const lateTolerance = Number(pick('lateToleranceMs', DEFAULT_OPTIONS.lateToleranceMs));
  const maxOperations = Number(pick('maxOperations', DEFAULT_OPTIONS.maxOperations));
  const options = {
    iterations: Number.isFinite(iterations) && iterations > 0 ? Math.min(16, Math.floor(iterations)) : DEFAULT_OPTIONS.iterations,
    plateauThreshold: Number.isFinite(plateau) && plateau >= 0 ? plateau : DEFAULT_OPTIONS.plateauThreshold,
    bpmTolerancePct: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_OPTIONS.bpmTolerancePct,
    gainMin: Number.isFinite(gainMin) ? gainMin : DEFAULT_OPTIONS.gainMin,
    gainMax: Number.isFinite(gainMax) ? gainMax : DEFAULT_OPTIONS.gainMax,
    lateToleranceMs: Number.isFinite(lateTolerance) && lateTolerance >= 0 ? lateTolerance : DEFAULT_OPTIONS.lateToleranceMs,
    maxOperations: Number.isFinite(maxOperations) && maxOperations > 0 ? Math.floor(maxOperations) : DEFAULT_OPTIONS.maxOperations,
    temperature: Number(pick('temperature', DEFAULT_OPTIONS.temperature)),
    respond: pick('respond', pick('llm', null)),
    render: pick('render', null),
    worker: pick('worker', null),
    onIteration: pick('onIteration', null),
    reference: pick('reference', null),
    referenceBassNotes: pick('referenceBassNotes', null),
    referenceSwing: pick('referenceSwing', null),
    candidateBassNotes: pick('candidateBassNotes', null),
    candidateSwing: pick('candidateSwing', null),
    compare: pick('compare', null),
  };
  return options;
}

function normalizeMetrics(metrics) {
  const overall = Number(metrics?.overall);
  return {
    overall: Number.isFinite(overall) ? overall : 0,
    layers: metrics?.layers && typeof metrics.layers === 'object' ? clone(metrics.layers) : {},
  };
}

/** Стандартный компаратор: существующий compareTwin. */
function defaultCompare(reference, options) {
  return (candidate, { iteration, label, plan }) => compareTwin({
    reference,
    candidate,
    referenceBassNotes: options.referenceBassNotes ?? null,
    candidateBassNotes: options.candidateBassNotes
      ? options.candidateBassNotes(plan)
      : (candidate?.bassNotes ?? null),
    referenceSwing: options.referenceSwing ?? null,
    candidateSwing: options.candidateSwing
      ? options.candidateSwing(plan)
      : (candidate?.swing ?? null),
    iterationLabel: label,
    iteration,
  });
}

/** Стандартный ответ модели: LLM проекта. Сеть вызывается только здесь. */
async function defaultRespond({ messages, temperature }) {
  const { completeChat } = await import('../llm/client.js');
  return completeChat({
    messages,
    temperature,
    responseFormat: { type: 'json_object' },
  });
}

const BASE_CAVEATS = [
  'вокал не воспроизводится',
  'это ориентир по измеримому скелету, а не клон трека',
];

function failedEntry(iteration, reason, rejected = []) {
  return {
    iteration,
    label: `iteration-${iteration}`,
    status: 'failed',
    changes: [],
    metrics: null,
    delta: null,
    rejected: rejected.map((item) => ({ op: item.op, reason: item.reason })),
    error: reason,
    honesty: {
      claims: [],
      caveats: [reason, 'итерация ничего не изменила: план остался прежним', ...BASE_CAVEATS],
    },
  };
}

/**
 * Цикл самоулучшения двойника.
 *
 * @param {object} input
 * @param {object} input.plan план (TrackSpec) двойника
 * @param {string} [input.code] код текущего плана (пересобирается, если нет)
 * @param {object} input.metrics метрики baseline (результат compareTwin, iteration 0)
 * @param {object} [input.measurements] измерения оригинала
 * @param {object} [input.stem_descriptors] дескрипторы стемов (для проверки правок)
 * @param {object} [input.options] опции цикла (см. normalizeOptions)
 * @param {Function} [input.options.respond] функция ответа модели ({messages, payload, iteration}) => string|object
 * @param {Function} [input.options.render] функция рендера ({code, spec, iteration}) => {drums,bass,other,mix}
 * @param {object} [input.options.reference] оригинал для сравнения
 * @returns {Promise<{iterations:Array, best:object, log:string[], stopReason:string}>}
 */
export async function refineTwin(input = {}) {
  const options = normalizeOptions(input);
  const basePlan = clone(input.plan);
  if (!basePlan) throw new Error('Нужен план двойника (input.plan)');
  const baseline = normalizeMetrics(input.metrics);
  const measurements = input.measurements ?? {};
  const stems = pickStemDescriptors(input);

  if (options.respond !== null && typeof options.respond !== 'function') {
    throw new Error('options.respond должен быть функцией');
  }
  if (options.compare !== null && typeof options.compare !== 'function') {
    throw new Error('options.compare должен быть функцией');
  }
  const respond = typeof options.respond === 'function' ? options.respond : defaultRespond;
  const render = typeof options.render === 'function'
    ? options.render
    : (options.worker ? createWorkerRenderer(options.worker) : null);
  if (!render) throw new Error('Нужен рендерер: options.render (или options.worker)');
  const reference = options.reference ?? input.reference ?? null;
  if (!reference) throw new Error('Нужен оригинал для сравнения: options.reference');
  const compare = typeof options.compare === 'function'
    ? options.compare
    : defaultCompare(reference, options);

  const ctx = {
    basePlan,
    measuredBpm: pickTempo(input),
    measuredStepsByRole: measuredStepsByRole(stems, basePlan),
    measuredBassNotes: measuredBassNotes(stems, basePlan),
    options,
  };

  const iterations = [];
  const log = [];

  let currentPlan = clone(basePlan);
  let currentCode = typeof input.code === 'string' && input.code.trim()
    ? input.code
    : compileTrackSpec(currentPlan);
  let currentMetrics = baseline;
  let best = {
    iteration: 0,
    label: 'baseline',
    overall: baseline.overall,
    plan: clone(basePlan),
    code: currentCode,
    metrics: baseline,
  };

  iterations.push({
    iteration: 0,
    label: 'baseline',
    status: 'ok',
    changes: [],
    metrics: baseline,
    delta: { overall: 0 },
    rejected: [],
    honesty: {
      claims: [`базовая общая оценка ${baseline.overall} — из compareTwin`],
      caveats: [...BASE_CAVEATS],
    },
  });
  log.push(`baseline: общая оценка ${baseline.overall}`);

  let stopReason = null;
  let stopReasonCode = null;
  let stopReasonDetail = null;

  // Прогресс цикла: маршрут отдаёт его пользователю через SSE.
  // Ошибка в обработчике не должна ломать цикл.
  const notify = (entry) => {
    iterations.push(entry);
    if (typeof options.onIteration === 'function') {
      try {
        options.onIteration(entry, { log: [...log] });
      } catch {
        // обработчик прогресса не влияет на результат
      }
    }
  };

  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const payload = buildModelPayload({
      iteration,
      baseline,
      current: currentMetrics,
      measurements,
      stems,
      plan: currentPlan,
      ctx,
    });
    const messages = [
      { role: 'system', content: REFINE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ];

    let raw;
    try {
      raw = await respond({ messages, payload, iteration, temperature: options.temperature });
    } catch (err) {
      const reason = `ошибка запроса к модели: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    let operations;
    try {
      operations = parseModelOperations(raw);
    } catch (err) {
      const reason = `невалидный ответ модели: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }
    if (operations.length > options.maxOperations) {
      const dropped = operations.length - options.maxOperations;
      operations = operations.slice(0, options.maxOperations);
      log.push(`итерация ${iteration}: лишних операций отброшено — ${dropped} (максимум ${options.maxOperations})`);
    }

    const { plan: nextPlan, applied, rejected } = applyOperations(currentPlan, operations, ctx);
    for (const item of rejected) {
      log.push(`итерация ${iteration}: отклонено ${JSON.stringify(item.op)} — ${item.reason}`);
    }
    if (!applied.length) {
      const reason = rejected.length
        ? 'ни одна операция не подтверждена измерениями'
        : 'модель не предложила операций';
      notify(failedEntry(iteration, reason, rejected));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    let nextCode;
    try {
      nextCode = compileTrackSpec(nextPlan);
    } catch (err) {
      const reason = `план не принят компилятором: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason, rejected));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    let candidate;
    try {
      candidate = await render({ code: nextCode, spec: nextPlan, iteration });
    } catch (err) {
      const reason = `рендер не удался: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason, rejected));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    let nextMetrics;
    try {
      const rawMetrics = await compare(candidate, {
        iteration,
        label: `iteration-${iteration}`,
        plan: nextPlan,
      });
      nextMetrics = normalizeMetrics(rawMetrics);
    } catch (err) {
      const reason = `сравнение не удалось: ${err?.message ?? err}`;
      notify(failedEntry(iteration, reason, rejected));
      log.push(`итерация ${iteration}: ${reason}`);
      continue;
    }

    const improvement = nextMetrics.overall - baseline.overall;
    const delta = { overall: round4(improvement) };
    const layerDelta = {};
    for (const [name, field] of Object.entries(LAYER_SCORE_FIELD)) {
      const before = Number(baseline.layers?.[name]?.[field]);
      const after = Number(nextMetrics.layers?.[name]?.[field]);
      if (Number.isFinite(before) && Number.isFinite(after)) {
        layerDelta[name] = round4(after - before);
      }
    }
    if (Object.keys(layerDelta).length) delta.layers = layerDelta;

    const caveats = [...BASE_CAVEATS];
    if (rejected.length) {
      caveats.push(`отклонено операций: ${rejected.length} — значения не подтверждены измерениями`);
    }
    notify({
      iteration,
      label: `iteration-${iteration}`,
      status: 'ok',
      changes: applied.map((item) => item.description),
      metrics: nextMetrics,
      delta,
      plan: clone(nextPlan),
      rejected: rejected.map((item) => ({ op: item.op, reason: item.reason })),
      honesty: {
        claims: applied.map((item) => item.description),
        caveats,
      },
    });
    for (const item of applied) log.push(`итерация ${iteration}: ${item.description}`);
    log.push(
      `итерация ${iteration}: общая оценка ${baseline.overall} → ${nextMetrics.overall} (дельта ${delta.overall})`,
    );

    const previousBest = best;
    // «Лучший» — последняя версия, которая не хуже лучшей: при равной оценке
    // предпочитаем более поздний план (он может отличаться деталями).
    if (nextMetrics.overall >= best.overall) {
      best = {
        iteration,
        label: `iteration-${iteration}`,
        overall: nextMetrics.overall,
        plan: clone(nextPlan),
        code: nextCode,
        metrics: nextMetrics,
      };
    }
    if (nextMetrics.overall < previousBest.overall) {
      // Ухудшение: возвращаемся к лучшему плану, чтобы цикл не деградировал.
      currentPlan = clone(previousBest.plan);
      currentCode = previousBest.code;
      currentMetrics = previousBest.metrics;
      log.push(`итерация ${iteration}: оценка хуже лучшей — план возвращён к итерации ${previousBest.iteration}`);
    } else {
      currentPlan = nextPlan;
      currentCode = nextCode;
      currentMetrics = nextMetrics;
    }

    if (improvement < options.plateauThreshold) {
      stopReason = 'плато';
      stopReasonCode = 'plateau';
      stopReasonDetail = improvement < 0
        ? `общая оценка упала на ${round4(Math.abs(improvement))} относительно baseline (порог улучшения ${options.plateauThreshold})`
        : `улучшение ${round4(improvement)} меньше порога ${options.plateauThreshold}`;
      log.push(`стоп: плато (plateau) — ${stopReasonDetail}`);
      break;
    }
  }

  if (!stopReason) {
    stopReason = 'бюджет итераций';
    stopReasonCode = 'budget';
    stopReasonDetail = `итераций: ${options.iterations}`;
    log.push(`стоп: бюджет итераций исчерпан (${options.iterations})`);
  }

  return {
    iterations,
    best,
    log,
    stopReason,
    stopReasonCode,
    stopReasonDetail,
    baseline: iterations[0],
    method: REFINE_METHOD,
  };
}

export default refineTwin;

// Псевдонимы точки входа — чтобы цикл можно было вызвать из маршрута
// /api/deepdive/refine любым из привычных имён.
export const refineCodeTwin = refineTwin;
export const runRefineLoop = refineTwin;
