// Round-trip проекта: заголовок `@project` в скомпилированном коде.
//
// Формат (в коде Strudel, в комментариях — код остаётся исполняемым):
//
//   // @project v3 <lz-string(canonicalJson), чанк 1>
//   // @project v3 <lz-string(canonicalJson), чанк 2>
//   // @project-hash sha256:<hex от canonicalJson>
//
// Чанки по ≤2000 символов — чтобы строка заголовка не превышала разумную
// длину и не ломала форматирование. Если заголовка нет — режим «Свободный
// код»: GUI выключен, но код исполняется как раньше.

import lzString from 'lz-string';
import { canonicalJson, ProjectModelSchema } from './model.js';
import { sha256Hex } from './sha256.js';

// lz-string 1.5.0 — UMD без ESM-экспортов: именованный импорт работает только
// в сборщике, а в Node ESM падает. Поэтому берём модуль по умолчанию и
// разбираем нужные функции вручную — так код одинаково живёт в браузере и в CI.
const { compressToEncodedURIComponent, decompressFromEncodedURIComponent } = lzString;

export const PROJECT_HEADER_PREFIX = '// @project v3 ';
export const PROJECT_HASH_PREFIX = '// @project-hash sha256:';
export const CHUNK_LIMIT = 2000;

/** Хеш модели (канонического JSON) — в заголовок и в отчёты. */
export function projectHash(model) {
  return sha256Hex(canonicalJson(model));
}

/** Хеш скомпилированного кода — сравнивается до/после undo. */
export function codeHash(code) {
  return sha256Hex(code);
}

/**
 * Вставляет заголовок проекта в начало кода.
 * @param {string} code
 * @param {object} model
 * @returns {string}
 */
export function embedProjectHeader(code, model) {
  const payload = compressToEncodedURIComponent(canonicalJson(model));
  const chunks = [];
  for (let i = 0; i < payload.length; i += CHUNK_LIMIT) {
    chunks.push(payload.slice(i, i + CHUNK_LIMIT));
  }
  if (!chunks.length) chunks.push('');
  const lines = chunks.map((chunk) => `${PROJECT_HEADER_PREFIX}${chunk}`);
  lines.push(`${PROJECT_HASH_PREFIX}${projectHash(model)}`);
  return [...lines, '', code].join('\n');
}

/**
 * Разбирает заголовок.
 * @returns {{mode:'project', model:object, hash:string}|{mode:'free', reason:string}}
 */
export function extractProject(code) {
  if (typeof code !== 'string') return { mode: 'free', reason: 'нет кода' };
  const lines = code.split('\n');
  const chunks = [];
  let hash = null;
  for (const line of lines) {
    if (line.startsWith(PROJECT_HEADER_PREFIX)) {
      chunks.push(line.slice(PROJECT_HEADER_PREFIX.length).trim());
    } else if (line.startsWith(PROJECT_HASH_PREFIX)) {
      hash = line.slice(PROJECT_HASH_PREFIX.length).trim();
    }
  }
  if (!chunks.length) {
    return { mode: 'free', reason: 'в коде нет заголовка @project — включён режим «Свободный код»' };
  }
  let json;
  try {
    json = decompressFromEncodedURIComponent(chunks.join(''));
  } catch {
    return { mode: 'free', reason: 'заголовок @project повреждён — включён режим «Свободный код»' };
  }
  if (!json) {
    return { mode: 'free', reason: 'заголовок @project не распаковывается — режим «Свободный код»' };
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { mode: 'free', reason: 'заголовок @project не является JSON — режим «Свободный код»' };
  }
  const result = ProjectModelSchema.safeParse(parsed);
  if (!result.success) {
    return { mode: 'free', reason: `модель из заголовка не проходит валидацию: ${result.error.issues[0]?.message || 'ошибка схемы'}` };
  }
  if (hash && hash !== projectHash(result.data)) {
    return {
      mode: 'free',
      reason: 'хеш @project не совпадает с моделью — включён режим «Свободный код»',
      hashMismatch: true,
    };
  }
  return { mode: 'project', model: result.data, hash: hash || projectHash(result.data) };
}

/** Убирает заголовок из кода — чтобы показывать пользователю чистый код. */
export function stripProjectHeader(code) {
  if (typeof code !== 'string') return '';
  return code
    .split('\n')
    .filter((line) => !line.startsWith(PROJECT_HEADER_PREFIX) && !line.startsWith(PROJECT_HASH_PREFIX))
    .join('\n')
    .replace(/^\n+/, '');
}
