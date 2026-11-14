// Линтер примеров скил-карт.
//
// Спека (docs/SKILLS.md, раздел «CI check:skills»): каждый блок ```js из
// EXAMPLES должен проходить dry-parse существующим адаптером (код → паттерн
// БЕЗ звука) и theory-lint v1 (0 errors).
//
// Что здесь проверяется честно, а что нет:
//
//   Проверяется (и доказуемо):
//     • исполняемость кода в headless-рантайме Strudel — синтаксис, имена
//       контролов, mini-нотация; ни одного сэмпла не звучит;
//     • запрещённые конструкции (eval, Function, fetch, import, …) — тот же
//       список, что и в freeform-воротах;
//     • guardrails из paramRanges: delayfeedback < 1, gain ≤ 1.2,
//       duckdepth ≤ 1, |microtiming| ≤ 20 мс;
//     • соответствие нот ладу, если пример объявляет `.scale("X:mode")`.
//
//   НЕ проверяется (и это зафиксировано в DECISIONS, D-058):
//     • полный theory-lint оракула (параллельные квинты, коллизии регистров
//       бас/аккорды) — он живёт в src/oracle/lint.js и работает по IR, а не по
//       сырому коду. Для примеров карт применяется подмножество: лад и
//       guardrails. Полный линт включается на этапе компиляции IR.
//
// Принцип: лучше меньше проверок, которые действительно исполняются, чем
// список правил, который никто не запускал.

import { runStrudel } from '../music/strudel-runtime.mjs';

/**
 * Конструкции, запрещённые в примерах: тот же список, что и в freeform-воротах
 * (§5.5 брифа). Пример карты — это код, который попадёт в промт модели, а
 * значит может быть скопирован в студию.
 */
