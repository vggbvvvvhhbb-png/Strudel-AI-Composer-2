// Интерфейс: кнопки, лог, поток генерации кода, голос.
import { evaluateCode, stop, reset, unlockAudio } from './strudel-engine.js';
import { generateCode } from './agent.js';
import { startRecording, stopRecording, transcribe, isRecording } from './voice.js';

const $ = (id) => document.getElementById(id);
const state = { busy: false };

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
  const el = $('voice-status');
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

async function runPrompt() {
  const prompt = $('prompt-input').value.trim();
  const codeEl = $('code-input');
  if (!prompt) {
    log('Введите команду или запишите голос', 'error');
    return;
  }
  if (state.busy) return;
  setBusy(true);
  log(`Команда: ${prompt}`, 'info');
  try {
    const code = await generateCode(prompt, codeEl.value, {
      onChunk: (partial) => {
        codeEl.value = partial; // эффект печатания по мере поступления
      },
    });
    log('Код сгенерирован', 'ok');
    log('Исполняю…');
    const result = await evaluateCode(code);
    if (result.ok) log('Играет ✓', 'ok');
    else log(`Ошибка Strudel: ${result.error}`, 'error');
  } catch (err) {
    log(String(err.message || err), 'error');
  } finally {
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
  log('Исполняю код из панели…');
  try {
    const result = await evaluateCode(code);
    if (result.ok) log('Играет ✓', 'ok');
    else log(`Ошибка Strudel: ${result.error}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function toggleVoice() {
  const btn = $('btn-voice');
  if (!isRecording()) {
    try {
      await startRecording();
      btn.classList.add('recording');
      btn.textContent = '⏺ Идёт запись';
      setStatus('Запись… скажите идею и нажмите ещё раз для остановки');
    } catch (err) {
      setStatus(`Микрофон недоступен: ${err.message}`, true);
    }
    return;
  }
  btn.classList.remove('recording');
  btn.textContent = '🎤 Голос';
  try {
    setStatus('Распознаю речь…');
    const blob = await stopRecording();
    const text = await transcribe(blob);
    if (text) {
      $('prompt-input').value = text;
      setStatus(`Распознано: ${text}`);
      log(`Голос распознан: ${text}`, 'ok');
    } else {
      setStatus('Речь не распознана', true);
    }
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
}

export function initUI() {
  $('btn-run').addEventListener('click', runPrompt);
  $('btn-play-code').addEventListener('click', playCode);
  $('btn-stop').addEventListener('click', () => {
    stop();
    log('Стоп — звук остановлен');
  });
  $('btn-clear').addEventListener('click', () => {
    reset();
    $('prompt-input').value = '';
    $('code-input').value = '';
    $('log').replaceChildren();
    setStatus('');
    log('Сброшено: код, лог и звук');
  });
  $('btn-voice').addEventListener('click', toggleVoice);
  $('btn-start-audio').addEventListener('click', async () => {
    const state = await unlockAudio();
    $('audio-gate').hidden = true;
    log(`Звук разблокирован (${state})`);
  });
  window.addEventListener('strudel:ready', () => log('Strudel готов ✓'));
  window.addEventListener('strudel:error', (e) => {
    log(`Ошибка инициализации Strudel: ${e.detail?.message || e.detail}`, 'error');
  });
  log('Введите команду и нажмите «▶ Исполнить» (или настройте ключи в .env)');
}
