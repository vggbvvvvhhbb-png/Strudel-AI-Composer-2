// Политика безопасности содержимого (CSP).
//
// ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Политика зависит от пути запроса: строгая — для
// обложки и статики, послабленная — для страниц, где исполняется
// сгенерированный код. Helmet умеет только одну политику на всё приложение,
// а два заголовка CSP означают пересечение правил, то есть побеждает строгая.
// Поэтому политику считаем сами и ставим заголовком.
//
// ГДЕ ЧТО РАЗРЕШЕНО.
//   * 'wasm-unsafe-eval' — аудио-движок собирает wasm.
//   * blob: и data: — AudioWorklet-модули Strudel приходят как
//     data:text/javascript;base64; без data: в консоли «could not load
//     AudioWorklet effects».
//   * 'unsafe-eval' — ТОЛЬКО там, где Strudel компилирует паттерны в
//     runtime. Раньше он стоял в script-src сразу для всего приложения:
//     страница без движка платила за то, что движок есть на другой.
//   * 'unsafe-inline' в script-src УБРАН: в index.html, studio.html и
//     tinder.html нет ни одного инлайнового <script> — только модули с src.
//   * 'unsafe-inline' в style-src остаётся: интерфейс ставит стили
//     элементам напрямую (CSSOM), и без этого стиль ломается.

/** Базовая (строгая) политика. */
export const CSP_BASE = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'", 'blob:', 'data:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'blob:', 'https://raw.githubusercontent.com'],
  'connect-src': [
    "'self'",
    'blob:',
    'https://raw.githubusercontent.com',
    'https://shabda.ndre.gr',
    'https://*.githubusercontent.com',
  ],
  'worker-src': ["'self'", 'blob:'],
  'child-src': ["'self'", 'blob:'],
  'frame-src': ["'self'", 'blob:'],
};

/**
 * Страницы, где исполняется сгенерированный код: движок Strudel собирает
 * паттерны через eval, без него звук не работает.
 */
export const CSP_EVAL_PATHS = /^\/(studio\.html|tinder\.html|render-realm\.html|razbor\/)/;

/**
 * Строка CSP для пути запроса.
 * @param {string} path путь запроса
 * @returns {string} значение заголовка Content-Security-Policy
 */
export function cspHeaderFor(path = '/') {
  const directives = CSP_EVAL_PATHS.test(path)
    ? { ...CSP_BASE, 'script-src': [...CSP_BASE['script-src'], "'unsafe-eval'"] }
    : CSP_BASE;
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
