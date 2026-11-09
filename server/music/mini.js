// Разбор mini-нотации Strudel (TidalCycles) в события с временными позициями.
//
// Работаем с кодом, а не со звуком: сгенерированный код и есть нотная запись,
// поэтому из него однозначно восстанавливаются pitch и rhythm. Это детерминированно,
// тестируемо в node и не требует браузера или FFT.
//
// Поддерживаемая грамматика:
//   bd sd            — последовательность, каждый элемент занимает 1/N цикла
//   ~                — пауза
//   bd*4  hh*8       — повтор (fast): элемент звучит n раз в своей доле
//   bd!3             — replicate: n повторов в доле элемента
//   bd@3             — вес: элемент занимает втрое больше места соседей
//   bd . sd sd       — разделение точкой: группы делят цикл поровну
//   [bd sd]          — подпоследовательность (внутри — одна доля)
//   <a b c>          — чередование: элемент меняется от такта к такту
//   bd/2             — замедление: событие длится n тактов
//   cp(3,8)          — евклидов ритм: 3 пульса на 8 шагов
//   bd*4, hh*8       — стек: параллельные паттерны
//
// Время измеряется в тактах (0..1 — один такт). Возвращаемые события:
//   { begin, end, value } — value: исходный токен ('c3', 'bd', '3' …).

const WORD_CHAR = /[A-Za-z0-9#'_-]/;

/**
 * Евклидов ритм (алгоритм «bools»): k пульсов на n шагов.
 * Возвращает массив длиной steps с true на «ударах».
 */
export function euclidPattern(pulses, steps, rotate = 0) {
  const s = Math.max(1, Math.round(steps || 8));
  const p = Math.max(0, Math.min(s, Math.round(pulses ?? 3)));
  const out = new Array(s).fill(false);
  if (p === 0) return out;
  if (p === s) return out.map(() => true);
  let bucket = 0;
  for (let i = 0; i < s; i++) {
    bucket += p;
    if (bucket >= s) {
      bucket -= s;
      out[i] = true;
    }
  }
  const r = ((Math.round(rotate || 0) % s) + s) % s;
  if (!r) return out;
  return out.slice(r).concat(out.slice(0, r));
}

class MiniParser {
  constructor(src) {
    this.src = String(src ?? '');
    this.i = 0;
    this.errors = [];
    this.counts = { atoms: 0, rests: 0 };
  }

  ws() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i += 1;
  }

  // Стек: последовательности, разделённые запятой. Одна — просто последовательность.
  parseStack() {
    const seqs = [this.parseSequence()];
    for (;;) {
      this.ws();
      if (this.src[this.i] !== ',') break;
      this.i += 1;
      seqs.push(this.parseSequence());
    }
    return seqs.length === 1 ? seqs[0] : { type: 'stack', seqs };
  }

  // Последовательность: термы, разделённые пробелами. Точка делит на группы.
  parseSequence() {
    const groups = [[]];
    for (;;) {
      this.ws();
      const c = this.src[this.i];
      if (c === undefined || c === ',' || c === ']' || c === '>') break;
      if (c === '.') {
        this.i += 1;
        groups.push([]);
        continue;
      }
      const term = this.parseTerm();
      if (!term) break;
      groups[groups.length - 1].push(term);
    }
    return { type: 'seq', groups };
  }

  // Терм: атом + модификаторы (* ! @ /).
  parseTerm() {
    const atom = this.parseAtom();
    if (!atom) return null;
    let node = atom;
    let weight = 1;
    for (;;) {
      const c = this.src[this.i];
      if (c === '*') {
        this.i += 1;
        const f = this.readNumber();
        if (f === null) {
          this.errors.push('после «*» ожидалось число');
          break;
        }
        node = { type: 'fast', node, factor: f };
        continue;
      }
      if (c === '!') {
        this.i += 1;
        const n = this.readNumber() ?? 1;
        node = { type: 'fast', node, factor: n };
        continue;
      }
      if (c === '@') {
        this.i += 1;
        const w = this.readNumber();
        weight = w === null ? 1 : w;
        continue;
      }
      if (c === '/') {
        this.i += 1;
        const f = this.readNumber();
        if (f === null) {
          this.errors.push('после «/» ожидалось число');
          break;
        }
        node = { type: 'slow', node, factor: f };
        continue;
      }
      break;
    }
    return { node, weight };
  }

  parseAtom() {
    this.ws();
    const c = this.src[this.i];
    if (c === undefined) return null;
    if (c === '~') {
      this.i += 1;
      this.counts.rests += 1;
      return { type: 'rest' };
    }
    if (c === '[') {
      this.i += 1;
      const inner = this.parseStack();
      this.ws();
      if (this.src[this.i] === ']') this.i += 1;
      else this.errors.push('не закрыта «[»');
      return { type: 'group', node: inner };
    }
    if (c === '<') {
      this.i += 1;
      const seq = this.parseSequence();
      this.ws();
      if (this.src[this.i] === '>') this.i += 1;
      else this.errors.push('не закрыта «<»');
      const alts = seq.groups.flat();
      return { type: 'choice', alts };
    }
    if (c === '(') {
      // Голые скобки без слова-носителя — пропускаем содержимое.
      this.skipBalanced('(', ')');
      return { type: 'rest' };
    }
    const word = this.readWord();
    if (!word) return null;
    this.counts.atoms += 1;
    if (this.src[this.i] === '(') {
      const args = this.readArgs();
      return {
        type: 'euclid',
        value: word,
        pulses: args[0] ?? 3,
        steps: args[1] ?? 8,
        rotate: args[2] ?? 0,
      };
    }
    return { type: 'atom', value: word };
  }

  readWord() {
    let out = '';
    while (this.i < this.src.length && WORD_CHAR.test(this.src[this.i])) {
      out += this.src[this.i];
      this.i += 1;
    }
    return out;
  }

  readNumber() {
    let out = '';
    while (this.i < this.src.length && /[0-9.]/.test(this.src[this.i])) {
      out += this.src[this.i];
      this.i += 1;
    }
    if (!out) return null;
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  }

  // Аргументы в скобках: (3,8) или (3,8,2) — числа через запятую.
  readArgs() {
    const start = this.i;
    this.skipBalanced('(', ')');
    const inner = this.src.slice(start + 1, this.i - 1);
    return inner
      .split(',')
      .map((s) => Number(s.trim()))
      .map((n) => (Number.isFinite(n) ? n : null));
  }

  skipBalanced(open, close) {
    if (this.src[this.i] !== open) return;
    let depth = 0;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        this.i += 1;
        if (depth === 0) return;
        continue;
      }
      this.i += 1;
    }
  }
}

