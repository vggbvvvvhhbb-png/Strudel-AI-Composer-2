// Трансформации IR → IR: «сделай мрачнее» как измеримая правка.
//
// ГЛАВНОЕ: правка — это НЕ перегенерация. Каждая трансформация — чистая
// функция IR→IR, которая меняет конкретные поля и объявляет ожидаемый знак
// изменения метрик. Тогда «мрачнее» можно проверить по дельте ProjectModel,
// а не на слух (бриф §5.4).
//
// Инварианты, которые проверяются тестами:
//   • чистота: исходный IR не мутируется;
//   • локальность: правка роли X не меняет события других ролей;
//   • монотонность: чем больше величина, тем сильнее эффект в ожидаемую сторону.

import { cloneIR } from './schema.js';
import { isKnownSound } from './palette.js';
import { random01 } from './prng.js';
import { GROOVE_TEMPLATES } from './groove.js';

/** Шкала яркости лада: темнее ← → светлее. */
export const BRIGHTNESS_SCALE = [
  'lydian', 'major', 'mixolydian', 'dorian', 'minor', 'phrygian', 'locrian',
];

/** Логическое настроение (valence/arousal) сдвигается вместе с ладом. */
const MODE_VALENCE = {
  lydian: 0.85, major: 0.6, mixolydian: 0.3, dorian: 0.0,
  minor: -0.4, phrygian: -0.7, locrian: -0.95,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Каждый слой роли получает яркость фильтра — её и понижает «мрачнее». */
function layerLpf(layer, role, plan) {
  if (typeof layer.lpf === 'number') return layer.lpf;
  if (plan === 'pad') return 1400;
  if (plan === 'melody' || plan === 'arp') return 3000;
  if (plan === 'drums') return 16000;
  return 2400;
}

/** Проходит по всем слоям трека. */
function forEachLayer(ir, fn) {
  for (const section of ir.sections) {
    for (const role of Object.keys(section.layers)) {
      section.layers[role] = fn(section.layers[role], role, section);
    }
  }
}

/**
 * Темнее: лад темнее, регистр ниже, плотность ниже, фильтр ниже.
 * Ожидаемый знак: яркость ↓, высота ↓, плотность ↓.
 */
export function darker(input, amount = 0.5) {
  const ir = cloneIR(input);
  const step = clamp(amount, 0, 1);

  // Лад: сдвиг на одну ступень темнее (интерполируем по шкале яркости).
  const current = BRIGHTNESS_SCALE.indexOf(ir.meta.key.mode);
  const index = clamp(current < 0 ? 4 : current + (step >= 0.5 ? 1 : 0), 0, BRIGHTNESS_SCALE.length - 1);
  ir.meta.key.mode = BRIGHTNESS_SCALE[index];

  // Настроение следует за ладом — иначе план противоречит сам себе.
  ir.meta.mood.valence = clamp(
    ir.meta.mood.valence - 0.25 * step, -1, 1,
  );

  forEachLayer(ir, (layer, role, section) => {
    const lpf = layerLpf(layer, role, layer.plan);
    return {
      ...layer,
      lpf: Math.max(120, Math.round(lpf * (1 - 0.35 * step))),
      // Регистр ниже на октаву для мелодических ролей.
      register: layer.plan === 'melody' || layer.plan === 'arp'
        ? [Math.max(24, layer.register[0] - 12 * Math.round(step)), Math.max(36, layer.register[1] - 12 * Math.round(step))]
        : layer.register,
      density: clamp(layer.density * (1 - 0.2 * step), 0.2, 1),
      gainDb: layer.gainDb === undefined ? undefined : layer.gainDb - 1.5 * step,
    };
  });

  // Энергия секций падает — «мрачнее» значит тише и реже.
  for (const section of ir.sections) {
    section.energy = clamp(section.energy - 0.12 * step, 0, 1);
    section.tension = clamp(section.tension + 0.08 * step, 0, 1);
  }
  return ir;
}

/**
 * Светлее: обратная темнее — лад светлее, регистр выше, фильтр открытее.
 */
export function brighter(input, amount = 0.5) {
  const ir = cloneIR(input);
  const step = clamp(amount, 0, 1);
  const current = BRIGHTNESS_SCALE.indexOf(ir.meta.key.mode);
  const index = clamp(current < 0 ? 1 : current - (step >= 0.5 ? 1 : 0), 0, BRIGHTNESS_SCALE.length - 1);
  ir.meta.key.mode = BRIGHTNESS_SCALE[index];
  ir.meta.mood.valence = clamp(ir.meta.mood.valence + 0.25 * step, -1, 1);

  forEachLayer(ir, (layer, role) => {
    const lpf = layerLpf(layer, role, layer.plan);
    return {
      ...layer,
      lpf: Math.min(20000, Math.round(lpf * (1 + 0.35 * step))),
      register: layer.plan === 'melody' || layer.plan === 'arp'
        ? [layer.register[0] + 12 * Math.round(step), layer.register[1] + 12 * Math.round(step)]
        : layer.register,
      density: clamp(layer.density * (1 + 0.2 * step), 0.2, 1),
      gainDb: layer.gainDb === undefined ? undefined : layer.gainDb + 1.5 * step,
    };
  });
  for (const section of ir.sections) {
    section.energy = clamp(section.energy + 0.12 * step, 0, 1);
  }
  return ir;
}

/**
 * Энергичнее: быстрее, плотнее, громче в пике.
 * Ожидаемый знак: темп ↑, плотность ↑, энергия ↑.
 */
export function energize(input, amount = 0.5) {
  const ir = cloneIR(input);
  const step = clamp(amount, 0, 1);
  ir.meta.bpm = Math.min(200, Math.round(ir.meta.bpm * (1 + 0.08 * step)));
  ir.meta.mood.arousal = clamp(ir.meta.mood.arousal + 0.2 * step, -1, 1);
  forEachLayer(ir, (layer) => ({ ...layer, density: clamp(layer.density * (1 + 0.25 * step), 0.2, 1) }));
  for (const section of ir.sections) {
    section.energy = clamp(section.energy + 0.1 * step, 0, 1);
  }
  return ir;
}

/**
 * Спокойнее: медленнее, реже, мягче.
 */
export function calm(input, amount = 0.5) {
  const ir = cloneIR(input);
  const step = clamp(amount, 0, 1);
  ir.meta.bpm = Math.max(40, Math.round(ir.meta.bpm * (1 - 0.08 * step)));
  ir.meta.mood.arousal = clamp(ir.meta.mood.arousal - 0.2 * step, -1, 1);
  forEachLayer(ir, (layer) => ({ ...layer, density: clamp(layer.density * (1 - 0.25 * step), 0.2, 1) }));
  for (const section of ir.sections) {
    section.energy = clamp(section.energy - 0.1 * step, 0, 1);
  }
  return ir;
}

/**
 * Утоняет роль: меньше шагов, тише.
 * Локальность: другие роли не меняются.
 */
export function thin(input, role, amount = 0.5) {
  const ir = cloneIR(input);
  const step = clamp(amount, 0, 1);
  for (const section of ir.sections) {
    const layer = section.layers[role];
    if (!layer) continue;
    section.layers[role] = {
      ...layer,
      density: clamp(layer.density * (1 - 0.4 * step), 0.1, 1),
      gainDb: layer.gainDb === undefined ? undefined : layer.gainDb - 3 * step,
    };
  }
  return ir;
}

/** Уплотняет роль. */
export function thicken(input, role, amount = 0.5) {
  const ir = cloneIR(input);
  const step = clamp(amount, 0, 1);
  for (const section of ir.sections) {
    const layer = section.layers[role];
    if (!layer) continue;
    section.layers[role] = {
      ...layer,
      density: clamp(layer.density * (1 + 0.3 * step), 0.2, 1),
      gainDb: layer.gainDb === undefined ? undefined : layer.gainDb + 2 * step,
    };
  }
  return ir;
}

/**
 * Сдвигает регистр роли на ступени (1 = октава).
 */
export function shiftRegister(input, role, steps = 1) {
  const ir = cloneIR(input);
  const shift = Math.round(steps) * 12;
  for (const section of ir.sections) {
    const layer = section.layers[role];
    if (!layer) continue;
    section.layers[role] = {
      ...layer,
      register: [layer.register[0] + shift, layer.register[1] + shift],
    };
  }
  return ir;
}

/** Меняет лад тональности. */
export function setMode(input, mode) {
  const ir = cloneIR(input);
  if (!BRIGHTNESS_SCALE.includes(mode)) throw new Error(`Неизвестный лад: ${mode}`);
  ir.meta.key.mode = mode;
  ir.meta.mood.valence = clamp(
    MODE_VALENCE[mode] ?? ir.meta.mood.valence, -1, 1,
  );
  return ir;
}

/** Масштабирует темп. */
export function scaleTempo(input, factor = 1) {
  const ir = cloneIR(input);
  ir.meta.bpm = clamp(Math.round(ir.meta.bpm * factor), 40, 200);
  return ir;
}

/**
 * Меняет инструмент роли. Имя проверяется: неизвестный звук — ошибка,
 * а не тихая подмена.
 */
export function swapInstrument(input, role, ref) {
  const ir = cloneIR(input);
  if (!isKnownSound(ref)) throw new Error(`Неизвестный звук: ${ref}`);
  const palette = { ...(ir.palette || {}) };
  palette[role] = { ref };
  ir.palette = palette;
  return ir;
}

/**
 * Добавляет вариацию в секцию: мотив в ней меняется, но остаётся в ладу.
 * Детерминированно: адрес = seed + id секции.
 */
export function addVariation(input, sectionId) {
  const ir = cloneIR(input);
  const section = ir.sections.find((item) => item.id === sectionId);
  if (!section) throw new Error(`Секция не найдена: ${sectionId}`);
  const motifs = { ...ir.motifs };
  for (const [motifId, motif] of Object.entries(motifs)) {
    const degrees = motif.degrees.map((degree, index) => {
      if (degree === null) return null;
      const roll = random01(ir.seed, 'variation', sectionId, motifId, index);
      if (roll > 0.35) return degree;
      // Сдвиг на ступень вверх или вниз по ладу.
      return clamp(degree + (roll > 0.17 ? 1 : -1), 0, 6);
    });
    motifs[motifId] = { ...motif, degrees };
  }
  ir.motifs = motifs;
  return ir;
}

/** Удлиняет секцию на число тактов. */
export function extendSection(input, sectionId, bars = 4) {
  const ir = cloneIR(input);
  const section = ir.sections.find((item) => item.id === sectionId);
  if (!section) throw new Error(`Секция не найдена: ${sectionId}`);
  section.bars = clamp(section.bars + Math.round(bars), 1, 32);
  return ir;
}

/**
 * Больше или меньше свинга.
 * Ожидаемый знак: доля свинга ↑.
 */
export function swing(input, amount = 0.5) {
  const ir = cloneIR(input);
  const step = clamp(amount, 0, 1);
  const current = ir.groove.swing ?? 0.5;
  ir.groove.swing = clamp(current + 0.06 * step, 0.5, 0.68);
  return ir;
}

/**
 * Поднимает или опускает энергию секции.
 *
 * Линтер находит секцию, которая выпадает из арки («пик не громче брейка»),
 * и предлагает именно эту операцию: точечную, измеримую правку, а не
 * перегенерацию трека.
 *
 * @param {string} sectionId
 * @param {number} delta −1…1 (обычно ±0.1…0.2)
 */
export function boostSection(input, sectionId, delta = 0.15) {
  const ir = cloneIR(input);
  const section = ir.sections.find((item) => item.id === sectionId);
  if (!section) throw new Error(`Секция не найдена: ${sectionId}`);
  const step = clamp(delta, -1, 1);
  section.energy = clamp(section.energy + step, 0, 1);
  for (const role of Object.keys(section.layers)) {
    const layer = section.layers[role];
    // Ударные и бас задают энергию секции сильнее прочих.
    const weight = ['kick', 'snare', 'bass', 'sub'].includes(role) ? step : step * 0.5;
    section.layers[role] = {
      ...layer,
      weight: clamp((layer.weight ?? 1) + weight, 0, 1),
    };
  }
  return ir;
}

/**
 * Заменяет ступень гармонии в секции.
 *
 * @param {string} sectionId
 * @param {number} index индекс ступени в секции
 * @param {string} rn римская цифра
 * @param {string} [color] цвет аккорда
 */
export function setHarmony(input, sectionId, index, rn, color) {
  const ir = cloneIR(input);
  const section = ir.sections.find((item) => item.id === sectionId);
  if (!section) throw new Error(`Секция не найдена: ${sectionId}`);
  if (!Number.isInteger(index) || index < 0 || index >= section.harmony.length) {
    throw new Error(`Нет ступени ${index} в секции ${sectionId}`);
  }
  const step = { ...section.harmony[index] };
  if (rn) step.rn = rn;
  if (color !== undefined) step.color = color;
  section.harmony[index] = step;
  return ir;
}

/**
 * Задаёт ритм баса (слоты на 1/8 такта).
 *
 * Линтер находит рассинхрон баса с киком и предлагает ритм, который
 * садится на кик. Ритм — строка из 'x' и '~'.
 */
export function setBassRhythm(input, rhythm) {
  const ir = cloneIR(input);
  const tokens = String(rhythm || '').trim().split(/\s+/);
  if (!tokens.length || tokens.some((token) => token !== 'x' && token !== '~')) {
    throw new Error(`Некорректный ритм баса: ${rhythm}`);
  }
  ir.groove.bassRhythm = tokens.join(' ');
  return ir;
}

/**
 * Меняет шаблон грува и силу его применения.
 *
 * @param {string} template имя шаблона из IR_GROOVE_TEMPLATES
 * @param {{amount?:number, swing?:number}} [options]
 */
export function setGroove(input, template, options = {}) {
  const ir = cloneIR(input);
  if (!GROOVE_TEMPLATES[template]) throw new Error(`Неизвестный шаблон грува: ${template}`);
  ir.groove.template = template;
  if (options.amount !== undefined) {
    ir.groove.amount = clamp(options.amount, 0, 1);
  }
  if (options.swing !== undefined) {
    ir.groove.swing = clamp(options.swing, 0.5, 0.68);
  }
  return ir;
}

/** Реестр трансформаций: имя → функция. */
export const TRANSFORMS = {
  darker,
  brighter,
  energize,
  calm,
  thin,
  thicken,
  shiftRegister,
  setMode,
  scaleTempo,
  swapInstrument,
  addVariation,
  extendSection,
  swing,
  boostSection,
  setHarmony,
  setBassRhythm,
  setGroove,
};

/**
 * Применяет трансформацию по имени.
 * @param {object} ir
 * @param {string} name
 * @param {...any} args остальные аргументы трансформации
 */
export function applyTransform(ir, name, ...args) {
  const fn = TRANSFORMS[name];
  if (!fn) throw new Error(`Неизвестная трансформация: ${name}`);
  return fn(ir, ...args);
}
