// Чистые детерминированные углы над каноническим TrackSpec.
import { cloneSpec, hashText, sameSpec } from './diversity.js';
import { mutateProgression, mutateRecipe } from './mutations.js';

export function angleForm(spec, start = 0) {
  const out = cloneSpec(spec);
  const sections = out.structure.sections;
  for (let i = 0; i < sections.length - 1; i += 1) {
    const shift = 1 + ((start + i) % (sections.length - 1));
    out.structure.sections = [...sections.slice(shift), ...sections.slice(0, shift)];
    if (!sameSpec(spec, out)) return out;
  }
  return out;
}

export function angleProgression(spec, start = 0) {
  return mutateProgression(spec, start);
}

export function angleRoles(spec, start = 0) {
  return mutateRecipe(spec, start);
}

export function angleEnergy(spec, start = 0) {
  const out = cloneSpec(spec);
  const sections = out.structure.sections;
  const energies = sections.map((section) => section.energy);
  // Сначала меняем всю арку; на ровной арке делаем явный контраст.
  sections.forEach((section, i) => {
    section.energy = energies[(i + 1 + start % Math.max(1, sections.length - 1)) % sections.length];
  });
  if (sameSpec(out, spec)) {
    sections.forEach((section, i) => { section.energy = i % 2 ? 0.9 : 0.2; });
  }
  return out;
}

export function angleMotif(spec, start = 0) {
  const out = cloneSpec(spec);
  const roles = out.parts.roles;
  const target = roles.lead || roles.arp || roles.bass || roles.pad || roles.chords;
  if (target) target.pattern = `${target.pattern} ${'~ '.repeat(1 + start % 3).trim()}`;
  else {
    roles.lead = { activeIn: [...new Set(out.structure.sections.map((section) => section.name))],
      pattern: '0 ~ 2 4', sound: 'sine' };
  }
  return out;
}

export const ANGLES = {
  form: angleForm, progression: angleProgression, roles: angleRoles,
  energy: angleEnergy, motif: angleMotif,
};
export const ANGLE_NAMES = Object.keys(ANGLES);

export function applyAngle(spec, angleName, seed = 0) {
  const angle = ANGLES[angleName];
  return angle ? angle(spec, hashText(`${seed}|${angleName}`) % 16) : cloneSpec(spec);
}
