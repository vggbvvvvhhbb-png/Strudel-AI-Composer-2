// Загрузчик золотого датасета базы знаний (D-136).
// Каждая запись проходит схему (D-135) и сверку пресетов с каталогом;
// музыкальная проверка (парсинг, queryArc, лад) — в tests/unit/rag-dataset.test.js
// и валидаторе фазы F. Загрузчик не пропускает невалидное молча.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEntry, validatePresetRefs } from './schema.js';
import { loadTimbreCatalog } from '../samples/timbre.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DATASET_PATH = resolve(here, 'dataset', 'entries.json');

/**
 * Читает датасет и валидирует каждую запись.
 * @returns {{entries: object[], errors: Array<{id: string, errors: object[]}>}}
 */
export function loadDataset(path = DATASET_PATH, catalog = loadTimbreCatalog()) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('датасет должен быть массивом записей');
  const entries = [];
  const errors = [];
  const seen = new Set();
  for (const item of raw) {
    const id = item?.id ?? '(без id)';
    if (seen.has(id)) {
      errors.push({ id, errors: [{ path: 'id', message: 'дубликат id' }] });
      continue;
    }
    seen.add(id);
    const schema = validateEntry(item);
    if (!schema.ok) {
      errors.push({ id, errors: schema.errors });
      continue;
    }
    const presets = validatePresetRefs(schema.value, catalog);
    if (!presets.ok) {
      errors.push({ id, errors: presets.errors });
      continue;
    }
    entries.push(schema.value);
  }
  return { entries, errors };
}