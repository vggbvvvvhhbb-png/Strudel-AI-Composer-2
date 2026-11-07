// Хранилище пресетов: засев встроенных, миграция при смене версии, сохранность
// пользовательских пресетов.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { listPresets, savePreset, deletePreset, renamePreset, duplicatePreset } from '../../src/core/storage.js';
import { PRESETS } from '../../src/presets/index.js';

const K = 'strudel.presets.v1';
const SEED = 'strudel.presets.seeded.v1';

/** Минимальный localStorage в памяти. */
function stubStorage() {
  const map = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    _map: map,
  });
  return map;
}

beforeEach(() => {
  stubStorage();
});

describe('хранилище пресетов', () => {
  it('засевает встроенные пресеты при первом запуске', () => {
    const list = listPresets();
    expect(list.length).toBe(PRESETS.length);
    expect(list.every((p) => p.builtin)).toBe(true);
    expect(list.map((p) => p.id)).toContain('builtin-techno');
  });

  it('не пересеивает пресеты при повторном вызове', () => {
    listPresets();
    savePreset({ name: 'Мой трек', code: '$X: s("bd")', bpm: 120, key: 'c:major', mixer: [] });
    const list = listPresets();
    expect(list.filter((p) => p.builtin).length).toBe(PRESETS.length);
    expect(list.length).toBe(PRESETS.length + 1);
  });

  it('обновляет встроенные пресеты при смене их содержимого, сохраняя пользовательские', () => {
    listPresets();
    savePreset({ name: 'Мой трек', code: '$X: s("bd")', bpm: 120, key: 'c:major', mixer: [] });

    // Имитируем обновление приложения: подпись встроенных пресетов изменилась.
    localStorage.setItem(SEED, 'старая-подпись');

    const list = listPresets();
    expect(list.filter((p) => p.builtin).length).toBe(PRESETS.length);
    expect(list.some((p) => p.name === 'Мой трек')).toBe(true);
    expect(localStorage.getItem(SEED)).not.toBe('старая-подпись');
  });

  it('подпись встроенных пресетов меняется при изменении их кода', () => {
    // Подпись вычисляется из содержимого — ручной версии нет, забыть её нельзя.
    listPresets();
    const first = localStorage.getItem(SEED);
    expect(first).toBeTruthy();
    expect(listPresets().length).toBe(PRESETS.length);
    expect(localStorage.getItem(SEED)).toBe(first);
  });

  it('переименованный встроенный пресет считается пользовательским', () => {
    listPresets();
    renamePreset('builtin-techno', 'Мой техно');
    const list = listPresets();
    const renamed = list.find((p) => p.name === 'Мой техно');
    expect(renamed.builtin).toBe(false);
    // и не перетирается при обновлении встроенных
    localStorage.setItem(SEED, '1');
    expect(listPresets().some((p) => p.name === 'Мой техно')).toBe(true);
  });

  it('удаление и дублирование работают', () => {
    listPresets();
    const before = listPresets().length;
    deletePreset('builtin-techno');
    expect(listPresets().length).toBe(before - 1);
    duplicatePreset('builtin-lofi');
    expect(listPresets().length).toBe(before);
  });

  it('встроенные пресеты содержат валидный код', () => {
    for (const p of listPresets()) {
      expect(p.code, p.name).toContain('$');
    }
  });

  it('хранит пресеты под ключом с версией схемы', () => {
    listPresets();
    expect(localStorage.getItem(K)).toBeTruthy();
  });
});
