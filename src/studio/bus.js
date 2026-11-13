// Командная шина мини-студии.
//
// Единственный способ изменить проект — команда. GUI, ассистент, автосмей и
// импорт работают через неё, поэтому у каждого изменения есть автор
// (`source`), атомарная группа (`groupId`) и откат.
//
// Инварианты:
//   • reduce(model, command) — чистая функция: без Date.now(), Math.random()
//     и без мутации аргументов;
//   • каждая команда валидируется Zod-схемой ДО применения;
//   • undo возвращает канонический JSON бит-в-бит и тот же хеш кода;
//   • история ограничена 200 записями, жесты склеиваются по groupId.

import { z } from 'zod';
import { canonicalJson, ProjectModelSchema, ROLES } from './model.js';

export const COMMAND_TYPES = [
  'setBpm', 'setKey', 'setProgression',
  'addSection', 'removeSection', 'resizeSection', 'duplicateSection',
  'setRole', 'editNotes', 'setMix', 'setMaster',
  'addTransition', 'setAutomation',
  'mutate', 'applyAutoMix',
];

export const SOURCES = ['user', 'assistant', 'system'];

const SectionNameSchema = z.enum([
  'intro', 'build', 'drop', 'breakdown',
  'fill', 'outro', 'verse', 'chorus', 'bridge',
]);

const RoleSchema = z.enum(ROLES);

export const CommandSchema = z.object({
  id: z.string().min(1),
  groupId: z.string().min(1),
  source: z.enum(SOURCES),
  type: z.enum(COMMAND_TYPES),
  payload: z.record(z.any()),
});

