// Детерминированные мутации спеки — «🎲 ещё вариант» без LLM.
//
// Каждая мутация: чистая функция (спека, зерно) → спека. Зерно выбирает
// ЧТО именно меняется (какая секция, какая партия, насколько), но не
// использует случайность: выбор делается хэшем, поэтому один и тот же seed
// всегда даёт один и тот же вариант (D-018).
//
// Инвариант: мутация обязана (а) оставить спеку валидной по checkSpec и
// (б) реально её изменить. Молча вернуть исходную спеку — это провал:
// пользователь нажал «ещё вариант» и получил то же самое.

import { progressionsForStyle } from './knowledge/index.js';
import { progressionForSection } from './spec/check.js';
import { cloneSpec, hashText } from './diversity.js';

/** Рецепты в цикле: следующий по кругу всегда отличается от текущего. */
const RECIPE_CYCLE = ['default', 'busy', 'sparse'];

/**
 * Смена прогрессии: другая гармония того же стиля.
 *
 * Самая широкая по охвату мутация: меняет аккорды во всех секциях сразу.
 */
export function mutateProgression(spec, seed = 0) {
  const all = progressionsForStyle(spec.meta.style);
  if (!all.length) return cloneSpec(spec);
  const current = spec.harmony?.progressionId;
  const others = all.filter((item) => item.id !== current);
  const pool = others.length ? others : all;
  const progression = pool[hashText(`${seed}|progression`) % pool.length];

  const out = cloneSpec(spec);
  out.harmony = {
    progressionId: progression.id,
    mode: progression.mode,
    barsPerChord: progression.barsPerChord,
  };
  return out;
}

/**
 * Транспозиция секции: степени лада в секции сдвигаются по кругу.
 *
 * Степени остаются в диапазоне 0..6 — иначе checkSpec отвергнет спеку,
 * а музыка вышла бы из лада. Переопределение прогрессии создаётся, если
 * его не было, и progressionId из него убирается: иначе переопределение
 * степеней не применилось бы (progressionForSection сначала смотрит id).
 */
export function mutateTranspose(spec, seed = 0) {
  const out = cloneSpec(spec);
  if (!out.form.length) return out;
  const index = hashText(`${seed}|transpose|section`) % out.form.length;
  const section = out.form[index];
  const effective = progressionForSection(out, index);
  const delta = 1 + (hashText(`${seed}|transpose|delta`) % 6);
  const degrees = effective.degrees.map((degree) => (degree + delta) % 7);

  const override = { ...(section.progressionOverride || {}) };
  delete override.progressionId;
  override.degrees = degrees;
  section.progressionOverride = override;
  return out;
}

/**
 * Смена рецепта одной партии в одной секции: default → busy → sparse.
 *
 * Самая локальная мутация: слышно, но трек в целом остаётся тем же.
 */
export function mutateRecipe(spec, seed = 0) {
  const out = cloneSpec(spec);
  if (!out.form.length) return out;
  const index = hashText(`${seed}|recipe|section`) % out.form.length;
  const section = out.form[index];
  const roles = Object.keys(section.roles || {}).sort();
  if (!roles.length) return out;
  const role = roles[hashText(`${seed}|recipe|role`) % roles.length];
  const current = section.roles[role].recipe || 'default';
  const at = RECIPE_CYCLE.indexOf(current);
  section.roles[role] = {
    ...section.roles[role],
    recipe: RECIPE_CYCLE[(at + 1) % RECIPE_CYCLE.length],
  };
  return out;
}

/**
 * Добавление филла: короткая секция kind=fill в конце формы.
 *
 * Если трек уже упирается в 96 тактов, вместо секции ставится переход
 * типа fill в последнюю секцию — вариант остаётся рабочим.
 */
export function mutateFill(spec, seed = 0) {
  const out = cloneSpec(spec);
  if (!out.form.length) return out;
  const total = out.form.reduce((sum, section) => sum + section.bars, 0);

  if (total + 4 <= 96 && out.form.length < 12) {
    const last = out.form[out.form.length - 1];
    const roles = {};
    for (const role of Object.keys(last.roles || {}).sort().slice(0, 3)) {
      roles[role] = { ...last.roles[role], recipe: 'busy' };
    }
    const energy = Math.min(1, Math.round((Number(last.energy ?? 0.5) + 0.1) * 100) / 100);
    out.form.push({ kind: 'fill', bars: 4, energy, roles });
    // Прежняя последняя секция теперь ведёт в филл: переход есть в коде.
    out.form[out.form.length - 2].transition = { into: 'fill', type: 'fill' };
    return out;
  }

  const last = out.form[out.form.length - 1];
  const type = last.transition?.type === 'fill' ? 'riser' : 'fill';
  last.transition = { into: last.kind, type };
  return out;
}

/**
 * Сдвиг энергии одной секции: арка плотности меняется в деталях.
 *
 * Энергия влияет на рецепт по умолчанию (D-017), то есть на реальную
 * плотность рисунка, а не только на подпись в интерфейсе.
 */
export function mutateEnergy(spec, seed = 0) {
  const out = cloneSpec(spec);
  if (!out.form.length) return out;
  const index = hashText(`${seed}|energy|section`) % out.form.length;
  const section = out.form[index];
  const current = Number(section.energy ?? 0.5);
  const delta = 0.05 + (hashText(`${seed}|energy|delta`) % 3) * 0.05;
  const up = Math.min(1, current + delta);
  const down = Math.max(0, current - delta);
  const value = up !== current ? up : down;
  section.energy = Math.round(value * 100) / 100;
  return out;
}

/** Все мутации: имя → функция. */
export const MUTATIONS = {
  progression: mutateProgression,
  transpose: mutateTranspose,
  recipe: mutateRecipe,
  fill: mutateFill,
  energy: mutateEnergy,
};

/** Имена мутаций в фиксированном порядке — порядок важен для детерминизма. */
export const MUTATION_NAMES = Object.keys(MUTATIONS);

/**
 * Применить мутацию по имени.
 *
 * @param {string} name имя из MUTATION_NAMES
 * @param {object} spec
 * @param {number} [seed]
 * @returns {object} новая спека
 */
export function applyMutation(name, spec, seed = 0) {
  const mutation = MUTATIONS[name];
  if (!mutation) return cloneSpec(spec);
  return mutation(spec, seed);
}

/**
 * Мутация, выбранная зерном: «ещё вариант» в один клик.
 *
 * @param {object} spec
 * @param {number} [seed]
 * @returns {{spec: object, mutation: string}}
 */
export function mutateSpec(spec, seed = 0) {
  const name = MUTATION_NAMES[hashText(`${seed}|mutation`) % MUTATION_NAMES.length];
  return { spec: applyMutation(name, spec, seed), mutation: name };
}
