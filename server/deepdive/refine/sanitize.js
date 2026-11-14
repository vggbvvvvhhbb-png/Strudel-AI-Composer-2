// JSON-очистка измерений: модель не должна видеть ни путей, ни файлов,
// ни аудио. Отдельный модуль — чтобы очистку можно было вызывать и из
// сборки payload, и из тестов, не таская за собой весь цикл.

/** Ключи, которые не должны попасть к модели: пути, файлы, аудио. */
export const PRIVATE_KEYS = new Set([
  'path', 'file', 'file_name', 'filename', 'dir', 'temp_dir', 'tmp',
  'url', 'wav', 'wav_url', 'audio', 'audio_path', 'channels', 'samples', 'buffer',
]);

/**
 * JSON-очистка измерений: только числа, строки, булевы, null, массивы и
 * объекты. Никаких путей, никакого аудио, ничего, что нельзя показать модели.
 */
export function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    if (depth > 6) return null;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_KEYS.has(key)) continue;
      out[key] = sanitize(item, depth + 1);
    }
    return out;
  }
  return null;
}
