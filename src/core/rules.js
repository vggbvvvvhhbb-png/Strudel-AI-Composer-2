// Правила линтера Strudel-кода (фаза P2, D-157).
//
// ЗАЧЕМ. «Молчаливые пустоты» — дефекты, которые не выглядят как ошибки:
// движок принимает код, партия не падает, а звука нет. Их ловить надо ДО запуска.
//
// Каждое правило опирается на ИЗМЕРЕНИЕ (docs/STRUDEL-FACTS.md, скрипт
// scripts/probe-strudel-facts.mjs), а не на догадку и не на документацию Strudel.
// Если факт изменился — перепрогоняется стенд, а правило обновляется вместе с ним.
// Тест tests/unit/strudel-rules.test.js перепроверяет белые списки на живом движке,
// поэтому список не может разойтись с реальностью молча.
//
// ФОРМАТ НАХОДКИ: { id, level, line, message, fix? }
//   level: 'error' — код неверен, его надо чинить (в том числе автофиксом).
//   level: 'warn'  — код исполняется, но ведёт себя не так, как читается.
//
// Модуль чистый: без импортов, без браузера, без Node. Работает и в сервере,
// и в клиентском бандле.

/**
 * Лады, измеренные как рабочие в @strudel/web 1.3.0 (docs/STRUDEL-FACTS.md, §2).
 * Список получен прогоном scripts/probe-strudel-facts.mjs по всем восьми
 * ступеням лада. НЕ рабочие (движок молча отдаёт пустую шкалу):
 * harmonic:minor:pentatonic, dorian:pentatonic, phrygian:pentatonic.
 */
export const MEASURED_MODES = new Set([
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
  'ionian', 'pentatonic', 'blues', 'chromatic', 'harmonic:minor',
  'major:pentatonic', 'minor:pentatonic', 'mixolydian:pentatonic', 'lydian:pentatonic',
  'locrian:pentatonic', 'major:blues', 'minor:blues', 'phrygian:dominant',
  'melodic:minor', 'altered', 'lydian:dominant',
]);

/**
 * Измеренные исправления написаний лада: как писать правильно.
 * Ключ — что написано, значение — как работает (обе строки измерены).
 */
export const MEASURED_MODE_FIXES = new Map([
  ['harmonic minor', 'harmonic:minor'],
  ['harmonic_minor', 'harmonic:minor'],
  ['harmonicminor', 'harmonic:minor'],
  ['harmonic', 'harmonic:minor'],
]);

/**
 * Измеренные исправления написаний аккордов: как писать, чтобы прозвучало.
 * Основание: chord("Fmaj7").voicing() → 0 событий, chord("FM7").voicing() → 5;
 * chord("A:min").voicing() → 0, chord("Am").voicing() → 5.
 */
export const MEASURED_CHORD_FIXES = new Map([
  ['maj7', 'M7'],
  ['min7', 'm7'],
]);

/**
 * Имена Strudel, измеренные как существующие (docs/STRUDEL-FACTS.md, §1).
 * Нужны правилу R3: имя, отличающееся только регистром, — это не «почти работает»,
 * а тихая поломка: duckOrBit не существует, есть duckorbit.
 */
export const MEASURED_NAMES = new Set([
  'duckorbit', 'duck', 'duckattack', 'duckdepth', 'duckonset', 'duckons',
  'lfo', 'seg', 'lpenv', 'tremolo', 'tremolosync', 'tremolodepth',
  'postgain', 'compressor', 'unison', 'detune', 'spread', 'voicing', 'dict',
  'rootNotes', 'chord', 'note', 'n', 's', 'stack', 'orbit', 'scale',
  'cps', 'cpm', 'gain', 'room', 'size', 'lpf', 'hpf', 'bpf', 'attack', 'decay',
  'sustain', 'release', 'slow', 'fast', 'every', 'off', 'when', 'often',
  'sometimes', 'struct', 'mask', 'arrange', 'silence', 'press', 'legato',
  // Сигналы-генераторы (измерены как рабочие, §7 реестра фактов):
  // time — монотонная ось для рампов, saw — пилообразный рамп.
  'time', 'saw',
]);

/** Сигналы Strudel: значение читается один раз на ноту, если не задан .seg(). */
const SIGNAL_NAMES = /\b(sine|square|triangle|tri|saw|sawtooth|noise|perlin)\b/;

/** Методы-фильтры/усиления, в которые чаще всего кладут сигнал. */
const FILTER_METHODS = new Set(['lpf', 'hpf', 'bpf', 'gain', 'room', 'cutoff']);

