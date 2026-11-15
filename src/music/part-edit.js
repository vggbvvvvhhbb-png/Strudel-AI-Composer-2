// Типизированные правки конкретной дорожки (D-105).
//
// Требование гейта C: правка «замени тембр виолончели и сделай её партию
// мрачнее в сцене 2» выполняется БЕЗ перегенерации остальных дорожек.
// Значит, правка должна быть чистой функцией от спеки, которая трогает
// ровно одну партию и возвращает список затронутых идентификаторов.
//
// Правки адресуют партию по id (`VIOLIN_3`), а не по роли: у одной роли
// может быть много дорожек, и «правка всех скрипок» — это другая
// операция (см. deepdive/refine/ops.js, где слои адресуются по роли).

// Операции и их контракт. params — ровно то, что нужно операции.
export const PART_OPS = {
  setSound: 'заменить тембр дорожки',
  setPattern: 'заменить рисунок дорожки',
  setGain: 'изменить громкость дорожки (дБ)',
  setRole: 'изменить роль дорожки',
  setSectionPattern: 'изменить рисунок дорожки в секции',
  setSectionSound: 'изменить тембр дорожки в секции',
  setActiveIn: 'изменить список секций, где играет дорожка',
  removePart: 'убрать дорожку из трека',
  addPart: 'добавить дорожку в трек',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function partOf(spec, id) {
  return spec.parts?.roles?.[id] ?? null;
}

/**
 * Применяет правку к одной дорожке.
 *
 * @param {object} spec каноническая TrackSpec
 * @param {object} edit {id, op, params}
 * @returns {{ok: boolean, spec: object|null, changed: string[], error: string|null}}
 */
export function applyPartEdit(spec, edit) {
  const { id, op, params = {} } = edit ?? {};
  if (!PART_OPS[op]) {
    return { ok: false, spec: null, changed: [], error: `неизвестная операция «${op}»` };
  }
  const next = clone(spec);

  if (op === 'addPart') {
    const part = params.part;
    if (!part || typeof part !== 'object') {
      return { ok: false, spec: null, changed: [], error: 'addPart: нужен объект part' };
    }
    if (partOf(next, id)) {
      return { ok: false, spec: null, changed: [], error: `дорожка «${id}» уже есть` };
    }
    next.parts.roles[id] = part;
    return { ok: true, spec: next, changed: [id], error: null };
  }

  const part = partOf(next, id);
  if (!part) {
    return { ok: false, spec: null, changed: [], error: `дорожки «${id}» нет в треке` };
  }

  switch (op) {
    case 'setSound': {
      if (typeof params.sound !== 'string' || !params.sound.trim()) {
        return { ok: false, spec: null, changed: [], error: 'setSound: нужен sound' };
      }
      part.sound = params.sound;
      break;
    }
    case 'setPattern': {
      if (typeof params.pattern !== 'string') {
        return { ok: false, spec: null, changed: [], error: 'setPattern: нужен pattern' };
      }
      part.pattern = params.pattern;
      break;
    }
    case 'setGain': {
      const db = Number(params.gainDb);
      if (!Number.isFinite(db)) {
        return { ok: false, spec: null, changed: [], error: 'setGain: нужен gainDb (число)' };
      }
      const linear = Math.pow(10, db / 20);
      part.effects = (part.effects ?? []).filter((effect) => effect.name !== 'gain');
      part.effects.push({ name: 'gain', params: [Number(linear.toFixed(4))] });
      break;
    }
    case 'setRole': {
      if (typeof params.role !== 'string' || !/^[a-z][a-z0-9_]*$/.test(params.role)) {
        return { ok: false, spec: null, changed: [], error: 'setRole: роль должна быть строчной строкой' };
      }
      part.role = params.role;
      break;
    }
    case 'setSectionPattern':
    case 'setSectionSound': {
      const section = params.section;
      if (typeof section !== 'string' || !section.trim()) {
        return { ok: false, spec: null, changed: [], error: `${op}: нужна секция` };
      }
      const key = op === 'setSectionPattern' ? 'pattern' : 'sound';
      const value = params[key];
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, spec: null, changed: [], error: `${op}: нужен ${key}` };
      }
      part.sections = part.sections ?? {};
      part.sections[section] = { ...(part.sections[section] ?? {}), [key]: value };
      break;
    }
    case 'setActiveIn': {
      if (!Array.isArray(params.activeIn) || params.activeIn.some((name) => typeof name !== 'string')) {
        return { ok: false, spec: null, changed: [], error: 'setActiveIn: нужен массив имён секций' };
      }
      part.activeIn = [...params.activeIn];
      break;
    }
    case 'removePart': {
      delete next.parts.roles[id];
      return { ok: true, spec: next, changed: [id], error: null };
    }
    default:
      return { ok: false, spec: null, changed: [], error: `неизвестная операция «${op}»` };
  }

  return { ok: true, spec: next, changed: [id], error: null };
}

/**
 * Применяет несколько правок по очереди. Каждая — чистая функция:
 * предыдущая не влияет на следующую, кроме общей спеки.
 */
export function applyPartEdits(spec, edits) {
  let current = spec;
  const changed = [];
  for (const edit of edits ?? []) {
    const result = applyPartEdit(current, edit);
    if (!result.ok) return { ok: false, spec: null, changed, error: result.error };
    current = result.spec;
    changed.push(...result.changed);
  }
  return { ok: true, spec: current, changed, error: null };
}