export const FORBIDDEN_PATTERNS = [
  { code: 'eval', re: /\beval\s*\(/ },
  { code: 'new-function', re: /\bnew\s+Function\s*\(/ },
  { code: 'function-constructor', re: /\bFunction\s*\(/ },
  { code: 'fetch', re: /\bfetch\s*\(/ },
  { code: 'import', re: /\bimport\s*[({*'"]/ },
  { code: 'require', re: /\brequire\s*\(/ },
  { code: 'window', re: /\bwindow\s*\./ },
  { code: 'document', re: /\bdocument\s*\./ },
  { code: 'global-this', re: /\bglobalThis\b/ },
  { code: 'local-storage', re: /\blocalStorage\b/ },
  { code: 'xml-http-request', re: /\bXMLHttpRequest\b/ },
  { code: 'websocket', re: /\bWebSocket\b/ },
  { code: 'prototype-pollution', re: /__proto__|\bconstructor\b/ },
];

/**
 * Guardrails: числовые ограничения из docs/SKILLS.md.
 * value — пределы; kind — как читать значение из кода.
 */
export const GUARDRAILS = {
  delayfeedback: { max: 1, exclusive: true, reason: 'задержка обратной связи должна быть < 1' },
  gain: { max: 1.2, exclusive: false, reason: 'гейн роли ≤ 1.2' },
  duckdepth: { max: 1, exclusive: false, reason: 'глубина сайдчейна ≤ 1' },
  size: { max: 10, exclusive: false, reason: 'размер реверберации 0..10' },
};

/** Лады и их ступени (pitch classes от тоники). */
export const MODE_STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

/** Псевдонимы модальностей, которые встречаются в примерах карт. */
const MODE_ALIASES = {
  maj: 'major', min: 'minor', ionian: 'major', aeolian: 'minor',
};

/**
 * Находит запрещённые конструкции.
 * @param {string} code
 * @returns {Array<{code:string,message:string}>}
 */
export function scanForbidden(code) {
  const text = String(code ?? '');
  const findings = [];
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.re.test(text)) {
      findings.push({ code: rule.code, message: `запрещённая конструкция: ${rule.code}` });
    }
  }
  return findings;
}

/**
 * Читает числовой аргумент контрола: `.delayfeedback(.35)` → 0.35.
 * @param {string} code
 * @param {string} control имя контрола
 * @returns {number[]}
 */
function controlValues(code, control) {
  const values = [];
  const re = new RegExp(`\\.${control}\\s*\\(\\s*(-?\\d+(?:\\.\\d+)?)`, 'g');
  let match = re.exec(String(code ?? ''));
  while (match) {
    values.push(Number(match[1]));
    match = re.exec(String(code ?? ''));
  }
  return values;
}

/**
 * Микротайминг: в примерах задаётся через `late(ms(12))` / `early(ms(4))`,
 * где ms(x) — миллисекунды. Проверяем именно миллисекунды.
 * @param {string} code
 * @returns {Array<{code:string,message:string,value:number}>}
 */
export function scanMicrotiming(code) {
  const text = String(code ?? '');
  const findings = [];
  const re = /\b(late|early)\s*\(\s*ms\s*\(\s*(-?\d+(?:\.\d+)?)/g;
  let match = re.exec(text);
  while (match) {
    const value = Number(match[2]);
    if (Math.abs(value) > 20) {
      findings.push({
        code: 'microtiming-range',
        message: `микротайминг ${match[2]} мс вне диапазона ±20 мс`,
        value,
      });
    }
    match = re.exec(text);
  }
  return findings;
}

/**
 * Guardrails по числовым значениям в коде.
 * @param {string} code
 * @returns {Array<{code:string,message:string,value:number}>}
 */
export function scanGuardrails(code) {
  const findings = [];
  for (const [control, rule] of Object.entries(GUARDRAILS)) {
    for (const value of controlValues(code, control)) {
      const bad = rule.exclusive ? value >= rule.max : value > rule.max;
      if (bad) {
        findings.push({
          code: `guardrail-${control}`,
          message: `.${control}(${value}) — ${rule.reason}`,
          value,
        });
      }
    }
  }
  return findings;
}

/**
 * Лад, объявленный в коде: `.scale("D:minor")`.
 * @param {string} code
 * @returns {{tonic:string, mode:string}|null}
 */
export function parseScale(code) {
  const match = /\.scale\s*\(\s*["']([A-G][#b]?):(\w+)["']/.exec(String(code ?? ''));
  if (!match) return null;
  const mode = MODE_ALIASES[match[2].toLowerCase()] ?? match[2].toLowerCase();
  if (!MODE_STEPS[mode]) return null;
  return { tonic: match[1], mode };
}

/**
 * Делит код на голоса по строкам, начинающимся с `$`.
 *
 * В примерах карт используется синтаксис `$: ...` — части без имени, поэтому
 * делить по голосам нужно вручную, иначе масштаб одной партии приклеивается
 * к нотам другой.
 *
 * Строки до первой `$` (объявления `const ms = ...`, `setcpm(...)`) — это
 * преамбула: она нужна каждому голосу, поэтому приклеивается к каждому из них.
 *
 * @param {string} code
 * @returns {{preamble: string, voices: string[]}}
 */
export function splitVoices(code) {
  const lines = String(code ?? '').split('\n');
  const preamble = [];
  const voices = [];
  let current = null;
  for (const line of lines) {
    if (/^\s*\$/.test(line)) {
      if (current) voices.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) voices.push(current.join('\n'));
  return {
    preamble: preamble.join('\n'),
    voices: voices.length ? voices : [String(code ?? '')],
  };
}

/**
 * Убирает загрузку сэмплов из кода: `samples('github:...')` тянет сеть, а в CI
 * сети нет и проверять тут нечего — палитра проверяется манифестом отдельно.
 * @param {string} code
 * @returns {string}
 */
export function stripSampleLoading(code) {
  return String(code ?? '').replace(/\bsamples\s*\([^)]*\)/g, '/* samples stripped */');
}

/**
 * Pitch class из названия ноты: "A3" → 9, "Bb2" → 10.
 * @param {string} note
 * @returns {number|null}
 */
export function notePitchClass(note) {
  const match = /^([A-G])([#b]?)(-?\d+)?/.exec(String(note ?? ''));
  if (!match) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]];
  if (base === undefined) return null;
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  return ((base + accidental) % 12 + 12) % 12;
}

/**
 * Множество pitch classes лада.
 * @param {string} mode
 * @param {string} tonic
 * @returns {Set<number>}
 */
export function scalePitchClasses(mode, tonic) {
  const steps = MODE_STEPS[mode] ?? MODE_STEPS.minor;
  const root = notePitchClass(`${tonic}0`);
  const set = new Set();
  for (const step of steps) set.add(((root + step) % 12 + 12) % 12);
  return set;
}

/**
 * Собирает ноты из событий голоса.
 * @param {Array<object>} events
 * @returns {string[]}
 */
export function collectNotes(events) {
  const notes = [];
  for (const event of events) {
    const note = event?.value?.note;
    if (typeof note === 'string' && note) notes.push(note);
  }
  return notes;
}

/**
 * Ловушка mini-нотации: `"<a b c>"` в Strudel — это ОДИН элемент за цикл,
 * а не последовательность шагов внутри такта.
 *
 * Измерено в headless-рантайме (tests/spike/skills-example-shape.probe.mjs):
 *   n("0 2 4")        → 3 события за цикл;
 *   n("<0 2 4>")      → 1 событие за цикл;
 *   n("<0 2 4>").scale("D:minor") → 1 событие, и `.degradeBy(.3)` может
 *   выбить его целиком — голос замолкает.
 *
 * Поэтому шаги внутри такта пишутся без угловых скобок, а прогрессии
 * (`chord("<Am F C G>")`) и маски (`mask("<1!15 0>")`) — с ними, там
 * один элемент за цикл как раз нужно.
 *
 * Явное opt-out: комментарий `one-per-cycle` в коде голоса.
 *
 * @param {string} code
 * @returns {Array<{code:string,message:string}>}
 */
export function scanSequenceAngles(code) {
  const text = String(code ?? '');
  if (/one-per-cycle/.test(text)) return [];
  const findings = [];
  const re = /\b(?:n|note)\s*\(\s*(["'])([^"']*<[^"']*)\1/g;
  let match = re.exec(text);
  while (match) {
    findings.push({
      code: 'angle-sequence-in-note',
      message: `n()/note() с "<...>" даёт один элемент за цикл (измерено: n("<0 2 4>") → 1 событие), `
        + `а не шаги внутри такта: «${match[2]}» → «${match[2].replace(/[<>]/g, '')}»`,
    });
    match = re.exec(text);
  }
  return findings;
}

/**
 * Проверяет один пример карты.
 *
 * @param {string} code
 * @param {{cycles?: number}} [options]
 * @returns {Promise<{ok: boolean, errors: Array<object>, warnings: Array<object>, voices: number, events: number, sampleVoices: number}>}
 */
export async function lintExample(code, { cycles = 2 } = {}) {
  const errors = [];
  const warnings = [];

  for (const finding of scanForbidden(code)) errors.push(finding);
  for (const finding of scanGuardrails(code)) errors.push(finding);
  for (const finding of scanMicrotiming(code)) errors.push(finding);
  for (const finding of scanSequenceAngles(code)) errors.push(finding);

  const { preamble, voices: rawVoices } = splitVoices(code);
  const safePreamble = stripSampleLoading(preamble);
  const voices = rawVoices.map((voice) => (safePreamble ? `${safePreamble}\n${voice}` : voice));
  let eventCount = 0;
  let sampleVoices = 0;

  for (const [index, voice] of voices.entries()) {
    const isSampleVoice = /\bs\s*\(/.test(voice) && !/\b(n|chord)\s*\(/.test(voice);
    let result;
    try {
      result = await runStrudel(voice, { cycles });
    } catch (err) {
      errors.push({ code: 'dry-parse', message: `голос ${index}: ${String(err?.message || err)}` });
      continue;
    }
    if (!result.ok) {
      errors.push({ code: 'dry-parse', message: `голос ${index}: ${result.error}` });
      continue;
    }
    const events = Object.values(result.parts).flat();
    eventCount += events.length;
    if (!events.length) {
      // Голос на сэмплах без загруженных сэмплов событий не даёт — это не
      // дефект карты. Голос на нотах без событий — дефект.
      if (isSampleVoice) {
        sampleVoices += 1;
        continue;
      }
      errors.push({ code: 'empty-voice', message: `голос ${index}: ни одного события` });
      continue;
    }

    // Лад: проверяем только голоса, где лад объявлен явно и нет аккордов.
    const scale = parseScale(voice);
    if (scale && !/\bchord\s*\(/.test(voice)) {
      const allowed = scalePitchClasses(scale.mode, scale.tonic);
      const notes = collectNotes(events);
      const outside = [...new Set(notes.filter((note) => {
        const pc = notePitchClass(note);
        return pc !== null && !allowed.has(pc);
      }))];
      if (outside.length) {
        errors.push({
          code: 'out-of-scale',
          message: `голос ${index}: ноты вне лада ${scale.tonic}:${scale.mode} — ${outside.join(', ')}`,
        });
      }
    }
  }

  if (!eventCount && !errors.length) {
    errors.push({ code: 'empty-voice', message: 'пример не дал ни одного события' });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    voices: voices.length,
    events: eventCount,
    sampleVoices,
  };
}
