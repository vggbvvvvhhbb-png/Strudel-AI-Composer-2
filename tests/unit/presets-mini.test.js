// Пресеты проверяем настоящим парсером mini-нотации из @strudel/web.
// Раньше все 6 пресетов содержали точку вместо тильды и молча не играли —
// тест ловит это до того, как пресет попадёт к пользователю.
import { describe, expect, it, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PRESETS } from '../../src/presets/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

let mini = null;

/** Строковые литералы кода: не залезаем за закрывающую кавычку. */
function stringLiterals(code) {
  const out = [];
  for (const m of code.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

beforeAll(async () => {
  // @strudel/web — UMD-бандл с браузерными зависимостями: в node грузим телом файла.
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
  const source = await readFile(resolve(root, 'node_modules/@strudel/web/dist/index.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  const strudel = new Function(`${source}\n;return strudel;`)();
  mini = strudel.mini;
});

describe('mini-нотация в пресетах', () => {
  it('парсер mini доступен', () => {
    expect(typeof mini).toBe('function');
  });

  it('каждая mini-строка каждого пресета разбирается без ошибок', () => {
    for (const preset of PRESETS) {
      for (const literal of stringLiterals(preset.code)) {
        if (!/[~.<>*/]/.test(literal)) continue; // не mini-нотация
        expect(() => mini(literal), `${preset.id}: "${literal}"`).not.toThrow();
      }
    }
  });

  it('в пресетах нет точки на месте паузы', () => {
    for (const preset of PRESETS) {
      for (const literal of stringLiterals(preset.code)) {
        expect(/(^|\s)\.(\s|$)/.test(literal), `${preset.id}: "${literal}"`).toBe(false);
      }
    }
  });
});