// ─────────────────────────────────────────────────────────────────────────────
// Разбор кода на партии
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Делит код на партии (`$NAME: ...`). Преамбула (строки до первой партии)
 * отдельной партией не считается — правила работают по партиям.
 * @returns {{label: string, text: string, startLine: number, start: number}[]}
 */
export function splitParts(code) {
  const lines = String(code || '').split('\n');
  const parts = [];
  let current = null;
  let offset = 0;
  lines.forEach((line, idx) => {
    const m = line.match(/^\s*(?:[_S]?\$[A-Za-z0-9_]*)\s*:(.*)$/);
    if (m) {
      const label = line.slice(0, line.indexOf(':')).trim().replace(/^[_S]?\$/, '');
      current = { label, text: m[1], startLine: idx + 1, start: offset + m.index + m[0].indexOf(m[1]) };
      parts.push(current);
    } else if (current) {
      current.text += `\n${line}`;
    }
    offset += line.length + 1;
  });
  return parts;
}

/** Номера строк, где встречается совпадение (для отчёта правила). */
function lineOfMatch(code, index) {
  return String(code).slice(0, index).split('\n').length;
}

/** Убирает комментарии и строковые литералы — чтобы правила смотрели на код, а не на текст. */
function stripLiterals(code) {
  let out = '';
  let inString = null;
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    const n = code[i + 1];
    if (inString) {
      if (c === '\\') { i += 1; continue; }
      if (c === inString) inString = null;
      out += ' ';
      continue;
    }
    if (c === '/' && n === '/') { while (i < code.length && code[i] !== '\n') i += 1; out += '\n'; continue; }
    if (c === '/' && n === '*') {
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 1;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inString = c; out += ' '; continue; }
    out += c;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Правила
// ─────────────────────────────────────────────────────────────────────────────

/**
 * R1 — имя лада написано не так, как его понимает движок.
 * Замеры: "A:harmonic:minor" → 5 событий (A3,C4,E4,F4,A4); "A harmonic minor" →
 * 2 события ЧУЖИХ нот (Ab3,C4) — то есть тихо и неверно; "A:harmonic_minor" и
 * "A:harmonicminor" → 0 событий; "A:harmonic" → 0 событий.
 */
function ruleScaleSpelling(code) {
  const findings = [];
  const re = /\.scale\(\s*"([^"]*)"\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const raw = m[1];
    const line = lineOfMatch(code, m.index);
    const hasSpace = /[\s_]/.test(raw);
    const parts = raw.split(':');
    const mode = parts.slice(1).join(':');

    if (hasSpace) {
      const fixed = raw.replace(/[\s_]+/g, ':');
      const known = MEASURED_MODE_FIXES.get(raw.toLowerCase());
      const suggestion = known ? parts[0] + ':' + known : fixed;
      findings.push({
        id: 'R1',
        level: 'error',
        line,
        message: `Название лада «${raw}» движок не понимает (пробел или подчёркивание вместо двоеточия). Рабочее написание — «${suggestion}».`,
        fix: { kind: 'replace', from: `.scale("${raw}")`, to: `.scale("${suggestion}")` },
      });
      continue;
    }
    if (parts.length < 2) {
      findings.push({
        id: 'R1',
        level: 'error',
        line,
        message: `Название лада «${raw}» неполное: нужен вид «тоника:лад», например «a:minor».`,
        fix: null,
      });
      continue;
    }
    if (!MEASURED_MODES.has(mode.toLowerCase())) {
      const known = MEASURED_MODE_FIXES.get(mode.toLowerCase());
      findings.push({
        id: 'R1',
        level: 'error',
        line,
        message: `Лад «${mode}» не измерен как рабочий в Strudel 1.3.0. Измеренные лады: ${[...MEASURED_MODES].slice(0, 8).join(', ')} и другие.`,
        fix: known ? { kind: 'replace', from: `.scale("${raw}")`, to: `.scale("${parts[0]}:${known}")` } : null,
      });
    }
  }
  return findings;
}

/**
 * R2 — chord(...) не играет аккорд.
 *
 * Два разных случая, и лечатся они по-разному:
 *
 * 1. Символ аккорда ("Am", "F^7", "Fmaj7"). Без .voicing() партия не содержит
 *    высот: замер — chord("Am") → 1 событие, 0 нот; chord("Am").voicing() → 5 нот.
 *    Причём без .voicing() СИМВОЛ НЕ ВАЖЕН: chord("Am"), chord("a3") и
 *    chord("<a3 c4 e4>") дают одинаковый звук (LUFS −29.12 у всех трёх).
 *
 * 2. Список нот ("<a3 c4 e4> <f3 a3 c4>"). Движок читает это как
 *    последовательность СИМВОЛОВ ("a3", "c4", "f3"), а не как ноты: событий 4,
 *    высот 0. Приколю .voicing() — событий 0, то есть полная тишина.
 *    Правильная форма — note() с одновременными нотами в скобках [].
 */
