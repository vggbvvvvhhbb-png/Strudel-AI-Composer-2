// Пресеты и история в localStorage. Схемы версионированы, переполнение обрабатывается.
import { PRESETS } from '../presets/index.js';

const K = 'strudel.presets.v1';
const H = 'strudel.history.v1';
const SEED = 'strudel.presets.seeded.v1';
const HISTORY_LIMIT = 50;

// Подпись встроенных пресетов: хеш их кода. Меняется автоматически, когда
// правятся встроенные пресеты, — тогда они обновляются у пользователей,
// а пользовательские (переименованные, сохранённые) остаются нетронутыми.
function builtinSignature() {
  const source = PRESETS.map((p) => `${p.id}:${p.name}:${p.code}`).join('|');
  // FNV-1a, 32 бита — достаточно для отслеживания изменений.
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const available = () => typeof localStorage !== 'undefined';

function read(key, fallback) {
  if (!available()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  if (!available()) return true;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
    if (!quota) return false;
    try {
      // Освобождаем место: история — менее ценная часть.
      localStorage.removeItem(H);
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
}

const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `p${Date.now()}${Math.random().toString(16).slice(2)}`);

export function listPresets() {
  let list = read(K, null);
  const signature = builtinSignature();
  const seeded = read(SEED, '');
  // Встроенные пресеты обновляются при смене их содержимого; пользовательские не трогаем.
  if (!Array.isArray(list) || seeded !== signature) {
    const builtin = PRESETS.map((p) => ({
      ...p,
      id: `builtin-${p.id}`,
      builtin: true,
      createdAt: Date.now(),
    }));
    const user = (Array.isArray(list) ? list : []).filter((p) => p && !p.builtin);
    list = [...user, ...builtin];
    write(K, list);
    write(SEED, signature);
  }
  return Array.isArray(list) ? list : [];
}

// Сохранить/обновить по имени; возвращает true при успехе записи.
export function savePreset({ name, code, bpm, key, mixer, tags = [] }) {
  const list = listPresets();
  const existing = list.find((p) => p.name === name);
  if (existing) {
    Object.assign(existing, { code, bpm, key, mixer, tags });
  } else {
    list.unshift({ id: newId(), name, code, bpm, key, mixer, tags, createdAt: Date.now() });
  }
  return write(K, list);
}

export function deletePreset(id) {
  write(K, listPresets().filter((p) => p.id !== id));
}

export function duplicatePreset(id) {
  const list = listPresets();
  const src = list.find((p) => p.id === id);
  if (!src) return;
  write(K, [{ ...src, id: newId(), name: `${src.name} (копия)`, builtin: false, createdAt: Date.now() }, ...list]);
}

export function renamePreset(id, name) {
  const list = listPresets();
  const p = list.find((x) => x.id === id);
  if (p && name.trim()) {
    p.name = name.trim();
    p.builtin = false;
    write(K, list);
  }
}

export function listHistory() {
  const h = read(H, []);
  return Array.isArray(h) ? h : [];
}

export function pushHistory({ prompt, code }) {
  const h = listHistory();
  h.unshift({ prompt, code, ts: Date.now() });
  write(H, h.slice(0, HISTORY_LIMIT));
}

export function clearHistory() {
  write(H, []);
}

export function exportAll() {
  return JSON.stringify({ version: 1, presets: read(K, []), history: read(H, []) }, null, 2);
}

// Импорт: принимает строку JSON, мержит по id. Возвращает {presets, history, error}.
export function importAll(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'Файл не является корректным JSON' };
  }
  if (!data || !Array.isArray(data.presets)) return { error: 'Нет массива presets' };
  const current = listPresets();
  const byId = new Map(current.map((p) => [p.id, p]));
  let presets = 0;
  for (const p of data.presets) {
    if (!p || typeof p.code !== 'string' || typeof p.name !== 'string') continue;
    byId.set(p.id || newId(), { ...p, id: p.id || newId() });
    presets++;
  }
  write(K, [...byId.values()]);
  let history = 0;
  if (Array.isArray(data.history)) {
    const cur = listHistory();
    const seen = new Set(cur.map((x) => x.ts));
    for (const item of data.history) {
      if (item && typeof item.code === 'string' && !seen.has(item.ts)) {
        cur.push(item);
        seen.add(item.ts);
        history++;
      }
    }
    write(H, cur.sort((a, b) => b.ts - a.ts).slice(0, HISTORY_LIMIT));
  }
  return { presets, history };
}