/** Схемы payload'ов по типам команды. */
export const PAYLOAD_SCHEMAS = {
  setBpm: z.object({ bpm: z.number().min(60).max(180) }),
  setKey: z.object({ key: z.string().regex(/^[A-G][#b]?[a-z]*$/) }),
  setProgression: z.object({ section: z.string().min(1), harmony: z.string().min(1) }),
  addSection: z.object({
    name: SectionNameSchema,
    cycles: z.number().int().min(1).max(64),
    energy: z.number().min(0).max(1),
    harmony: z.string().min(1),
    at: z.number().int().min(0).optional(),
  }),
  removeSection: z.object({ name: z.string().min(1) }),
  resizeSection: z.object({ name: z.string().min(1), cycles: z.number().int().min(1).max(64) }),
  duplicateSection: z.object({ name: z.string().min(1) }),
  setRole: z.object({
    role: RoleSchema,
    sound: z.string().min(1).optional(),
    pattern: z.string().min(1).optional(),
    activeIn: z.array(z.string().min(1)).optional(),
    recipe: z.enum(['default', 'busy', 'sparse']).optional(),
  }),
  editNotes: z.object({ role: RoleSchema, notes: z.string() }),
  setMix: z.object({
    role: RoleSchema,
    patch: z.object({
      gainDb: z.number().min(-60).max(12).optional(),
      pan: z.number().min(-1).max(1).optional(),
      hpf: z.number().min(0).max(2000).optional(),
      lpf: z.number().min(1000).max(20000).optional(),
      sends: z.object({
        delay: z.number().min(0).max(1).optional(),
        room: z.number().min(0).max(1).optional(),
      }).optional(),
      duck: z.object({
        target: z.string().nullable().optional(),
        depth: z.number().min(0).max(1).optional(),
        attackMs: z.number().min(5).max(30).optional(),
        releaseMs: z.number().min(100).max(400).optional(),
      }).optional(),
    }),
  }),
  setMaster: z.object({
    patch: z.object({
      targetLufs: z.number().min(-24).max(-9).optional(),
      ceilingDbtp: z.number().min(-3).max(0).optional(),
      eq: z.object({ lowDb: z.number().min(-12).max(12).optional(), highDb: z.number().min(-12).max(12).optional() }).optional(),
      comp: z.object({
        thresholdDb: z.number().min(-24).max(-18).optional(),
        ratio: z.number().min(2).max(4).optional(),
        attackMs: z.number().min(10).max(50).optional(),
        releaseMs: z.number().min(100).max(300).optional(),
      }).optional(),
      limiter: z.object({
        lookaheadMs: z.number().min(4).max(16).optional(),
        ceilingDbtp: z.number().min(-3).max(0).optional(),
      }).optional(),
      bypass: z.boolean().optional(),
    }),
  }),
  addTransition: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    type: z.enum(['fill', 'riser', 'cut', 'none']),
    amount: z.number().min(0).max(1),
  }),
  setAutomation: z.object({
    id: z.string().min(1).optional(),
    target: z.union([
      z.object({ kind: z.literal('section'), id: z.string().min(1) }),
      z.object({ kind: z.literal('part'), id: RoleSchema }),
    ]),
    param: z.enum(['gain', 'cutoff', 'energy']),
    curve: z.object({
      type: z.enum(['ramp', 'sine', 'step']),
      from: z.number(),
      to: z.number(),
      bars: z.number().int().min(1).max(64),
    }),
  }),
  mutate: z.object({
    role: RoleSchema,
    field: z.enum(['pattern', 'sound', 'activeIn']),
    value: z.union([z.string(), z.array(z.string())]),
  }),
  applyAutoMix: z.object({
    changes: z.array(z.object({
      role: RoleSchema,
      patch: z.record(z.any()),
    })).max(32),
    report: z.record(z.any()).optional(),
  }),
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Схемы payload'ов в строгом режиме: неизвестное поле — ошибка, а не тихое
// игнорирование. Иначе команда с опечаткой в поле выглядела бы как успешная.
const STRICT_PAYLOAD_SCHEMAS = Object.fromEntries(
  Object.entries(PAYLOAD_SCHEMAS).map(([type, schema]) => [type, schema.strict()]),
);

function sectionIndex(model, name) {
  return model.spec.structure.sections.findIndex((section) => section.name === name);
}

function requireRole(model, role) {
  if (!model.spec.parts.roles[role]) {
    throw new Error(`команда: роли «${role}» нет в проекте`);
  }
  return model.spec.parts.roles[role];
}

/**
 * Чистый редьюсер: модель + команда → новая модель.
 * Бросает ошибку, если команда невалидна или её нельзя применить.
 */
export function reduce(model, command) {
  const validated = CommandSchema.parse(command);
  const payload = STRICT_PAYLOAD_SCHEMAS[validated.type]?.parse(validated.payload ?? {});
  const next = clone(model);

  switch (validated.type) {
    case 'setBpm':
      next.spec.meta.bpm = payload.bpm;
      break;

    case 'setKey':
      next.spec.meta.key = payload.key;
      break;

    case 'setProgression': {
      const index = sectionIndex(next, payload.section);
      if (index === -1) throw new Error(`команда: секции «${payload.section}» нет`);
      next.spec.structure.sections[index].harmony = payload.harmony;
      break;
    }

    case 'addSection': {
      const section = {
        name: payload.name,
        cycles: payload.cycles,
        energy: payload.energy,
        harmony: payload.harmony,
      };
      const at = payload.at ?? next.spec.structure.sections.length;
      next.spec.structure.sections.splice(at, 0, section);
      break;
    }

    case 'removeSection': {
      const index = sectionIndex(next, payload.name);
      if (index === -1) throw new Error(`команда: секции «${payload.name}» нет`);
      next.spec.structure.sections.splice(index, 1);
      for (const part of Object.values(next.spec.parts.roles)) {
        part.activeIn = part.activeIn.filter((name) => name !== payload.name);
      }
      break;
    }

    case 'resizeSection': {
      const index = sectionIndex(next, payload.name);
      if (index === -1) throw new Error(`команда: секции «${payload.name}» нет`);
      next.spec.structure.sections[index].cycles = payload.cycles;
      break;
    }

    case 'duplicateSection': {
      const index = sectionIndex(next, payload.name);
      if (index === -1) throw new Error(`команда: секции «${payload.name}» нет`);
      const copy = clone(next.spec.structure.sections[index]);
      next.spec.structure.sections.splice(index + 1, 0, copy);
      break;
    }

    case 'setRole': {
      const part = requireRole(next, payload.role);
      if (payload.sound !== undefined) part.sound = payload.sound;
      if (payload.pattern !== undefined) part.pattern = payload.pattern;
      if (payload.activeIn !== undefined) part.activeIn = payload.activeIn;
      if (payload.recipe !== undefined) {
        const variants = (part.variants || []).filter((variant) => variant.kind !== 'recipe');
        variants.push({
          id: `${payload.role}-recipe`,
          kind: 'recipe',
          value: payload.recipe,
        });
        part.variants = variants;
      }
      break;
    }

    case 'editNotes': {
      const part = requireRole(next, payload.role);
      const variants = (part.variants || []).filter((variant) => variant.kind !== 'notes');
      if (payload.notes) {
        variants.push({ id: `${payload.role}-notes`, kind: 'notes', value: payload.notes });
      }
      part.variants = variants;
      break;
    }

    case 'setMix': {
      const current = next.mix.parts[payload.role] || {};
      const patch = payload.patch;
      next.mix.parts[payload.role] = {
        ...current,
        ...patch,
        sends: { ...(current.sends || {}), ...(patch.sends || {}) },
        duck: { ...(current.duck || {}), ...(patch.duck || {}) },
      };
      break;
    }

    case 'setMaster': {
      const patch = payload.patch;
      next.master = {
        ...next.master,
        ...patch,
        eq: { ...next.master.eq, ...(patch.eq || {}) },
        comp: { ...next.master.comp, ...(patch.comp || {}) },
        limiter: { ...next.master.limiter, ...(patch.limiter || {}) },
      };
      break;
    }

    case 'addTransition': {
      next.transitions = next.transitions.filter(
        (transition) => !(transition.from === payload.from && transition.to === payload.to),
      );
      next.transitions.push({
        id: `${payload.from}->${payload.to}`,
        from: payload.from,
        to: payload.to,
        type: payload.type,
        amount: payload.amount,
      });
      break;
    }

    case 'setAutomation': {
      const id = payload.id || `${payload.target.kind}:${payload.target.id}:${payload.param}`;
      next.automation = next.automation.filter((item) => item.id !== id);
      next.automation.push({ id, ...payload, id });
      break;
    }

    case 'mutate': {
      const part = requireRole(next, payload.role);
      if (payload.field === 'pattern' || payload.field === 'sound') {
        part[payload.field] = String(payload.value);
      } else {
        part.activeIn = payload.value;
      }
      break;
    }

    case 'applyAutoMix': {
      for (const change of payload.changes) {
        const current = next.mix.parts[change.role] || {};
        next.mix.parts[change.role] = { ...current, ...change.patch };
      }
      break;
    }

    default:
      throw new Error(`команда: неизвестный тип «${validated.type}»`);
  }

  // Модель всегда остаётся валидной: редусер — единственная точка мутации.
  return ProjectModelSchema.parse(next);
}

/** Создаёт команду с детерминированным id (без случайности и без часов). */
let counter = 0;
export function createCommand(type, payload, { source = 'user', groupId, id } = {}) {
  counter += 1;
  const commandId = id || `cmd-${counter}`;
  return {
    id: commandId,
    groupId: groupId || commandId,
    source,
    type,
    payload: payload ?? {},
  };
}

/**
 * Хранилище проекта: модель, история, undo/redo, атомарные группы.
 *
 * Группа — набор команд с общим groupId: применяются вместе и откатываются
 * одной кнопкой (так работает, например, autoMix и «применить совет»).
 */
export function createStore(initialModel, { historyLimit = 200, onChange } = {}) {
  let model = ProjectModelSchema.parse(initialModel);
  let history = [];
  let future = [];
  let openGroup = null;
  let sequence = 0;

  function snapshot() {
    return canonicalJson(model);
  }

  function notify(reason) {
    onChange?.({ model, reason });
  }

  function pushHistory(entry) {
    sequence += 1;
    history = [...history, { ...entry, at: sequence }].slice(-historyLimit);
  }

  const store = {
    get model() {
      return model;
    },
    get history() {
      return history.map((entry) => ({ ...entry }));
    },
    get canUndo() {
      return history.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },

    /** Применяет команду. Внутри открытой группы — в неё, иначе — отдельной записью. */
    dispatch(command) {
      const validated = CommandSchema.parse(command);
      const before = snapshot();
      model = reduce(model, validated);
      future = [];
      if (openGroup && openGroup.id === validated.groupId) {
        openGroup.commands.push(validated);
      } else {
        pushHistory({
          groupId: validated.groupId,
          label: validated.type,
          before,
          snapshot: snapshot(),
        });
      }
      notify('dispatch');
      return model;
    },

    /** Начинает атомарную группу: следующие команды попадут в одну запись истории. */
    beginGroup(groupId) {
      openGroup = { id: groupId, before: snapshot(), commands: [] };
      return groupId;
    },

    /** Закрывает группу одной записью истории. */
    commitGroup(label) {
      if (!openGroup || !openGroup.commands.length) {
        openGroup = null;
        return false;
      }
      pushHistory({
        groupId: openGroup.id,
        label: label || openGroup.commands.map((c) => c.type).join('+'),
        before: openGroup.before,
        snapshot: snapshot(),
      });
      openGroup = null;
      notify('group');
      return true;
    },

    /** Откат последней группы/команды. */
    undo() {
      if (!history.length) return false;
      const entry = history[history.length - 1];
      model = ProjectModelSchema.parse(JSON.parse(entry.before));
      history = history.slice(0, -1);
      future = [...future, entry];
      notify('undo');
      return true;
    },

    redo() {
      if (!future.length) return false;
      const entry = future[future.length - 1];
      model = ProjectModelSchema.parse(JSON.parse(entry.snapshot));
      future = future.slice(0, -1);
      pushHistory(entry);
      notify('redo');
      return true;
    },

    /** Заменяет проект целиком (импорт/загрузка) — история очищается. */
    replace(nextModel) {
      model = ProjectModelSchema.parse(nextModel);
      history = [];
      future = [];
      openGroup = null;
      notify('replace');
      return model;
    },
  };

  return store;
}