function ruleChordVoicing(code) {
  const findings = [];
  const parts = splitParts(code);
  for (const part of parts) {
    const chordRe = /chord\(\s*"([^"]*)"\s*\)/g;
    let m;
    while ((m = chordRe.exec(part.text)) !== null) {
      const spelling = m[1];
      const line = lineOfMatch(code, part.start + m.index);
      const isNoteList = isNoteListSpelling(spelling);

      if (isNoteList) {
        const fixed = fixNoteListChord(spelling);
        findings.push({
          id: 'R2',
          level: 'error',
          line,
          message: `chord("${spelling}") — движок читает это как символы аккордов, а не как ноты: высот у партии нет. Нужен note() с одновременными нотами в скобках [ ].`,
          fix: fixed ? { kind: 'replace', from: `chord("${spelling}")`, to: `note("${fixed}")` } : null,
        });
        continue;
      }

      if (!/\.voicing\(\)/.test(part.text)) {
        findings.push({
          id: 'R2',
          level: 'error',
          line,
          message: `chord("${spelling}") без .voicing() не даёт нот — партия молчит.`,
          fix: { kind: 'insert-after', from: `chord("${spelling}")`, to: `chord("${spelling}").voicing()` },
        });
      }

      const fixed = fixChordSpelling(spelling);
      if (fixed) {
        findings.push({
          id: 'R2',
          level: 'error',
          line,
          message: `Написание аккорда «${spelling}» движок не понимает (замер: 0 событий). Рабочее написание — «${fixed}».`,
          fix: { kind: 'replace', from: `chord("${spelling}")`, to: `chord("${fixed}")` },
        });
      }
    }
  }
  return findings;
}

/**
 * Список НОТ или последовательность СИМВОЛОВ аккордов?
 *
 * Замер (E-043):
 *   chord("Cm")                        → 10 событий, 10 нот — работает;
 *   chord("<Cm Ab>").voicing()         → 9 событий, 9 нот — работает;
 *   chord("<Am7 FM7 CM7 G6>").voicing()→ 10 событий с нотами — работает;
 *   chord("<a3 c4 e4>").voicing()      → 0 событий («unknown chord a3») — тишина.
 *
 * Значит список нот — это когда ВСЕ токены похожи на высоты (a3, c4, eb4, f#3).
 * Символы аккордов (Cm, Ab, Am7, F^7, G6) нотами не являются: прежняя проверка
 * «есть пробел или угловые скобки» ругалась на рабочую форму, которой полон
 * корпус знаний (D-161).
 */
