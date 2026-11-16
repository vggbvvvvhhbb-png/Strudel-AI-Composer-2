// Панель пресетов и истории: сохранить, загрузить, переименовать, дублировать, удалить, импорт/экспорт.
import {
  listPresets, savePreset, deletePreset, duplicatePreset, renamePreset,
  listHistory, clearHistory, exportAll, importAll,
} from './core/storage.js';
import { captureMixer } from './core/code-model.js';
import { transportState } from './transport.js';
import { log } from './ui.js';
import { fetchAttributions } from './timbre/attribution.js';

const $ = (id) => document.getElementById(id);
const hooks = { getCode: () => '', load: () => {} };

export function initHistory({ getCode, load }) {
  hooks.getCode = getCode;
  hooks.load = load;
  $('btn-save-preset').addEventListener('click', onSavePreset);
  $('btn-export').addEventListener('click', onExport);
  $('btn-import-input').addEventListener('change', onImport);
  $('btn-clear-history').addEventListener('click', () => {
    clearHistory();
    renderHistory();
    log('История очищена');
  });
  renderPresets();
  renderHistory();
}

function onSavePreset() {
  const code = hooks.getCode();
  if (!code.trim()) {
    log('Нечего сохранять — сначала сгенерируйте трек', 'error');
    return;
  }
  const name = prompt('Название пресета:', 'Мой трек');
  if (!name) return;
  const { bpm, key } = transportState();
  const ok = savePreset({ name, code, bpm, key, mixer: captureMixer(code) });
  log(ok ? `Пресет «${name}» сохранён` : 'Не удалось сохранить — хранилище переполнено', ok ? 'ok' : 'error');
  renderPresets();
}

async function onExport() {
  // Атрибуция тембров каталога едет вместе с пресетами (D-126):
  // CC-BY ассеты, звучащие в коде пресета, получают строку TASL.
  const payload = JSON.parse(exportAll());
  const presets = payload.presets ?? [];
  const { attributions, degraded } = await fetchAttributions(presets.map((preset) => preset.code ?? ''));
  payload.presets = presets.map((preset, index) => {
    const lines = attributions[index] ?? [];
    return lines.length ? { ...preset, attribution: lines } : preset;
  });
  if (degraded) log('Экспорт: атрибуция тембров недоступна — при публикации проверьте права вручную', 'error');
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'strudel-presets.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function onImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const res = importAll(await file.text());
    if (res.error) {
      log(`Импорт не удался: ${res.error}`, 'error');
    } else {
      log(`Импортировано: пресетов ${res.presets}, записей истории ${res.history}`, 'ok');
      renderPresets();
      renderHistory();
    }
  } finally {
    e.target.value = ''; // тот же файл можно выбрать повторно
  }
}

function rowButton(label, title, onClick, cls = 'chip') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

export function renderPresets() {
  const box = $('preset-list');
  if (!box) return;
  box.replaceChildren();
  const presets = listPresets();
  if (!presets.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Пресетов пока нет — нажмите «Сохранить»';
    box.appendChild(empty);
    return;
  }
  for (const p of presets) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const name = rowButton(p.name, `Загрузить «${p.name}»`, () => {
      hooks.load({ code: p.code, mixer: p.mixer });
      log(`Загружен пресет «${p.name}»`, 'ok');
    }, 'list-name');
    name.style.textAlign = 'left';
    row.appendChild(name);
    row.appendChild(rowButton('✎', 'Переименовать', () => {
      const next = prompt('Новое название:', p.name);
      if (next) { renamePreset(p.id, next); renderPresets(); }
    }));
    row.appendChild(rowButton('⧉', 'Дублировать', () => { duplicatePreset(p.id); renderPresets(); }));
    row.appendChild(rowButton('✕', 'Удалить', () => { deletePreset(p.id); renderPresets(); }));
    box.appendChild(row);
  }
}

export function renderHistory() {
  const box = $('history-list');
  if (!box) return;
  box.replaceChildren();
  const history = listHistory();
  if (!history.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'История пуста — генерации появятся здесь';
    box.appendChild(empty);
    return;
  }
  for (const item of history.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const when = new Date(item.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const name = rowButton(`${when} · ${item.prompt || '(без промпта)'}`, 'Загрузить код из истории', () => {
      hooks.load({ code: item.code, mixer: null });
      log('Код загружен из истории', 'ok');
    }, 'list-name');
    name.style.textAlign = 'left';
    row.appendChild(name);
    box.appendChild(row);
  }
}
