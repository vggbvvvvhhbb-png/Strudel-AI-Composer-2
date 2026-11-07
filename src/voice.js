// Голосовой ввод: кнопка микрофона → MediaRecorder → /api/transcribe → текст в поле промпта.
// Модуль необязательный: если ключа распознавания нет, кнопка прячется.
// Автоотправки нет — пользователь сам решает, что отправить.
import { transcribeAudio } from './api/client.js';
import { log } from './ui.js';

const $ = (id) => document.getElementById(id);

// MediaRecorder отдаёт разные контейнеры в зависимости от браузера.
// webm/opus — лучший вариант, mp4 — запасной для Safari.
function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mpeg',
  ];
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
}

export function initVoice() {
  const btn = $('btn-voice');
  const target = $('prompt-input');
  if (!btn || !target) return;

  let recorder = null;
  let chunks = [];
  let stream = null;

  const setState = (state) => {
    btn.dataset.state = state;
    btn.disabled = state === 'busy';
    btn.setAttribute('aria-pressed', String(state === 'recording'));
    btn.title = {
      idle: 'Записать голосовое описание',
      recording: 'Остановить запись',
      busy: 'Распознаём…',
    }[state] || 'Голосовой ввод';
    btn.textContent = { idle: '🎤', recording: '⏹', busy: '⏳' }[state] || '🎤';
  };

  const cleanup = () => {
    chunks = [];
    recorder = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      log('Микрофон недоступен в этом браузере', 'error');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      log('Доступ к микрофону не разрешён', 'error');
      return;
    }

    const mimeType = pickMimeType();
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      log('Браузер не поддерживает запись звука', 'error');
      cleanup();
      return;
    }

    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      const type = recorder?.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      cleanup();
      setState('busy');
      try {
        const { text } = await transcribeAudio(blob, type);
        if (!text) {
          log('Не удалось распознать речь', 'error');
          return;
        }
        // Дописываем к текущему промпту, а не затираем его.
        const current = target.value.trim();
        target.value = current ? `${current} ${text}` : text;
        target.focus();
        log('Голос распознан — текст в поле промпта', 'ok');
      } catch (e) {
        log(`Ошибка распознавания: ${e.message}`, 'error');
      } finally {
        setState('idle');
      }
    };

    recorder.start();
    setState('recording');
    log('Запись… говорите, затем нажмите ещё раз');
  };

  const stop = () => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  btn.addEventListener('click', () => {
    if (recorder && recorder.state !== 'inactive') stop();
    else start();
  });

  setState('idle');

  // Кнопка показывается только если сервер подтвердил наличие ключа.
  fetch('/api/health')
    .then((res) => res.json())
    .then((data) => {
      if (data?.features?.voice) {
        btn.hidden = false;
      } else {
        btn.hidden = true;
      }
    })
    .catch(() => {
      btn.hidden = true;
    });
}