function isNoteListSpelling(spelling) {
  const tokens = String(spelling || '').replace(/[<>]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((token) => /^[a-g](#|b)?\d+$/.test(token));
}

/**
 * Переводит список нот в форму с одновременными нотами:
 * "<a3 c4 e4> <f3 a3 c4>" → "<[a3,c4,e4] [f3,a3,c4]>".
 * Возвращает null, если форму разобрать не удалось.
 */
function fixNoteListChord(spelling) {
  const groups = spelling.match(/<[^<>]*>/g);
  if (!groups || !groups.length) return null;
  const chords = [];
  for (const group of groups) {
    const notes = group.replace(/[<>]/g, '').split(/\s+/).filter(Boolean);
    if (!notes.length) return null;
    chords.push(`[${notes.join(',')}]`);
  }
  return `<${chords.join(' ')}>`;
}

/** Измеренное исправление написания аккорда: maj7 → M7, "C:min" → "Cm". */
function fixChordSpelling(spelling) {
  let fixed = spelling;
  for (const [from, to] of MEASURED_CHORD_FIXES) {
    if (fixed.endsWith(from)) fixed = fixed.slice(0, fixed.length - from.length) + to;
  }
  const colon = fixed.match(/^([A-G][#b]?):min$/);
  if (colon) fixed = `${colon[1]}m`;
  return fixed === spelling ? null : fixed;
}

/**
 * R3 — имя функции отличается только регистром.
 * Замеры: duckOrBit / duckOrBit / duckAttack → «is not a function»;
 * duckorbit / duckattack / duckdepth / duckonset — работают.
 */
function ruleCaseSensitiveNames(code) {
  const findings = [];
  const stripped = stripLiterals(code);
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    if (MEASURED_NAMES.has(name)) continue;
    const lower = name.toLowerCase();
    if (!MEASURED_NAMES.has(lower)) continue; // не измерен — не судим
    const line = lineOfMatch(code, m.index);
    findings.push({
      id: 'R3',
      level: 'error',
      line,
      message: `«${name}» не существует: в Strudel 1.3.0 есть «${lower}». Имена семейства duck* регистрозависимы.`,
      fix: { kind: 'replace', from: `.${name}(`, to: `.${lower}(` },
    });
  }
  return findings;
}

/**
 * R4 — duckorbit(N) на партии, у которой самой .orbit(N).
 * Duck приглушает ВСЮ орбиту, поэтому приглушается и носитель кика.
 */
function ruleDuckSelfOrbit(code) {
  const findings = [];
  for (const part of splitParts(code)) {
    const orbits = new Set([...part.text.matchAll(/\.orbit\(\s*(\d+)\s*\)/g)].map((m) => m[1]));
    for (const m of part.text.matchAll(/\.duckorbit\(\s*(\d+)\s*\)/g)) {
      if (!orbits.has(m[1])) continue;
      findings.push({
        id: 'R4',
        level: 'warn',
        line: part.startLine,
        message: `Партия ${part.label}: .duckorbit(${m[1]}) и .orbit(${m[1]}) на одной партии — приглушается сама носительница кика.`,
        fix: null,
      });
    }
  }
  return findings;
}

/**
 * R5 — слишком короткий возврат громкости.
 * Замер: duckattack(0.001) исполняется, но «качки» не даёт — время возврата
 * короче, чем размах атаки. Порог 0.01 с — из документации и замера длительности.
 */
function ruleDuckAttackTooShort(code) {
  const findings = [];
  const re = /\.duckattack\(\s*([\d.]+)\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value >= 0.01) continue;
    findings.push({
      id: 'R5',
      level: 'warn',
      line: lineOfMatch(code, m.index),
      message: `duckattack(${m[1]}) — возврат громкости почти мгновенный, «качки» не будет. Для эффекта берут 0.1–0.3 с.`,
      fix: null,
    });
  }
  return findings;
}

/**
 * R6 — сигнал в фильтре без .seg().
 * Замеры: note("c4").lpf(sine.range(200,2000)) → 1 событие (значение читается
 * один раз на ноту, фильтр не «открывается»); с .seg(16) → 16 событий.
 */
function ruleSignalWithoutSeg(code) {
  const findings = [];
  for (const part of splitParts(code)) {
    const stripped = stripLiterals(part.text);
    const re = /\.(lpf|hpf|bpf|gain|room|cutoff)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const method = m[1];
      if (!FILTER_METHODS.has(method)) continue;
      if (!SIGNAL_NAMES.test(m[2])) continue;
      // .seg() где угодно в этой партии снимает предупреждение.
      if (/\.seg\s*\(/.test(stripped)) continue;
      findings.push({
        id: 'R6',
        level: 'warn',
        line: part.startLine,
        message: `Партия ${part.label}: сигнал в .${method}() без .seg(n): значение читается один раз на ноту — фильтр не откроется плавно. Для непрерывной огибающей используют .seg(n) или lpenv.`,
        fix: null,
      });
    }
  }
  return findings;
}

/**
 * R7 — duckorbit(N) без партии-жертвы на орбите N.
 * D-035: «duck target orbit N does not exist» — дакинга не будет, партия играет
 * как ни в чём не бывало.
 */
function ruleDuckWithoutTarget(code) {
  const findings = [];
  const orbits = new Set();
  for (const part of splitParts(code)) {
    for (const m of part.text.matchAll(/\.orbit\(\s*(\d+)\s*\)/g)) orbits.add(m[1]);
  }
  for (const part of splitParts(code)) {
    for (const m of part.text.matchAll(/\.duckorbit\(\s*(\d+)\s*\)/g)) {
      if (orbits.has(m[1])) continue;
      findings.push({
        id: 'R7',
        level: 'warn',
        line: part.startLine,
        message: `Партия ${part.label}: .duckorbit(${m[1]}), но ни одна партия не встала на орбиту ${m[1]} — приглушать нечего (движок пишет «duck target orbit ${m[1]} does not exist»).`,
        fix: null,
      });
    }
  }
  return findings;
}

/**
 * R8 — колебательный сигнал вместо рампы в фильтре.
 *
 * ЗАМЕР (E-042, docs/evidence/music/filter-ramp-2026-11-19.json):
 *   .lpf(sine.range(200,4000))        → срез 2100 → 2827 → 3444 → 3855 → 4000 → 3855 → 2100:
 *                                      две смены направления, центроид стоит (193 → 193 Гц),
 *                                      верхняя полоса падает (−2.9 дБ). Фильтр НЕ открывается.
 *   .lpf(time.range(200,4000))        → срез 200 → 4000 монотонно, центроид 97 → 253 Гц,
 *                                      верхняя полоса +51.8 дБ. Это настоящий рамп.
 *   .lpf(sine.slow(8).range(...))     → монотонно в пределах окна (0 смен направления),
 *                                      но синус остаётся синусом: через период срез вернётся.
 *
 * Правило ловит только ЗАВЕДОМО колебательные сигналы (sine/perlin/tri/saw/square)
 * без .slow(): их нельзя прочитать как «рампу». .slow() не exempt-ится — наоборот,
 * он делает колебание медленным, и это допустимый приём.
 */
function ruleOscillatingSignalInFilter(code) {
  const findings = [];
  const re = /\.(lpf|hpf|bpf|cutoff)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  for (const part of splitParts(code)) {
    const stripped = stripLiterals(part.text);
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const method = m[1];
      if (!FILTER_METHODS.has(method)) continue;
      const argument = m[2];
      // time.range — измеренный монотонный рамп; .slow() — осознанное замедление.
      if (/\btime\s*\./.test(argument)) continue;
      if (/\.slow\s*\(/.test(argument)) continue;
      const signal = /\b(sine|perlin|tri|triangle|saw|sawtooth|square)\s*\.\s*range\s*\(/.exec(argument);
      if (!signal) continue;
      findings.push({
        id: 'R8',
        level: 'warn',
        line: part.startLine,
        message:
          `Партия ${part.label}: ${signal[1]}.range() в .${method}() — колебательный сигнал, срез не раскрывается монотонно ` +
          '(измерено: sine.range идёт 2100 → 4000 → 2100 и обратно). Для нарастания используют time.range(200,4000) ' +
          '(измерено: срез 200 → 4000 монотонно, верхняя полоса +51.8 дБ).',
        fix: null,
      });
    }
  }
  return findings;
}

/** Реестр правил: порядок = порядок проверки. */
export const RULES = [
  { id: 'R1', level: 'error', title: 'Написание лада', check: ruleScaleSpelling },
  { id: 'R2', level: 'error', title: 'Аккорд без .voicing()', check: ruleChordVoicing },
  { id: 'R3', level: 'error', title: 'Регистр имени функции', check: ruleCaseSensitiveNames },
  { id: 'R4', level: 'warn', title: 'Duck приглушает сам себя', check: ruleDuckSelfOrbit },
  { id: 'R5', level: 'warn', title: 'Слишком короткий duckattack', check: ruleDuckAttackTooShort },
  { id: 'R6', level: 'warn', title: 'Сигнал без .seg()', check: ruleSignalWithoutSeg },
  { id: 'R7', level: 'warn', title: 'Duck без жертвы на орбите', check: ruleDuckWithoutTarget },
  { id: 'R8', level: 'warn', title: 'Колебательный сигнал вместо рампы', check: ruleOscillatingSignalInFilter },
];

/**
 * Проверяет код по всем правилам.
 * @param {string} code
 * @returns {{ok: boolean, findings: object[], errors: object[], warnings: object[]}}
 */
export function checkRules(code) {
  const findings = [];
  for (const rule of RULES) {
    try {
      findings.push(...rule.check(String(code || '')));
    } catch {
      // Правило не должно ронять проверку: молчаливый отказ хуже отсутствия находки.
    }
  }
  findings.sort((a, b) => a.line - b.line);
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warn');
  return { ok: errors.length === 0, findings, errors, warnings };
}

/**
 * Применяет автофиксы правил к коду.
 * @param {string} code
 * @param {object[]} findings находки из checkRules
 * @returns {{code: string, applied: {id: string, from: string, to: string}[]}}
 */
export function applyFixes(code, findings) {
  let out = String(code || '');
  const applied = [];
  for (const f of findings) {
    if (!f.fix || f.level !== 'error') continue;
    if (f.fix.kind === 'replace' && out.includes(f.fix.from)) {
      out = out.replace(f.fix.from, f.fix.to);
      applied.push({ id: f.id, from: f.fix.from, to: f.fix.to });
    }
    if (f.fix.kind === 'insert-after' && out.includes(f.fix.from) && !out.includes(f.fix.to)) {
      out = out.replace(f.fix.from, f.fix.to);
      applied.push({ id: f.id, from: f.fix.from, to: f.fix.to });
    }
  }
  return { code: out, applied };
}
