// Экспорт/импорт трека ссылкой: код → lz-string → base64url → #c=…
import LZString from 'lz-string';
import { staticValidate } from './validator.js';

export function makeShareLink(code) {
  const payload = LZString.compressToEncodedURIComponent(code);
  const url = `${location.origin}${location.pathname}#c=${payload}`;
  return { url, tooLong: url.length > 8192 };
}

// Достать код из текущего адреса (#c=…). null — ссылки нет или код невалиден.
export function codeFromHash() {
  const m = location.hash.match(/^#c=(.+)$/);
  if (!m) return null;
  let code;
  try {
    code = LZString.decompressFromEncodedURIComponent(m[1]);
  } catch {
    return null;
  }
  if (!code || !staticValidate(code).ok) return null;
  return code;
}
