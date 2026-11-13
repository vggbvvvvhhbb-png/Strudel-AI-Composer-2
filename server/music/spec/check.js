// Смысловые ограничения канонической TrackSpec. Форму проверяет единая Zod-схема.
import { TrackSpecSchema } from '../../../src/schemas/track-spec.schema.js';

export const MIN_BARS = 16;
export const MAX_BARS = 96;

// Сохранённый публичный экспорт; новая запись тональности — Cmin, а не c:minor.
export function parseSpecKey(key) {
  const match = String(key ?? '').match(/^([A-G])([#b]?)([a-z]*)$/);
  return match ? { root: `${match[1]}${match[2]}`.toLowerCase(), mode: match[3] || 'major' } : null;
}

/** Возвращает прежний формат {ok, errors, warnings, spec}, без нормализации старой формы. */
export function checkSpec(raw) {
  const errors = [];
  const warnings = [];
  const parsed = TrackSpecSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join('.') || 'спека'}: ${issue.message}`);
    }
    return { ok: false, errors, warnings, spec: null };
  }

  const spec = parsed.data;
  const sections = spec.structure.sections;
  const roles = spec.parts.roles;
  const total = sections.reduce((sum, section) => sum + section.cycles, 0);
  if (total < MIN_BARS) errors.push(`structure.sections: ${total} тактов — меньше минимума ${MIN_BARS}`);
  if (total > MAX_BARS) errors.push(`structure.sections: ${total} тактов — больше максимума ${MAX_BARS}`);
  if (!sections.length) errors.push('structure.sections: трек не содержит секций');

  // activeIn ссылается на имя: партия активна во всех одноимённых секциях.
  const names = new Set(sections.map((section) => section.name));

  for (const [role, part] of Object.entries(roles)) {
    if (!part.activeIn.length) warnings.push(`parts.roles.${role}.activeIn: партия не играет ни в одной секции`);
    for (const [index, name] of part.activeIn.entries()) {
      if (!names.has(name)) errors.push(`parts.roles.${role}.activeIn.${index}: секции «${name}» нет`);
      if (part.activeIn.indexOf(name) !== index) {
        errors.push(`parts.roles.${role}.activeIn.${index}: повтор секции «${name}»`);
      }
    }
  }
  sections.forEach((section, index) => {
    if (!Object.values(roles).some((part) => part.activeIn.includes(section.name))) {
      warnings.push(`structure.sections.${index}: секция «${section.name}» без партий`);
    }
  });

  return { ok: errors.length === 0, errors, warnings, spec: errors.length ? null : spec };
}

/** Сохранённый экспорт: гармония секции теперь является её строковым полем. */
export function progressionForSection(spec, index) {
  const parsed = TrackSpecSchema.parse(spec);
  return parsed.structure.sections[index]?.harmony ?? null;
}
