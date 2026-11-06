// Интерфейс: промпт, стриминг кода с живой печатью, исполнение, лог.
import { evaluateCode, stop, reset, unlockAudio } from './strudel-engine.js';
import { generateCode, fixCode } from './api/client.js';
import { staticValidate, dryValidate } from './core/validator.js';

const $ = (id) => document.getElementById(id);
const state = { busy: false, generating: false, abort: null };

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
  $('btn-run').textContent = busy ? '⏳ Генерация…' : '▶ Исполнить';
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
async function runValidated(codeRaw, onStatus) {
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
    log('Код сгенерирован', 'ok');
    log('Проверяю и исполняю…');
    const outcome = await runValidated(codeEl.value, (status) => setStatus(status));
    codeEl.value = outcome.code;
    if (outcome.ok) log('Играет ✓', 'ok');
    else log(`Ошибка: ${outcome.error}`, 'error');
  } catch (err) {
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

export function initUI() {
  $('btn-run').addEventListener('click', runPrompt);
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
  log('Введите команду и нажмите «▶ Исполнить»');
}
