// Интерфейс: промпт, стриминг кода с живой печатью, исполнение, лог.
import { evaluateCode, stop, reset, unlockAudio, renderTrackOffline } from './strudel-engine.js';
import { generateCode, fixCode } from './api/client.js';
import { staticValidate, dryValidate } from './core/validator.js';
import { initMixer, syncMixer } from './mixer.js';
import { initTransport, syncTransport } from './transport.js';
import { initImprove } from './improve.js';
import { initMusicPanel, analyzeCurrent } from './music-panel.js';
import { initCompose } from './compose.js';
import { makeShareLink } from './core/share.js';
import { pushHistory } from './core/storage.js';
import { renderHistory } from './history.js';

const $ = (id) => document.getElementById(id);
const state = { busy: false, generating: false, abort: null };
let editor = null;

export function log(message, type = 'info') {
  const box = $('log');
  const entry = document.createElement('div');
  entry.className = `entry ${type}`;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = `[${new Date().toLocaleTimeString('ru-RU')}] `;
  entry.appendChild(time);
  entry.appendChild(document.createTextNode(message));
  box.appendChild(entry);
  box.scrollTop = box.scrollHeight;
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function setBusy(busy) {
  state.busy = busy;
  $('btn-run').disabled = busy;
  $('btn-play-code').disabled = busy;
  $('btn-run').textContent = busy ? '⏳ Генерация…' : '▶ Сгенерировать';
}

// Markdown-обёртки ``` и преамбулу до кода срезаем на лету, пока текст печатается.
function stripMarkdown(text) {
  const first = text.indexOf('```');
  if (first < 0) return text;
  let body = text.slice(first + 3);
  const nl = body.indexOf('\n');
  if (nl >= 0) body = body.slice(nl + 1);
  const second = body.indexOf('```');
  if (second >= 0) body = body.slice(0, second);
  return body;
}

// Проверка → тихий прогон → исполнение. При ошибке — автофикс через /api/fix, максимум 2 попытки.
// Небезопасный код не исполняется и не чинится — сразу блокируется.
export async function runValidated(codeRaw, onStatus) {
  let code = codeRaw;
  for (let step = 0; step < 3; step++) {
    const staticResult = staticValidate(code);
    const check = staticResult.ok ? await dryValidate(code) : staticResult;
    if (!check.ok) {
      if (check.unsafe || step === 2) return { ok: false, error: check.error.message, code };
      onStatus?.(`исправляю (${step + 1}/2)…`);
      try {
        const where = check.error.line ? `строка ${check.error.line}: ` : '';
        code = await fixCode({ code, error: `${where}${check.error.message}` });
      } catch (e) {
        return { ok: false, error: `Автофикс не сработал: ${e.message}`, code };
      }
      continue;
    }
    const res = await evaluateCode(code);
    return res.ok ? { ok: true, code } : { ok: false, error: res.error, code };
  }
  return { ok: false, error: 'Код не прошёл проверку', code };
}

async function runPrompt() {
  const prompt = $('prompt-input').value.trim();
  const codeEl = $('code-input');
  if (!prompt) {
    log('Введите команду', 'error');
    return;
  }
  if (state.busy) return;
  setBusy(true);
  state.generating = true;
  const controller = new AbortController();
  state.abort = controller;
  editor?.setStreaming(true);
  log(`Команда: ${prompt}`);
  try {
    const code = await generateCode({
      prompt,
      mode: 'new',
      currentCode: codeEl.value || undefined,
      onDelta: (partial) => {
        codeEl.value = stripMarkdown(partial); // живая печать по мере прихода SSE
      },
      signal: controller.signal,
    });
    codeEl.value = stripMarkdown(code) || code;
    editor?.setStreaming(false);
    log('Код сгенерирован', 'ok');
    pushHistory({ prompt, code: codeEl.value });
    renderHistory();
    log('Проверяю и исполняю…');
    const outcome = await runValidated(codeEl.value, (status) => setStatus(status));
    codeEl.value = outcome.code;
    if (outcome.ok) log('Играет ✓', 'ok');
    else log(`Ошибка: ${outcome.error}`, 'error');
    // Разбор нового трека — в фоне, интерфейс не блокируем.
    analyzeCurrent().catch(() => {});
  } catch (err) {
    editor?.setStreaming(false);
    if (err?.name === 'AbortError') log('Генерация остановлена');
    else log(String(err.message || err), 'error');
  } finally {
    state.generating = false;
    state.abort = null;
    setBusy(false);
  }
}

async function playCode() {
  const code = $('code-input').value.trim();
  if (!code) {
    log('Панель кода пуста', 'error');
    return;
  }
  if (state.busy) return;
  setBusy(true);
  log('Проверяю и исполняю…');
  try {
    const outcome = await runValidated(code, (status) => setStatus(status));
    $('code-input').value = outcome.code;
    if (outcome.ok) log('Играет ✓', 'ok');
    else log(`Ошибка: ${outcome.error}`, 'error');
  } finally {
    setBusy(false);
  }
}

export function initUI({ editor: editorApi } = {}) {
  const codeEl = $('code-input');
  editor = editorApi || null;

  initMixer({
    getCode: () => codeEl.value,
    setCode: (code) => { codeEl.value = code; },
  });
  initTransport({
    getCode: () => codeEl.value,
    setCode: (code) => { codeEl.value = code; },
  });
  initImprove({
    getCode: () => codeEl.value,
    apply: async (code) => {
      codeEl.value = code;
      log('Правки применены — проверяю и исполняю…');
      setBusy(true);
      try {
        const res = await runValidated(code, (s) => setStatus(s));
        codeEl.value = res.code;
        if (res.ok) log('Играет ✓', 'ok');
        else log(`Ошибка: ${res.error}`, 'error');
      } finally {
        setBusy(false);
      }
    },
  });
  initMusicPanel({
    getCode: () => codeEl.value,
    setCode: (code) => { codeEl.value = code; },
    applyCode: async (code) => {
      codeEl.value = code;
      const res = await runValidated(code, (s) => setStatus(s));
      codeEl.value = res.code;
      if (res.ok) log('Играет ✓', 'ok');
      else log(`Ошибка: ${res.error}`, 'error');
    },
    log,
    // Звуковой разбор: рендер трека в браузере → отчёт о громкости и пике.
    renderAudio: async (code) => {
      const { report } = await renderTrackOffline({ code, bars: [0, 16] });
      return { report };
    },
  });

  // Структурная композиция: спека → код. Тот же путь применения,
  // что и у разбора, — код проверяется и исполняется одинаково.
  initCompose({
    getCode: () => codeEl.value,
    setCode: (code) => { codeEl.value = code; },
    applyCode: async (code) => {
      codeEl.value = code;
      const res = await runValidated(code, (s) => setStatus(s));
      codeEl.value = res.code;
      if (res.ok) log('Играет ✓', 'ok');
      else log(`Ошибка: ${res.error}`, 'error');
      await analyzeCurrent().catch(() => {});
    },
    log,
  });

  // Ручные правки в редакторе синхронизируют микшер и транспорт.
  let syncTimer;
  codeEl.addEventListener('input', () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncMixer(codeEl.value);
      syncTransport(codeEl.value);
    }, 400);
  });

  // Тема: jade (по умолчанию) / obsidian — класс на <html>, запоминается в localStorage.
  const themeBtn = $('theme-toggle');
  const THEMES = [
    { id: 'jade', label: 'Jade' },
    { id: 'obsidian', label: 'Obsidian' },
  ];
  const applyTheme = (id) => {
    const theme = THEMES.find((t) => t.id === id) || THEMES[0];
    document.documentElement.classList.remove('theme-jade', 'theme-obsidian');
    document.documentElement.classList.add(`theme-${theme.id}`);
    document.documentElement.dataset.theme = theme.id;
    if (themeBtn) {
      themeBtn.textContent = `◐ ${theme.label}`;
      themeBtn.title = `Тема: ${theme.label} — переключить`;
    }
  };
  const savedTheme = localStorage.getItem('strudel.theme');
  applyTheme(savedTheme || 'jade');
  themeBtn?.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme === 'obsidian' ? 'jade' : 'obsidian';
    applyTheme(current);
    localStorage.setItem('strudel.theme', current);
  });

  // Горячие клавиши: Space — play/stop, Ctrl+Enter — сгенерировать, Ctrl+S — сохранить пресет.
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key === 'Enter') {
      e.preventDefault();
      runPrompt();
      return;
    }
    if (mod && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      e.preventDefault();
      $('btn-save-preset')?.click();
      return;
    }
    if (e.code === 'Space' && !typing && !mod) {
      e.preventDefault();
      $('btn-play').click();
    }
  });

  $('btn-run').addEventListener('click', runPrompt);

  // Шеринг: код → сжатая ссылка #c=… в буфер обмена.
  $('btn-share').addEventListener('click', async () => {
    const code = codeEl.value;
    if (!code.trim()) {
      log('Нечего шарить — сначала сгенерируйте трек', 'error');
      return;
    }
    const { url, tooLong } = makeShareLink(code);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      prompt('Скопируйте ссылку вручную:', url);
      return;
    }
    log(
      tooLong
        ? `Ссылка скопирована (длинная, ${url.length} симв. — не в каждый чат влезет)`
        : 'Ссылка на трек скопирована',
      'ok',
    );
  });
  $('btn-play-code').addEventListener('click', playCode);
  $('btn-stop').addEventListener('click', () => {
    if (state.generating && state.abort) {
      state.abort.abort();
      log('Генерация остановлена');
    }
    stop();
    log('Стоп — звук остановлен');
  });
  $('btn-clear').addEventListener('click', () => {
    if (state.abort) state.abort.abort();
    reset();
    $('prompt-input').value = '';
    $('code-input').value = '';
    $('log').replaceChildren();
    setStatus('');
    log('Сброшено: код, лог и звук');
  });
  $('btn-start-audio').addEventListener('click', async () => {
    const audioState = await unlockAudio();
    $('audio-gate').hidden = true;
    log(`Звук разблокирован (${audioState})`);
  });
  window.addEventListener('strudel:ready', () => log('Strudel готов ✓'));
  window.addEventListener('strudel:error', (e) => {
    log(`Ошибка инициализации Strudel: ${e.detail?.message || e.detail}`, 'error');
  });
  log('Введите команду и нажмите «▶ Сгенерировать»');
}
