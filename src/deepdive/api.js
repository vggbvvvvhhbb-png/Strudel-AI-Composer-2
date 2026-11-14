// Клиент режима «Разбор»: разбор трека и цикл самоулучшения.
//
// Контракт — docs/DEEPDIVE_API.md: оба эндпойнта отдают SSE-поток
// (`data: {JSON}\n\n`), финальный результат приходит событием `result`.
// Разбор потока — общий с генерацией кода (src/api/stream.js), чтобы парсер
// SSE в проекте был один.
//
// ОБРЫВ ПОТОКА. Разбор на CPU идёт десятки минут, а связь может оборваться:
// прокси, спящий ноутбук, потеря сети. Задача от этого не умирает — она живёт
// на сервере. Поэтому после обрыва клиент опрашивает состояние задачи по GET
// и доводит разбор до результата. Это и есть «можно закрыть вкладку».
import { consumeSSE } from '../api/stream.js';

/** Как часто опрашивать состояние задачи после обрыва потока. */
const POLL_INTERVAL_MS = 5000;

/** Сколько ждать задачу в сумме, прежде чем признать её потерянной. */
const POLL_DEADLINE_MS = 3 * 60 * 60 * 1000;

async function serverError(res) {
  const data = await res.json().catch(() => ({}));
  if (typeof data.error === 'string' && data.error) return data.error;
  return `Сервер ответил кодом ${res.status}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Отменено', 'AbortError'));
    }, { once: true });
  });
}

/**
 * Единый разбор SSE-потока режима «Разбор».
 *
 * Поток всегда заканчивается одним из двух событий: `result` (есть payload)
 * или `error` (есть причина). Если поток закрылся молча — это тоже ошибка,
 * просто без текста: так пользователь узнает, что разбор не состоялся.
 *
 * @param {Response} res ответ с потоком
 * @param {(event: object) => void} onEvent колбэк на каждое событие
 * @param {string} emptyMessage текст, если поток закрылся без результата
 */
async function consumeResultStream(res, onEvent, emptyMessage) {
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
  if (!payload) throw new Error(emptyMessage);
  return payload;
}

/**
 * Состояние задачи по GET. Используется после обрыва потока и при открытии
 * ссылки /razbor/<job-id>.
 */
export async function fetchJob(jobId, { signal } = {}) {
  const res = await fetch(`/api/deepdive/jobs/${encodeURIComponent(jobId)}`, { signal });
  if (res.status === 404) {
    const error = new Error('Задача не найдена: разбор не состоялся или результат удалён по TTL');
    error.code = 'JOB_NOT_FOUND';
    throw error;
  }
  if (!res.ok) throw new Error(await serverError(res));
  return res.json();
}

/**
 * Дождаться задачи, опрашивая состояние по GET.
 *
 * Возвращает результат, когда задача завершилась; бросает ошибку, если задача
 * завершилась ошибкой или пропала.
 */
export async function waitForJob(jobId, { onEvent, signal } = {}) {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
    const data = await fetchJob(jobId, { signal });
    if (data.status === 'done' && data.result) {
      onEvent?.({ type: 'result', payload: data.result });
      return data.result;
    }
    if (data.status === 'error') {
      throw new Error(data.error || 'Разбор не удался');
    }
    onEvent?.({
      type: 'stage',
      stage: 'reconnect',
      label: 'Связь с потоком потеряна — разбор продолжается на сервере',
      progress: data.progress ?? 0,
    });
    if (Date.now() > deadline) {
      throw new Error('Разбор идёт слишком долго, а связаться с сервером не получается');
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
}

/**
 * POST /api/deepdive/analyze — файл → измерения → код-двойник.
 * onEvent получает каждое событие потока (job/stage/passport/result/error).
 */
export async function analyzeTrack({ file, separate = false, model = 'htdemucs', onEvent, signal }) {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('separate', separate ? '1' : '0');
  form.append('model', model);

  const res = await fetch('/api/deepdive/analyze', { method: 'POST', body: form, signal });
  if (!res.ok || !res.body) throw new Error(await serverError(res));

  let jobId = null;
  let payload = null;
  let streamError = null;

  await consumeSSE(res, (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'job') jobId = event.id ?? jobId;
    if (event.type === 'error') {
      streamError = new Error(event.message || 'Разбор прерван');
      return;
    }
    if (event.type === 'result') payload = event.payload ?? payload;
    onEvent?.(event);
  });

  if (streamError) throw streamError;
  if (payload) return payload;

  // Поток закрылся без результата. Задача могла остаться жить на сервере —
  // тогда доводим её до конца через состояние по GET.
  if (jobId) {
    return waitForJob(jobId, { onEvent, signal });
  }
  throw new Error('Сервер закрыл поток без результата разбора');
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

  return consumeResultStream(res, onEvent, 'Сервер закрыл поток без результата улучшения');
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
