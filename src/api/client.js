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

// --- Музыкальный разбор ---

// Список стилей-референсов для панели разбора.
export async function fetchMusicStyles(signal) {
  const data = await jsonOrThrow(await fetch('/api/music/styles', { signal }));
  return data.styles || [];
}

// Разбор кода по референсу стиля: метрики, оценка 0–100, замечания.
export async function analyzeMusic({ code, style, signal }) {
  const res = await fetch('/api/music/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, style }),
    signal,
  });
  return jsonOrThrow(res);
}

// Переписывание кода под замечания разбора: было → стало + список шагов.
export async function refineMusic({ code, style, iterations = 2, signal }) {
  const res = await fetch('/api/music/refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, style, iterations }),
    signal,
  });
  return jsonOrThrow(res);
}

// Несколько вариантов трека с оценкой каждого (best-of-N).
export async function musicVariants({ prompt, count = 3, style, currentCode, signal }) {
  const res = await fetch('/api/music/variants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, count, style, currentCode }),
    signal,
  });
  return jsonOrThrow(res);
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
