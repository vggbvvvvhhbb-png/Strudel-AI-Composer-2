// Детерминированные мутации канонической TrackSpec; исходный объект не меняется.
import { progressionForSection } from './spec/check.js';
import { cloneSpec, hashText } from './diversity.js';

const sectionsOf = (spec) => spec.structure?.sections || [];

// Не интерпретируем гармонию как старый объект прогрессии: переставляем только
// уже заданные аккорды, если перестановка действительно меняет строку.
function rotateHarmony(harmony, offset) {
  const chords = harmony.trim().split(/\s+/);
  if (chords.length < 2 || new Set(chords).size < 2 ||
    !chords.every((chord) => /^[A-G][#b]?(?:(?:maj|min|m|major|minor)|(?::(?:maj|min|major|minor)))?$/.test(chord))) {
    return harmony;
  }
  const shift = 1 + (offset % (chords.length - 1));
  return [...chords.slice(shift), ...chords.slice(0, shift)].join(' ');
}

/** Другая последовательность уже заданных аккордов во всех секциях. */
export function mutateProgression(spec, seed = 0) {
  const out = cloneSpec(spec);
  out.structure.sections.forEach((section) => {
    section.harmony = rotateHarmony(section.harmony, hashText(`${seed}|progression`));
  });
  return out;
}

/** Локальная перестановка аккордов секции; не создаёт объектных степеней. */
export function mutateTranspose(spec, seed = 0) {
  const out = cloneSpec(spec);
  const sections = sectionsOf(out);
  if (!sections.length) return out;
  const index = hashText(`${seed}|transpose|section`) % sections.length;
  sections[index].harmony = rotateHarmony(progressionForSection(out, index), hashText(`${seed}|transpose|delta`));
  return out;
}

/** Ритмическая вариация существующего рисунка партии. */
export function mutateRecipe(spec, seed = 0) {
  const out = cloneSpec(spec);
  const roles = Object.keys(out.parts.roles).sort();
  if (!roles.length) return out;
  const role = roles[hashText(`${seed}|recipe|role`) % roles.length];
  const part = out.parts.roles[role];
  // Пустой рисунок не даёт основы для вариации; оставляем валидную копию.
  if (part.pattern.trim()) {
    const rests = 1 + (Math.abs(Math.trunc(seed)) % 4);
    part.pattern = `${part.pattern} ${Array(rests).fill('~').join(' ')}`;
  }
  return out;
}

/** Добавить четырёхцикловый филл, не выходя за верхнюю границу длительности. */
export function mutateFill(spec, seed = 0) {
  const out = cloneSpec(spec);
  const sections = sectionsOf(out);
  if (!sections.length || !Object.keys(out.parts.roles).length) return out;
  const total = sections.reduce((sum, section) => sum + section.cycles, 0);
  if (total + 4 > 96) return out;
  const last = sections[sections.length - 1];
  const energy = Math.min(1, Math.round((last.energy + 0.1) * 100) / 100);
  sections.push({ name: 'fill', cycles: 4, energy, harmony: last.harmony });
  // activeIn действует сразу на все одноимённые секции, включая старые fill.
  const roles = Object.keys(out.parts.roles).sort();
  const role = roles[hashText(`${seed}|fill|role`) % roles.length];
  if (!out.parts.roles[role].activeIn.includes('fill')) out.parts.roles[role].activeIn.push('fill');
  return out;
}

/** Сдвиг энергии одной секции. */
export function mutateEnergy(spec, seed = 0) {
  const out = cloneSpec(spec);
  const sections = sectionsOf(out);
  if (!sections.length) return out;
  const index = hashText(`${seed}|energy|section`) % sections.length;
  const section = sections[index];
  const current = section.energy;
  const delta = 0.05 + (hashText(`${seed}|energy|delta`) % 3) * 0.05;
  const up = Math.min(1, current + delta);
  const down = Math.max(0, current - delta);
  section.energy = Math.round((up !== current ? up : down) * 100) / 100;
  return out;
}

export const MUTATIONS = {
  progression: mutateProgression,
  transpose: mutateTranspose,
  recipe: mutateRecipe,
  fill: mutateFill,
  energy: mutateEnergy,
};
export const MUTATION_NAMES = Object.keys(MUTATIONS);

export function applyMutation(name, spec, seed = 0) {
  const mutation = MUTATIONS[name];
  return mutation ? mutation(spec, seed) : cloneSpec(spec);
}

export function mutateSpec(spec, seed = 0) {
  const name = MUTATION_NAMES[hashText(`${seed}|mutation`) % MUTATION_NAMES.length];
  return { spec: applyMutation(name, spec, seed), mutation: name };
}
