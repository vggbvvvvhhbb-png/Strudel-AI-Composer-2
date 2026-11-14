// Клиент режима «Разбор»: разбор трека и цикл самоулучшения.
//
// Контракт — docs/DEEPDIVE_API.md: оба эндпойнта отдают SSE-поток
// (`data: {JSON}\n\n`), финальный результат приходит событием `result`.
// Разбор потока — общий с генерацией кода (src/api/stream.js), чтобы парсер
// SSE в проекте был один.
import { consumeSSE } from '../api/stream.js';

async function serverError(res) {
  const data = await res.json().catch(() => ({}));
  if (typeof data.error === 'string' && data.error) return data.error;
  return `Сервер ответил кодом ${res.status}`;
}

/**
 * POST /api/deepdive/analyze — файл → измерения → код-двойник.
 * onEvent получает каждое событие потока (stage/result/error).
 */
export async function analyzeTrack({ file, separate = false, onEvent, signal }) {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('separate', separate ? '1' : '0');

  const res = await fetch('/api/deepdive/analyze', { method: 'POST', body: form, signal });
  if (!res.ok || !res.body) throw new Error(await serverError(res));

  let payload = null;
  let streamError = null;

  await consumeSSE(res, (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'error') {
      streamError = new Error(event.message || 'Разбор прерван');
      return;
    }
    if (event.type === 'result') payload = event.payload ?? payload;
    onEvent?.(event);
  });

  if (streamError) throw streamError;
  if (!payload) throw new Error('Сервер закрыл поток без результата разбора');
  return payload;
}

/**
 * POST /api/deepdive/refine — итерации самоулучшения по метрикам.
 * Формат потока тот же: этапы refine-1…refine-N, затем `result`.
 */
export async function refineTrack({ job, iterations = 3, onEvent, signal }) {
  const res = await fetch('/api/deepdive/refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job, iterations }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await serverError(res));

  let payload = null;
  let streamError = null;

  await consumeSSE(res, (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'error') {
      streamError = new Error(event.message || 'Улучшение прервано');
      return;
    }
    if (event.type === 'result') payload = event.payload ?? payload;
    onEvent?.(event);
  });

  if (streamError) throw streamError;
  if (!payload) throw new Error('Сервер закрыл поток без результата улучшения');
  return payload;
}

/**
 * GET /api/deepdive/jobs/:id/midi — MIDI двойника.
 * Эндпойнт мог быть не развёрнут: 404 превращаем в понятный текст, а не в стектрейс.
 */
export async function downloadMidi(jobId) {
  const res = await fetch(`/api/deepdive/jobs/${encodeURIComponent(jobId)}/midi`);
  if (!res.ok) {
    // Текст сервера полезнее кода: «задача не найдена» и «эндпойнта нет» — разные вещи.
    const detail = await serverError(res);
    if (res.status === 404) throw new Error(`MIDI недоступен: ${detail}`);
    throw new Error(detail);
  }
  const blob = await res.blob();
  return blob;
}
