// Схема записи базы знаний «Музыкальный интеллект» (D-135).
// Запись = паттерн Strudel + теория («почему это звучит») + метаданные
// для гибридного поиска. Валидация строгая: невалидная запись не может
// попасть в базу (тесты датасета гоняют каждую запись через этот модуль).

import { z } from 'zod';
import { ROLES } from '../../src/schemas/parts.js';

/** Канонические тоники — бемольная запись; диезы нормализуются (normalizeTonic). */
export const TONICS = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];

/** Лады. Имена совпадают с scale() Strudel; harmonic-minor через scale()
 * в @strudel/web 1.3.0 не работает (замер) — сниппеты этого лада пишутся
 * через note() с явными высотами (см. strudelScaleName). */
export const MODES = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonic-minor'];

export const COMPLEXITY = ['basic', 'intermediate', 'advanced'];

const tonicSchema = z.string().trim().toLowerCase().refine((v) => TONICS.includes(v), {
  message: `тоника должна быть одной из: ${TONICS.join(', ')}`,
});

export const musicTagsSchema = z.object({
  genre: z.array(z.string().trim().min(1)).min(1),
  tonic: tonicSchema,
  mode: z.enum(MODES),
  roles: z.array(z.enum(ROLES)).min(1),
  complexity: z.enum(COMPLEXITY),
  // null = темп не применим (свободный паттерн без setCpm), не 0 (D-102).
  bpm: z.number().int().min(40).max(240).nullable(),
});

export const sourceSchema = z.object({
  origin: z.enum(['own', 'library', 'external']),
  license: z.string().trim().min(1),
  reference: z.string().trim().min(1).optional(),
}).refine((s) => s.origin !== 'external' || Boolean(s.reference), {
  message: 'external-источник обязан иметь reference (происхождение фиксируется)',
});

export const knowledgeEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'id — kebab-case'),
  version: z.number().int().min(1),
  title: z.string().trim().min(3).max(120),
  // Эмбеддится (search_document). Должно содержать смысл, а не только имя.
  description: z.string().trim().min(20).max(2000),
  strudel_code: z.string().trim().min(1).max(20000),
  music_tags: musicTagsSchema,
  // Только реальные id каталога Timbre Palette; существование и CC0
  // проверяются отдельно по каталогу (validatePresetRefs), не схемой.
  cc0_preset_ids: z.array(z.string().regex(/^tp-[a-z0-9-]+-v\d+$/)).default([]),
  rationale: z.string().trim().min(20).max(2000),
  source: sourceSchema,
});

/**
 * Валидация записи знания. Возвращает структурные ошибки (путь + текст),
 * пригодные для фидбека модели в петле self-correction.
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validateEntry(entry) {
  const parsed = knowledgeEntrySchema.safeParse(entry);
  if (parsed.success) return { ok: true, errors: [], value: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(корень)', message: i.message })),
  };
}

/**
 * Сверка cc0_preset_ids с реальным каталогом: каждый id существует,
 * и все его ассеты (связь через zones) CC0/approved. Каталог передаётся
 * снаружи в формате загрузчика server/samples/timbre.js
 * ({presets: record, assets: record, zones: array}), чтобы юнит-тесты
 * схемы не зависели от файлов.
 */
export function validatePresetRefs(entry, catalog) {
  const errors = [];
  const presets = catalog.presets || {};
  const assets = catalog.assets || {};
  const zones = catalog.zones || [];
  for (const id of entry.cc0_preset_ids || []) {
    if (!presets[id]) {
      errors.push({ path: 'cc0_preset_ids', message: `пресет «${id}» отсутствует в каталоге` });
      continue;
    }
    const assetIds = zones.filter((z) => z.instrument_id === id).map((z) => z.asset_id);
    if (assetIds.length === 0) {
      errors.push({ path: 'cc0_preset_ids', message: `у пресета «${id}» нет зон/ассетов` });
    }
    for (const assetId of assetIds) {
      const asset = assets[assetId];
      if (!asset || asset.license !== 'CC0-1.0' || asset.rights_status !== 'approved') {
        errors.push({ path: 'cc0_preset_ids', message: `ассет «${assetId}» пресета «${id}» не CC0/approved` });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}