// Раскладка последовательности: группы делят время поровну, термы — по весу.
function renderSeq(node, begin, end, cell, out) {
  const groups = node.groups.filter((g) => g.length);
  if (!groups.length) return;
  const gSpan = (end - begin) / groups.length;
  groups.forEach((group, gi) => {
    const gb = begin + gi * gSpan;
    const ge = gb + gSpan;
    const total = group.reduce((sum, t) => sum + (t.weight > 0 ? t.weight : 0), 0);
    if (!total) return;
    let cursor = gb;
    for (const term of group) {
      const w = (term.weight > 0 ? term.weight : 0) / total;
      const tb = cursor;
      const te = cursor + gSpan * w;
      cursor = te;
      if (te <= tb) continue;
      render(term.node, tb, te, cell, out);
    }
  });
}

// Рендер узла в отрезок [begin, end). cell описывает такт, в котором живёт узел:
// { b, e, index } — границы такта и его порядковый номер (нужен для чередований).
function render(node, begin, end, cell, out) {
  if (!node || end <= begin) return;
  switch (node.type) {
    case 'stack':
      for (const seq of node.seqs) render(seq, begin, end, cell, out);
      return;
    case 'seq':
      renderSeq(node, begin, end, cell, out);
      return;
    case 'group':
      render(node.node, begin, end, cell, out);
      return;
    case 'fast': {
      const d = end - begin;
      const n = Math.max(1, Math.round(node.factor));
      for (let k = 0; k < n; k++) {
        const b = begin + (k * d) / n;
        const e = begin + ((k + 1) * d) / n;
        if (e <= b) continue;
        render(node.node, b, e, { b, e, index: cell.index * n + k }, out);
      }
      return;
    }
    case 'slow': {
      const d = end - begin;
      const n = Math.max(1, Math.round(node.factor));
      const span = d * n;
      // Замедленный паттерн «живёт» сразу на несколько тактов: повторно его
      // не рендерим, иначе атаки задвоятся на границе периода.
      if (node.renderedUntil !== undefined && begin < node.renderedUntil) return;
      node.renderedUntil = begin + span;
      render(node.node, begin, begin + span, { b: begin, e: begin + span, index: 0 }, out);
      return;
    }
    case 'choice': {
      const alts = node.alts || [];
      if (!alts.length) return;
      const idx = ((cell.index % alts.length) + alts.length) % alts.length;
      render(alts[idx].node, begin, end, cell, out);
      return;
    }
    case 'euclid': {
      const pat = euclidPattern(node.pulses, node.steps, node.rotate);
      const d = end - begin;
      const steps = pat.length;
      pat.forEach((on, k) => {
        if (!on) return;
        out.push({
          begin: begin + (k * d) / steps,
          end: begin + ((k + 1) * d) / steps,
          value: node.value,
        });
      });
      return;
    }
    case 'atom':
      out.push({ begin, end, value: node.value });
      return;
    case 'rest':
      return;
    default:
      return;
  }
}

/**
 * Разбирает mini-нотацию в список событий.
 *
 * @param {string} source содержимое строкового литерала, например 'bd*4, hh*8'
 * @param {{cycles?: number}} [options] сколько тактов анализировать (для чередований)
 * @returns {{events: Array<{begin:number,end:number,value:string}>, errors: string[], counts: {atoms:number, rests:number}}}
 */
export function parseMini(source, { cycles = 1 } = {}) {
  const parser = new MiniParser(source);
  const tree = parser.parseStack();
  const events = [];
  const total = Math.max(1, Math.round(cycles));
  // Такты рендерим по одному: так чередования <a b c> дают разный набор нот
  // в соседних тактах, а slow-паттерны не дублируются.
  for (let c = 0; c < total; c++) {
    render(tree, c, c + 1, { b: c, e: c + 1, index: c }, events);
  }
  events.sort((a, b) => a.begin - b.begin || a.end - b.end);
  return { events, errors: parser.errors, counts: parser.counts };
}
