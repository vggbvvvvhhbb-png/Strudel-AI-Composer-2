// Валидатор Strudel-кода: статические проверки + тихий прогон в REPL.
// staticValidate — чистая функция без импортов движка, юнит-тесты гоняют её в node.

const MAX_CODE_LENGTH = 20000;

const FORBIDDEN = [
  { re: /\bfetch\s*\(/, why: 'fetch( запрещён — внешние запросы недоступны в песочнице' },
  { re: /\beval\s*\(/, why: 'eval( запрещён' },
  { re: /\bdocument\b/, why: 'обращение к document запрещено' },
  { re: /\bwindow\b/, why: 'обращение к window запрещено' },
  { re: /\bimport\s*[\s("']/, why: 'import запрещён — доступны только функции Strudel' },
  { re: /\blocalStorage\b/, why: 'localStorage запрещён' },
  { re: /\brequire\s*\(/, why: 'require( запрещён' },
];

// Партия: `$MEL:`, `_$BASS:`, `S$X:` или `$:` — признак наличия музыки в коде.
const PART_RE = /(?:^|\n)[ \t]*(?:[_S]?\$\w*)[ \t]*:/;

// Сканер с пропуском // и /* */ комментариев и строковых литералов ('...", "...", `...`).
function checkBalance(code) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  let inString = null;
  let i = 0;
  const lineOf = (idx) => code.slice(0, idx).split('\n').length;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') { while (i < code.length && code[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inString = c; i += 1; continue; }
    if (c === '(' || c === '[' || c === '{') { stack.push({ c, line: lineOf(i) }); i += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (!top || top.c !== pairs[c]) {
        return { ok: false, line: lineOf(i), message: `Лишняя закрывающая «${c}»` };
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (inString) return { ok: false, line: lineOf(code.length), message: `Незакрытая кавычка ${inString}` };
  if (stack.length) {
    const top = stack[stack.length - 1];
    return { ok: false, line: top.line, message: `Не закрыта «${top.c}» (открыта на строке ${top.line})` };
  }
  return { ok: true };
}

export function staticValidate(code) {
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: { line: 0, message: 'Пустой код' } };
  }
  if (code.length > MAX_CODE_LENGTH) {
    return { ok: false, error: { line: 0, message: `Код слишком длинный (${code.length} > ${MAX_CODE_LENGTH})` } };
  }
  const balance = checkBalance(code);
  if (!balance.ok) return { ok: false, error: { line: balance.line, message: balance.message } };
  for (const { re, why } of FORBIDDEN) {
    if (re.test(code)) {
      const line = code.slice(0, code.search(re)).split('\n').length;
      return { ok: false, unsafe: true, error: { line, message: `Небезопасный код: ${why}` } };
    }
  }
  if (!PART_RE.test(code)) {
    return { ok: false, error: { line: 0, message: 'Не найдено ни одной партии ($NAME: или $:)' } };
  }
  return { ok: true };
}

// {line, message} из текста ошибки: "<anonymous>:3:5" / "<eval>:3:1" + фрагмент строки кода.
export function parseErrorLocation(message, code = '') {
  const text = String(message || '');
  const m = text.match(/(?:<anonymous>|<eval>):(\d+):(\d+)/);
  if (!m) return { line: 0, message: text };
  const line = Math.max(1, Number(m[1]));
  const snippet = (code.split('\n')[line - 1] || '').trim().slice(0, 60);
  return { line, message: snippet ? `${text} → «${snippet}»` : text };
}

// Полная проверка: статика + тихий прогон. Движок подгружается динамически —
// модуль остаётся пригодным для node-тестов без браузера.
export async function dryValidate(code) {
  const staticResult = staticValidate(code);
  if (!staticResult.ok) return staticResult;
  const { dryRun } = await import('../strudel-engine.js');
  const run = await dryRun(code);
  if (!run.ok) return { ok: false, error: parseErrorLocation(run.error, code) };
  return { ok: true };
}
