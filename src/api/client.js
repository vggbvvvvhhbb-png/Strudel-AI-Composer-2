import { consumeSSE } from './stream.js';
import { usageHeaders, sessionId } from './usage.js';

async function jsonOrThrow(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchHealth(signal) {
  return jsonOrThrow(await fetch('/api/health', { signal }));
}

// --- Помощник-агент ---

/**
 * Паспорт агента: режимы, инструменты, статус внешних сервисов.
 * @param {AbortSignal} [signal]
 */
export async function fetchAgentTools(signal) {
  return jsonOrThrow(await fetch('/api/agent/tools', { signal }));
}

/**
 * Агентный цикл в SSE. События приходят по одному: plan, tool_start, tool_end,
 * text, usage, done, error — панель рисует шаги отдельно от текста ответа.
 *
 * `currentIr` — план трека из панели IR. Без него режим «Дирижёр» не может
 * править существующий трек: инструменту правки нужен сам план, а не код.
 *
 * @param {{prompt:string, mode?:string, currentCode?:string|null, currentIr?:object|null, onEvent:(event:object)=>void, signal?:AbortSignal}} options
 */
export async function agentStream({ prompt, mode, currentCode = null, currentIr = null, onEvent, signal }) {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ prompt, mode, currentCode, currentIr }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  await consumeSSE(res, onEvent);
}

// Генерация со стримингом. onDelta(text) — каждый чанк; возвращает полный код.
// signal — AbortController-сигнал кнопки «Стоп».
export async function generateCode({ prompt, mode = 'new', currentCode, context, onDelta, signal }) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: usageHeaders(),
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
    headers: usageHeaders(),
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
// audioReport — отчёт о рендере из браузера: он добавляет аудио-блок (20%).
export async function analyzeMusic({ code, style, audioReport, signal }) {
  const res = await fetch('/api/music/analyze', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ code, style, audioReport }),
    signal,
  });
  return jsonOrThrow(res);
}

// Переписывание кода под замечания разбора: было → стало + список шагов.
export async function refineMusic({ code, style, iterations = 2, signal }) {
  const res = await fetch('/api/music/refine', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ code, style, iterations }),
    signal,
  });
  return jsonOrThrow(res);
}

// Несколько вариантов трека с оценкой каждого (best-of-N).
export async function musicVariants({ prompt, count = 3, style, currentCode, signal }) {
  const res = await fetch('/api/music/variants', {
    method: 'POST',
    headers: usageHeaders(),
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
  // У FormData свой Content-Type выставляет браузер — задаём только сессию,
  // чтобы стоимость транскрипции тоже попала в «цену сессии».
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'X-Strudel-Session': sessionId() },
    body: form,
    signal,
  });
  const data = await jsonOrThrow(res);
  return data;
}

// --- Структурная композиция ---

/**
 * Композиция трека с потоком событий пайплайна.
 *
 * События приходят по SSE: spec, compiled, scored, refined, done.
 * onEvent получает каждое событие — по нему интерфейс рисует трейс
 * и таймлайн секций.
 */
export async function composeTrack({ prompt, mode = 'structured', style, seed, refine = true, onEvent, signal }) {
  const res = await fetch('/api/music/compose', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ prompt, mode, style, seed, refine }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  let code = '';
  let score = null;
  let spec = null;
  let sections = [];
  let improved = false;
  let before = null;
  let streamError = null;

  await consumeSSE(res, (event) => {
    if (event.type === 'error') {
      streamError = new Error(event.message || 'Ошибка композиции');
      return;
    }
    if (event.type === 'done') {
      code = event.code ?? code;
      score = event.score ?? score;
      spec = event.spec ?? spec;
      sections = event.sections ?? sections;
    }
    if (event.type === 'refined') {
      improved = Boolean(event.improved);
      before = event.before ?? null;
    }
    onEvent?.(event);
  });

  if (streamError) throw streamError;
  return { code, score, spec, sections, improved, before };
}

// Варианты одной спеки: структурно разные планы (форма, гармония, роли).
export async function composeVariants({ spec, count = 4, seed, signal }) {
  const res = await fetch('/api/music/compose/variants', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ spec, count, seed }),
    signal,
  });
  return jsonOrThrow(res);
}

// Одна детерминированная мутация спеки — кнопка «🎲 ещё вариант».
export async function composeMutate({ spec, mutation, seed, signal }) {
  const res = await fetch('/api/music/compose/mutate', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ spec, mutation, seed }),
    signal,
  });
  return jsonOrThrow(res);
}

/* --- IR-путь: описание → план → код, правки плана, поиск вариантов --- */

// Собрать план по описанию: { prompt } → { ir, code, report }.
export async function irPlan({ prompt, seed, genre, bpm, signal }) {
  const res = await fetch('/api/music/ir/plan', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ prompt, seed, genre, bpm }),
    signal,
  });
  return jsonOrThrow(res);
}

// Правка плана: «сделай мрачнее» и прочие типизированные операции.
export async function irTransform({ ir, transform, amount, role, steps, mode, sectionId, signal }) {
  const res = await fetch('/api/music/ir/transform', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ ir, transform, amount, role, steps, mode, sectionId }),
    signal,
  });
  return jsonOrThrow(res);
}

// Поиск best-of-N по мутациям плана (символьный оракул, без звука).
export async function irSearch({ prompt, ir, n, topK, seed, signal }) {
  const res = await fetch('/api/music/ir/search', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ prompt, ir, n, topK, seed }),
    signal,
  });
  return jsonOrThrow(res);
}

// Критик-цикл: замечания линтера → правки → новый скор, с откатом.
export async function irCritique({ ir, signal }) {
  const res = await fetch('/api/music/ir/critique', {
    method: 'POST',
    headers: usageHeaders(),
    body: JSON.stringify({ ir }),
    signal,
  });
  return jsonOrThrow(res);
}
