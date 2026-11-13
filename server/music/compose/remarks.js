// Локальные правки канонического TrackSpec: новые поля не добавляются.
import { validateTrackSpec } from '../../../src/schemas/track-spec.schema.js';

export const REMARK_KINDS = {
  HARMONY_WALL: 'harmony-wall',
  FLAT_ENERGY: 'flat-energy',
  REPEATED_PART: 'repeated-part',
  MISSING_TRANSITION: 'missing-transition',
  THIN_ARRANGEMENT: 'thin-arrangement',
  NO_MOTIF: 'no-motif',
};

export function energyProfile(sections) {
  const energies = (sections || []).map((section) => Number(section.energy) || 0);
  if (energies.length < 2) return { range: 0, maxJump: 0, flat: true };
  const range = Math.max(...energies) - Math.min(...energies);
  let maxJump = 0;
  for (let i = 1; i < energies.length; i += 1) {
    maxJump = Math.max(maxJump, Math.abs(energies[i] - energies[i - 1]));
  }
  return { range, maxJump, flat: range < 0.25 || maxJump < 0.1 };
}

export function collectRemarks(input, context = {}) {
  const spec = validateTrackSpec(input);
  const sections = spec.structure.sections;
  const roles = spec.parts.roles;
  const remarks = [];
  if (!sections.length) return remarks;
  const total = sections.reduce((sum, section) => sum + section.cycles, 0);
  if (sections.length >= 3 && new Set(sections.map((section) => section.harmony)).size === 1) {
    remarks.push({
      id: 'harmony-wall', kind: REMARK_KINDS.HARMONY_WALL,
      label: 'Гармония не меняется',
      hint: `Одна гармония ${total} тактов подряд. Измени harmony одной из секций, чтобы гармония двигалась.`,
      action: { type: 'change-progression', sectionIndex: 1 },
    });
  }
  const energy = energyProfile(sections);
  if (sections.length > 1 && energy.flat) {
    remarks.push({
      id: 'flat-energy', kind: REMARK_KINDS.FLAT_ENERGY,
      label: 'Энергия плоская',
      hint: `Размах энергии ${energy.range.toFixed(2)}. Опусти энергию первой секции до 0.3 и подними кульминацию до 0.9.`,
      action: { type: 'reshape-energy', quietIndex: 0, loudIndex: sections.length - 1 },
    });
  }
  for (const [role, part] of Object.entries(roles)) {
    if (sections.length > 1 && sections.every((section) => part.activeIn.includes(section.name))) {
      remarks.push({
        id: `repeated-part:${role}`, kind: REMARK_KINDS.REPEATED_PART,
        label: `Партия «${role}» не меняется`,
        hint: `«${role}» повторяется во всех секциях. Измени activeIn: убери партию из тихой секции, оставив остальные партии.`,
        action: { type: 'vary-part', role },
      });
    }
  }
  for (let i = 1; i < sections.length; i += 1) {
    const section = sections[i];
    if (!['drop', 'chorus', 'breakdown'].includes(section.name)) continue;
    if (section.parameters?.gain || section.parameters?.cutoff) continue;
    remarks.push({
      id: `missing-transition:${i - 1}`, kind: REMARK_KINDS.MISSING_TRANSITION,
      label: `Нет перехода в «${section.name}»`,
      hint: `Добавь переход в «${section.name}» через parameters.gain: плавное изменение громкости секции.`,
      action: { type: 'add-transition', sectionIndex: i },
    });
  }
  const thin = sections.findIndex((section) => Object.values(roles).filter((part) => part.activeIn.includes(section.name)).length < 2);
  if (thin >= 0) {
    remarks.push({
      id: 'thin-arrangement', kind: REMARK_KINDS.THIN_ARRANGEMENT,
      label: 'Секция почти пустая',
      hint: `В секции «${sections[thin].name}» мало партий. Добавь вторую партию в parts.roles и её имя секции в activeIn.`,
      action: { type: 'add-role', sectionIndex: thin },
    });
  }
  for (const role of ['lead', 'arp']) {
    if (roles[role] && !roles[role].pattern.trim()) {
      remarks.push({
        id: 'no-motif', kind: REMARK_KINDS.NO_MOTIF,
        label: 'Нет мелодического мотива',
        hint: `В партии «${role}» пустой pattern. Задай мотив степенями лада: "4 ~ 2 0 2".`,
        action: { type: 'add-motif', role },
      });
    }
  }
  if (Array.isArray(context.extraRemarks)) remarks.push(...context.extraRemarks);
  return remarks;
}

export function applyRemark(input, remark) {
  if (!input || !remark) return input;
  // parse создаёт новую вложенную структуру, не меняя исходный план.
  const next = validateTrackSpec(input);
  const sections = next.structure.sections;
  const roles = next.parts.roles;
  const action = remark.action || {};
  switch (action.type) {
    case 'change-progression': {
      const section = sections[action.sectionIndex];
      if (!section) break;
      const chords = section.harmony.trim().split(/\s+/);
      // Циклический сдвиг гармонии сохраняет выбранные аккорды и лад.
      if (chords.length > 1) section.harmony = [...chords.slice(1), chords[0]].join(' ');
      break;
    }
    case 'reshape-energy': {
      if (sections[action.quietIndex]) sections[action.quietIndex].energy = 0.3;
      if (sections[action.loudIndex]) sections[action.loudIndex].energy = 0.9;
      break;
    }
    case 'vary-part': {
      const part = roles[action.role];
      if (!part) break;
      const quiet = sections.find((section) => section.energy < 0.5
        && part.activeIn.includes(section.name)
        && Object.entries(roles).some(([role, other]) => role !== action.role && other.activeIn.includes(section.name)));
      if (quiet) part.activeIn = part.activeIn.filter((name) => name !== quiet.name);
      break;
    }
    case 'add-transition': {
      const section = sections[action.sectionIndex];
      if (section) section.parameters = {
        ...section.parameters,
        gain: section.name === 'breakdown' ? [1, 0.5] : [0.6, 1],
      };
      break;
    }
    case 'add-role': {
      const section = sections[action.sectionIndex];
      if (!section) break;
      const candidate = ['hats', 'pad', 'texture', 'perc'].find((role) => !roles[role]?.activeIn.includes(section.name));
      if (!candidate) break;
      if (roles[candidate]) roles[candidate].activeIn.push(section.name);
      else roles[candidate] = {
        activeIn: [section.name],
        pattern: candidate === 'hats' ? 'hh*8' : candidate === 'perc' ? '~ perc ~ perc' : '0 ~ 2 ~',
        sound: candidate === 'hats' ? 'hh' : candidate === 'perc' ? 'perc' : 'sine',
      };
      break;
    }
    case 'add-motif': {
      const part = roles[action.role || 'lead'];
      if (part) part.pattern = '4 ~ 2 0 2';
      break;
    }
    default: break;
  }
  return validateTrackSpec(next);
}
