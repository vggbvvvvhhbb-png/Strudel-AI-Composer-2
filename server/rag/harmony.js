// Машинно-проверяемые правила гармонии для базы знаний (D-135).
// Ступени — индексы 0..6, как в n("...").scale("c:minor") Strudel
// (проверено tests/unit/spike-strudel.test.js: 0..6 в c:minor = C D Eb F G Ab Bb).
// Функции: T (тоника), S (субдоминанта), D (доминанта).

/** Интервалы ладов в полутонах от тоники — для проверки принадлежности нот ладу. */
export const MODE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
};

/**
 * Имя лада для scale() Strudel. ВНИМАНИЕ (замер 18.11.2026, @strudel/web
 * 1.3.0): harmonic minor через scale() НЕ работает — 'a:harmonicminor'
 * даёт пустую выдачу, 'a:harmonic minor' ломает mini-парсер (пробел).
 * Для harmonic-minor сниппеты пишутся через note() с явными высотами;
 * хелпер возвращает null, чтобы молча не выдать нерабочую строку.
 */
export function strudelScaleName(tonic, mode) {
  if (mode === 'harmonic-minor') return null;
  return `${tonic}:${mode}`;
}

// Функции ступеней по ладам. Классическая раскладка:
// I/i=T, ii=S, iii/III=T (слабая тоника), IV/iv=S, V=D, vi/VI=T, vii°/VII=D.
// В dorian characteristic IV мажорный (S), в mixolydian VII субтоника (D-функция
// слабая, но в роке bVII→I — backdoor-движение, см. substitutions).
const DEFAULT_FUNCTIONS = { T: [0, 2, 5], S: [1, 3], D: [4, 6] };

export const HARMONY_RULES = {
  version: 1,
  functions: {
    major: DEFAULT_FUNCTIONS,
    minor: DEFAULT_FUNCTIONS,
    dorian: DEFAULT_FUNCTIONS,
    phrygian: DEFAULT_FUNCTIONS,
    lydian: DEFAULT_FUNCTIONS,
    mixolydian: DEFAULT_FUNCTIONS,
    locrian: DEFAULT_FUNCTIONS,
    'harmonic-minor': DEFAULT_FUNCTIONS,
  },
  // Разрешённые переходы функций (граф). T→всё, S→D/T (в т.ч. плагальный),
  // D→T (в т.ч. прерванный D→vi — это тоже T-функция), D→D (повтор доминанты).
  transitions: {
    T: ['T', 'S', 'D'],
    S: ['T', 'S', 'D'],
    D: ['T', 'D'],
  },
  cadences: {
    authentic: ['D', 'T'],
    half: ['S', 'D'],
    plagal: ['S', 'T'],
    deceptive: ['D', 'T'],
  },
  substitutions: [
    {
      id: 'tritone-sub',
      name: 'Тритоновая замена',
      fromFunction: 'D',
      toFunction: 'D',
      rootShiftSemis: 6,
      description: 'V7 заменяется на bII7 (корень +6 полутонов): общие 3-я и 7-я ступени аккорда сохраняются, бас движется хроматически к тонике.',
      allowedModes: ['major', 'minor', 'dorian', 'mixolydian', 'harmonic-minor'],
    },
    {
      id: 'backdoor',
      name: 'Backdoor-движение',
      fromFunction: 'D',
      toFunction: 'T',
      rootShiftSemis: -2,
      description: 'bVII7→I: субтоника вместо доминанты, мягкое разрешение в тонику (рок, джаз).',
      allowedModes: ['major', 'mixolydian', 'dorian'],
    },
    {
      id: 'secondary-dominant',
      name: 'Вторичная доминанта',
      fromFunction: 'T',
      toFunction: 'D',
      rootShiftSemis: null,
      description: 'V/x перед аккордом x (например V/ii→ii): локальная доминанта усиливает движение к не-тонической ступени.',
      allowedModes: ['major', 'minor', 'dorian', 'mixolydian', 'harmonic-minor'],
    },
    {
      id: 'relative-mode',
      name: 'Параллельный лад',
      fromFunction: 'T',
      toFunction: 'T',
      rootShiftSemis: null,
      description: 'Заимствование аккордов параллельного лада (C major ↔ A minor): общая тональная база, смена краски без смены тоники.',
      allowedModes: ['major', 'minor'],
    },
  ],
};

/** Функция ступени в ладу или null, если ступень вне 0..6. */
export function functionOfDegree(degree, mode) {
  const fns = HARMONY_RULES.functions[mode];
  if (!fns || !Number.isInteger(degree) || degree < 0 || degree > 6) return null;
  for (const [fn, degrees] of Object.entries(fns)) {
    if (degrees.includes(degree)) return fn;
  }
  return null;
}

/** Разрешён ли переход между ступенями по графу функций. */
export function isAllowedTransition(fromDegree, toDegree, mode) {
  const from = functionOfDegree(fromDegree, mode);
  const to = functionOfDegree(toDegree, mode);
  if (!from || !to) return false;
  return HARMONY_RULES.transitions[from].includes(to);
}

/** Тип каденции по двум последним функциям фразы или null. */
export function cadenceType(prevDegree, lastDegree, mode) {
  const prev = functionOfDegree(prevDegree, mode);
  const last = functionOfDegree(lastDegree, mode);
  if (!prev || !last) return null;
  for (const [name, [a, b]] of Object.entries(HARMONY_RULES.cadences)) {
    if (a === prev && b === last) return name;
  }
  return null;
}

/**
 * Самопроверка правил: каждое покрытие ступеней полное и без пересечений,
 * графы ссылаются на существующие функции, каденции двучленны.
 * Гоняется тестом — правила не могут разъехаться молча.
 */
export function validateHarmonyRules(rules = HARMONY_RULES) {
  const errors = [];
  const fnNames = ['T', 'S', 'D'];
  for (const [mode, fns] of Object.entries(rules.functions)) {
    if (!MODE_INTERVALS[mode]) errors.push(`лад «${mode}» не описан в MODE_INTERVALS`);
    const seen = new Set();
    for (const fn of fnNames) {
      for (const d of fns[fn] || []) {
        if (!Number.isInteger(d) || d < 0 || d > 6) errors.push(`${mode}.${fn}: ступень ${d} вне 0..6`);
        if (seen.has(d)) errors.push(`${mode}: ступень ${d} в двух функциях`);
        seen.add(d);
      }
    }
    if (seen.size !== 7) errors.push(`${mode}: покрыто ${seen.size}/7 ступеней`);
  }
  for (const [fn, targets] of Object.entries(rules.transitions)) {
    if (!fnNames.includes(fn)) errors.push(`переход из неизвестной функции ${fn}`);
    for (const t of targets) {
      if (!fnNames.includes(t)) errors.push(`переход в неизвестную функцию ${t}`);
    }
  }
  for (const [name, seq] of Object.entries(rules.cadences)) {
    if (seq.length !== 2 || seq.some((f) => !fnNames.includes(f))) {
      errors.push(`каденция ${name}: ожидалась пара функций T/S/D`);
    }
  }
  for (const sub of rules.substitutions) {
    if (!fnNames.includes(sub.fromFunction) || !fnNames.includes(sub.toFunction)) {
      errors.push(`замена ${sub.id}: неизвестная функция`);
    }
    for (const mode of sub.allowedModes) {
      if (!rules.functions[mode]) errors.push(`замена ${sub.id}: неизвестный лад ${mode}`);
    }
  }
  return { ok: errors.length === 0, errors };
}