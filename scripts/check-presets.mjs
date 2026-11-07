// Проверка пресетов настоящим парсером mini-нотации из @strudel/web.
//
// @strudel/web распространяется UMD-бандлом и тянет браузерные зависимости,
// поэтому в Node модуль грузится не через import, а через вызов тела файла:
// так мы получаем объект экспортов (в нём есть mini).
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// Минимальные заглушки браузерного окружения: бандл обращается к ним на уровне модуля.
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.postMessage = () => {};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { appendChild() {}, style: {} },
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  currentScript: null,
};

const bundlePath = resolve(root, 'node_modules/@strudel/web/dist/index.js');
const source = await readFile(bundlePath, 'utf8');
// eslint-disable-next-line no-new-func
const strudel = new Function(`${source}\n;return strudel;`)();

const mini = typeof strudel?.mini === 'function' ? strudel.mini : null;
if (!mini) {
  console.error('Не удалось получить mini из @strudel/web');
  process.exit(2);
}

const { PRESETS } = await import(pathToFileURL(resolve(root, 'src/presets/index.js')).href);

/** Достаёт строковые литералы из кода, не залезая за закрывающую кавычку. */
export function stringLiterals(code) {
  const out = [];
  for (const m of code.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

let failed = 0;
let checked = 0;

/** Проверяет все mini-строки блока кода. */
function checkCode(code, label) {
  for (const literal of stringLiterals(code)) {
    // Мини-нотация встречается в note/chord/s/n — там, где строка является паттерном.
    if (!/[~.<>*/]/.test(literal)) continue;
    checked += 1;
    try {
      mini(literal);
    } catch (err) {
      failed += 1;
      console.log(`✗ ${label}: "${literal}" → ${err.message.split('\n')[0]}`);
    }
  }
}

for (const preset of PRESETS) {
  checkCode(preset.code, preset.id);
}

// Примеры из системного промпта — модель копирует их, значит они должны быть валидны.
const promptPath = resolve(root, 'server/prompts/system.md');
try {
  const prompt = await readFile(promptPath, 'utf8');
  // Ограждение — только в начале строки: в прозе промта встречается инлайн-```
  // («без markdown-обёрток ```»).
  const blocks = [...prompt.matchAll(/^```[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]);
  blocks.forEach((block, i) => checkCode(block, `system.md#${i + 1}`));
  if (!blocks.length) console.log('! в системном промпте не найдено блоков кода');
} catch {
  console.log('! системный промпт не найден — примеры не проверены');
}

console.log(
  failed
    ? `\n✗ ${failed} из ${checked} мини-строк не разобрались`
    : `\n✓ все ${checked} мини-строк разобрались`
);
process.exit(failed ? 1 : 0);
