// Headless-исполнение Strudel в Node: реальные события без браузера и без FFT.
//
// Зачем это нужно: метрики прогрессии (энергия по тактам, гармонический
// ритм, новизна секций, вариативность партий) требуют событий на горизонте
// 32–96 тактов. Свой парсер mini-нотации разбирает один-два такта и не
// понимает `arrange`, `stack`, `cat/slowcat`, `<...>/n`, `.slow/.fast`,
// `.mask`, `.struct`, `.every`. Настоящий Strudel умеет всё это и отдаёт
// события через queryArc.
//
// ПОЧЕМУ НЕ `import` ПАКЕТОВ @strudel/core, @strudel/mini, @strudel/tonal:
// они собираются как ESM-пакеты, но @strudel/core импортирует `SalatRepl`
// из @kabelsalat/web, у которого в `main` лежит UMD-бандл без этого экспорта.
// Прямой import падает с «does not provide an export named 'SalatRepl'».
// Рабочий путь — загрузить готовый UMD-бандл @strudel/web через new Function.
// Тот же приём уже применён в scripts/check-presets.mjs.
//
// Бандл обращается к браузерным API на уровне модуля, поэтому окружение
// подменяется минимальными заглушками. Звука здесь нет — нужны паттерны.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

function installBrowserStubs() {
  const noop = () => {};
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
  globalThis.postMessage = noop;
  globalThis.document = {
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild: noop, style: {} },
    createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }),
    currentScript: null,
  };
}

let loadPromise = null;

/**
 * Загружает Strudel один раз: UMD-бандл + строковый парсер mini + заглушки
 * визуализаций. Результат кэшируется на уровне модуля.
 * @returns {Promise<object>} экспорты @strudel/web
 */
export function loadStrudel() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    installBrowserStubs();
    const bundlePath = resolve(root, 'node_modules/@strudel/web/dist/index.js');
    const source = await readFile(bundlePath, 'utf8');
    // eslint-disable-next-line no-new-func
    const api = new Function(`${source}\n;return strudel;`)();
    if (!api || typeof api.mini !== 'function') {
      throw new Error('Не удалось загрузить Strudel: в бандле нет mini()');
    }
    // Ключевой момент: без этого строковые литералы не разбираются mini-нотацией,
    // и n("0 5 2 6") даёт ОДНО событие "0 5 2 6" вместо трёх нот.
    // В браузере это делает initStrudel; в Node вызываем явно.
    api.setStringParser(api.mini);
    installVisualStubs(api);
    globalThis.strudel = api;
    return api;
  })();
  return loadPromise;
}

// Алиасы визуализаций живут в приложении (src/pianoroll.js), а не в Strudel.
// Без заглушек код с `._pianoroll()` не исполнится в Node.
function installVisualStubs(api) {
  const proto = api.Pattern?.prototype;
  if (!proto) return;
  for (const name of ['_pianoroll', '_scope', '_fscope', '_spectrum']) {
    if (typeof proto[name] !== 'function') {
      proto[name] = function () {
        return this;
      };
    }
  }
}

/** Список экспортируемых имён — whitelist для валидатора и промптов. */
export async function strudelExportNames() {
  const api = await loadStrudel();
  return Object.keys(api)
    .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
    .sort();
}

// Текущий сборщик партий: transpiler превращает `$BASS: expr` в `expr.p('$BASS')`,
// а метод p мы подменяем на наш — он кладёт паттерн в реестр.
let collector = null;

function installPartCollector(api) {
  if (!api.Pattern?.prototype) return;
  api.Pattern.prototype.p = function (label) {
    if (typeof label === 'string' && collector) {
      const name = label.replace(/^\$/, '');
      collector[name] = this;
    }
    return this;
  };
}

/**
 * Исполняет код Strudel без браузера и отдаёт события по партиям.
 *
 * @param {string} code код Strudel с партиями `$NAME:`
 * @param {{cycles?: number}} [options] сколько тактов опросить у каждой партии
 * @returns {Promise<{ok: boolean, error: string|null, parts: Record<string, Array>, order: string[]}>}
 */
export async function runStrudel(code, { cycles = 8 } = {}) {
  const api = await loadStrudel();
  installPartCollector(api);

  const parts = {};
  const order = [];
  const errors = [];
  collector = parts;

  try {
    const { output } = api.transpiler(String(code ?? ''));
    const sandbox = buildSandbox(api);
    // eslint-disable-next-line no-new-func
    const fn = new Function('__sandbox__', `with (__sandbox__) {\n${output}\n}`);
    fn(sandbox);
  } catch (err) {
    errors.push(String(err?.message || err));
  } finally {
    collector = null;
  }

  const out = {};
  for (const name of Object.keys(parts)) {
    const pattern = parts[name];
    try {
      const haps = pattern.queryArc(0, cycles);
      out[name] = haps.map(normalizeHap);
      order.push(name);
    } catch (err) {
      errors.push(`$ ${name}: ${String(err?.message || err)}`);
    }
  }

  return { ok: errors.length === 0, error: errors.length ? errors.join('; ') : null, parts: out, order };
}

// Песочница исполнения: функции Strudel + заглушки транспорта.
// setCpm/setcps/cpm — управление темпом; здесь они ничего не делают,
// темп берётся из текста кода (src/core/code-model.js).
function buildSandbox(api) {
  const sandbox = { ...api };
  sandbox.setCpm = () => undefined;
  sandbox.setcpm = () => undefined;
  sandbox.setCps = () => undefined;
  sandbox.setcps = () => undefined;
  sandbox.cpm = () => undefined;
  sandbox.hush = () => undefined;
  return sandbox;
}

/** BigInt во временах превращаем в число — иначе JSON не сериализуется. */
function normalizeHap(hap) {
  const out = {};
  for (const [key, value] of Object.entries(hap)) {
    if (typeof value === 'bigint') out[key] = Number(value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = { ...value };
    else out[key] = value;
  }
  // Время начала/конца приводим к числам — по ним строятся все метрики.
  if (out.whole) {
    out.whole = {
      ...out.whole,
      begin: Number(out.whole.begin),
      end: Number(out.whole.end),
    };
  }
  if (out.part) {
    out.part = { ...out.part, begin: Number(out.part.begin), end: Number(out.part.end) };
  }
  return out;
}
