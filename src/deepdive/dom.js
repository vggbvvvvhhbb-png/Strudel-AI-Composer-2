// Мелкие помощники DOM для панели «Разбор».
//
// Правило модуля: данные с сервера попадают в страницу только через textContent.
// В разбор идут имена файлов, код и подписи слоёв — вставлять их как HTML нельзя.

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function clear(node) {
  if (node) node.replaceChildren();
}

// Отсутствие данных — это «—», а не ноль: ноль в метриках означает «измерено, ноль».
export function num(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return trimZeros(n.toFixed(digits));
}

function trimZeros(text) {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

// Уверенность: 0.87 → «уверенность 87%». Нет данных — нет подписи.
export function conf(value) {
  // null/undefined — это «не измерено», а не 0 % уверенности.
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const percent = n <= 1 ? Math.round(n * 100) : Math.round(n);
  return `уверенность ${percent}%`;
}

export function pct(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${trimZeros((n * 100).toFixed(digits))}%`;
}

// Секунды → «3:04». Неизвестная длительность — «—».
export function fmtTime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '—';
  const total = Math.round(n);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// Скачивание файла из памяти: без сети и без серверного временного хранилища.
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
