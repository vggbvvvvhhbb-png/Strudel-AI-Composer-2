// Канарейки: подлые треки, которые ОБЯЗАНЫ получить низкий скор.
//
// Зачем (бриф §4.4). Скор — инструмент, которым оптимизируют. Как только
// он становится целью, его начинают обманывать: трек без формы, идеально
// ровный луп, случайные ноты в ладе — всё это может набирать очки по
// отдельным метрикам. Канарейка — это тест на честность скора: если
// мусор набирает больше, чем нормальный трек, значит скор взломан, и
// эволюцию скилов останавливают до починки.
//
// Правило: канарейка должна получить скор НИЖЕ медианы нормального корпуса.
// Проверка живёт в tests/unit/oracle-canaries.test.js и в CI.

import { planIR } from '../ir/intent.js';
import { cloneIR } from '../ir/schema.js';

/**
 * Строит канарейки. Каждая — намеренно плохой трек:
 *   1. три одинаковые секции (синус с формой без содержания);
 *   2. идеально квантованный луп без вариаций;
 *   3. случайные ноты в ладу (гармония без структуры);
 *   4. тишина с одним кликом;
 *   5. максимально плотный шум.
 *
 * @returns {Array<{id:string, label:string, ir:object}>}
 */
export function canaryTracks() {
  return [
    {
      id: 'static-sections',
      label: 'три одинаковые секции',
      ir: staticSections(),
    },
    {
      id: 'quantized-loop',
      label: 'идеально ровный луп без вариаций',
      ir: quantizedLoop(),
    },
    {
      id: 'random-notes',
      label: 'случайные ноты в ладу',
      ir: randomNotes(),
    },
    {
      id: 'silence-click',
      label: 'тишина с одним кликом',
      ir: silenceClick(),
    },
    {
      id: 'dense-noise',
      label: 'максимально плотный шум',
      ir: denseNoise(),
    },
  ];
}

/** База: трек из обычного промта, чтобы канарейки считались тем же кодом. */
function base() {
  return planIR('мрачный трип-хоп про дождь', { seed: 7 });
}

/** 1. Секции-близнецы: форма есть, содержания нет. */
function staticSections() {
  const ir = base();
  const template = ir.sections[1];
  ir.sections = ir.sections.map((section, index) => ({
    ...section,
    // Энергия одинаковая, роли одинаковые, гармония одинаковая.
    energy: 0.5,
    tension: 0.5,
    harmony: JSON.parse(JSON.stringify(template.harmony)),
    layers: JSON.parse(JSON.stringify(template.layers)),
    id: `canary-${index}`,
  }));
  return ir;
}

/** 2. Ровный луп: одинаковая динамика, ноль микротайминга, ноль свинга. */
function quantizedLoop() {
  const ir = base();
  ir.groove.template = 'straight';
  ir.groove.amount = 0;
  ir.groove.swing = 0.5;
  ir.groove.offsetMs = 0;
  for (const section of ir.sections) {
    section.energy = 0.5;
    section.tension = 0.5;
    for (const role of Object.keys(section.layers)) {
      section.layers[role] = { ...section.layers[role], density: 1, weight: 0.8 };
    }
  }
  return ir;
}

/** 3. Случайные ноты в ладу: ритм ровный, мелодия — шум. */
function randomNotes() {
  const ir = base();
  // Мотив из «ступеней подряд» без ритмической формы.
  ir.motifs = {
    hook: {
      degrees: [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1],
      steps: Array.from({ length: 16 }, (_, index) => index),
    },
  };
  for (const section of ir.sections) {
    section.energy = 0.5;
    for (const role of Object.keys(section.layers)) {
      section.layers[role] = { ...section.layers[role], weight: 0.9 };
    }
  }
  return ir;
}

/** 4. Тишина с одним кликом. */
function silenceClick() {
  const ir = base();
  ir.sections = [
    {
      id: 'canary-silence',
      kind: 'intro',
      bars: 16,
      energy: 0.1,
      tension: 0.1,
      harmony: [{ rn: 'i', bars: 16 }],
      layers: {
        texture: {
          plan: 'texture',
          density: 0.02,
          register: [48, 84],
          weight: 0.02,
        },
      },
      enter: 'none',
    },
  ];
  return ir;
}

/** 5. Плотный шум. */
function denseNoise() {
  const ir = base();
  for (const section of ir.sections) {
    for (const role of Object.keys(section.layers)) {
      section.layers[role] = {
        ...section.layers[role],
        density: 1,
        weight: 1,
      };
    }
    section.energy = 0.9;
  }
  return ir;
}

/**
 * Проверяет канарейк против корпуса.
 *
 * @param {Array<{score:number}>} corpusScores скоры нормального корпуса
 * @param {Array<{id:string, label:string, score:number}>} canaryScores
 * @returns {{ok:boolean, median:number, failures:Array}}
 */
export function checkCanaries(corpusScores, canaryScores) {
  const sorted = [...corpusScores].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  const failures = canaryScores
    .filter((canary) => canary.score >= median)
    .map((canary) => ({
      id: canary.id,
      label: canary.label,
      score: canary.score,
      median,
      note: 'Канарейка набрала не меньше медианы корпуса — скор взломан.',
    }));
  return {
    ok: failures.length === 0,
    median,
    failures,
    corpusSize: sorted.length,
  };
}
