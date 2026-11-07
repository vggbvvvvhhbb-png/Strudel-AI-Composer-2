import { consumeSSE } from './stream.js';

async function jsonOrThrow(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchHealth(signal) {
  return jsonOrThrow(await fetch('/api/health', { signal }));
}

// Генерация со стримингом. onDelta(text) — каждый чанк; возвращает полный код.
// signal — AbortController-сигнал кнопки «Стоп».
export async function generateCode({ prompt, mode = 'new', currentCode, context, onDelta, signal }) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, mode, currentCode, context }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  let code = '';
  let streamError = null;
  await consumeSSE(res, (event) => {
    if (event.type === 'delta') {
      code += event.text;
      onDelta?.(code);
    } else if (event.type === 'done') {
      code = event.code ?? code;
      onDelta?.(code);
    } else if (event.type === 'error') {
      streamError = new Error(event.message || 'Ошибка генерации');
    }
  });
  if (streamError) throw streamError;
  return code;
}

// Автофикс: {code} на входе с ошибкой → исправленный код.
export async function fixCode({ code, error, signal }) {
  const res = await fetch('/api/fix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, error }),
    signal,
  });
  const data = await jsonOrThrow(res);
  return data.code;
}

// Голос: аудио-блоб → распознанный текст.
export async function transcribeAudio(blob, mimeType = 'audio/webm', signal) {
  const form = new FormData();
  // Имя файла с расширением помогает апстриму определить формат.
  const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  form.append('audio', blob, `recording.${ext}`);
  const res = await fetch('/api/transcribe', { method: 'POST', body: form, signal });
  const data = await jsonOrThrow(res);
  return data;
}
