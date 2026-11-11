// Промежуточное представление партии (IR) — общий язык библиотеки знаний
// и компилятора.
//
// Почему не строки: рецепты переходов и автоматизации должны быть
// проверяемыми функциями, а не шаблонами кода, в которых легко опечататься.
// Поэтому партия описывается данными, а компилятор превращает их в текст
// Strudel.
//
// Устройство дескриптора:
//   {
//     kind: 'n' | 'note' | 's',   // источник: степени, названия нот, сэмплы
//     value: '0 5 2 6',           // mini-нотация
//     scale: true,                // применить .scale(key)
//     chain: [ {method, arg} ]    // цепочка методов Strudel
//   }
// Аргумент метода — либо число, либо описание сигнала:
//   { kind: 'signal', signal: 'sine', slow: 4, range: [0.2, 0.8] }

/** Числовой аргумент метода. */
export function num(value) {
  return { kind: 'number', value };
}

/** Строковый аргумент метода (имя сэмпла, синтезатора). */
export function str(value) {
  return { kind: 'string', value };
}

/**
 * Сигнал-автоматизация: sine/perlin/saw с медленным темпом и диапазоном.
 * @param {'sine'|'perlin'|'saw'|'triangle'} signal
 * @param {number} slow во сколько тактов укладывается весь диапазон
 * @param {[number, number]} range [низкое, высокое] — всегда по возрастанию
 * @param {'up'|'down'} [direction] направление движения: up — низ→высок,
 *   down — высокий→низкий (затухание)
 */
export function signal(signal, slow, range, direction = 'up') {
  return { kind: 'signal', signal, slow, range, direction };
}

/** Паттерн-строка вида <0 5 2 6> — источник степеней. */
export function degrees(value) {
  return { kind: 'n', value, scale: true, chain: [] };
}

/** Паттерн названий нот. */
export function notes(value) {
  return { kind: 'note', value, scale: false, chain: [] };
}

/** Паттерн сэмплов. */
export function samples(value) {
  return { kind: 's', value, scale: false, chain: [] };
}

/**
 * Копия дескриптора с добавленным методом в конец цепочки.
 * @param {object} pattern
 * @param {string} method имя метода Strudel
 * @param {object} arg аргумент (num/str/signal)
 */
export function withMethod(pattern, method, arg) {
  return {
    ...pattern,
    chain: [...(pattern.chain || []), { method, arg }],
  };
}

/**
 * Копия дескриптора с несколькими добавленными методами.
 * @param {object} pattern
 * @param {Array<[string, object]>} methods
 */
export function withMethods(pattern, methods) {
  return {
    ...pattern,
    chain: [...(pattern.chain || []), ...methods.map(([method, arg]) => ({ method, arg }))],
  };
}

/** Глубокая копия дескриптора — рецепты не должны мутировать исходный. */
export function clonePattern(pattern) {
  return {
    ...pattern,
    chain: (pattern.chain || []).map((step) => ({
      method: step.method,
      arg: step.arg && step.arg.kind === 'signal' ? { ...step.arg, range: [...step.arg.range] } : { ...step.arg },
    })),
  };
}
