// Node-клиент к Python-воркеру анализа.
//
// ЗАЧЕМ. Python-воркер (server/deepdive/analysis/worker.py) делает то, чего
// в Node нет: Demucs, темп, лад, секции, питч баса, аккорды. Всё остальное
// (громкость, полосы, атаки, тембр) считается в Node — тем же DSP, что и
// студия. Этот модуль — единственное место, где Node говорит с Python.
//
// ГРАНИЦА ОТВЕТСТВЕННОСТИ. Воркер может прислать поля сверх контракта
// (например, `methods` с описанием способа измерения). Мы их НЕ тащим в
// результат: контракт разбора закрыт (additionalProperties: false), а
// лишние сведения возвращаются отдельно в `versions`/`errors`.

const DEFAULT_BASE_URL = process.env.DD_WORKER_URL || 'http://127.0.0.1:8010';
const DEFAULT_TIMEOUT_MS = Number(process.env.DD_WORKER_TIMEOUT_MS || 120000);
const SEPARATE_TIMEOUT_MS = Number(process.env.DD_SEPARATE_TIMEOUT_MS || 30 * 60 * 1000);

/** Ошибка воркера: понятный текст + стадия, на которой он упал. */
export class WorkerError extends Error {
  constructor(message, { stage = 'worker', detail = null } = {}) {
    super(message);
    this.name = 'WorkerError';
    this.stage = stage;
    this.detail = detail;
  }
}

function workerUrl(pathname, baseUrl = DEFAULT_BASE_URL) {
  return `${baseUrl.replace(/\/+$/, '')}${pathname}`;
}

async function request(pathname, body, { timeoutMs = DEFAULT_TIMEOUT_MS, stage = 'worker', baseUrl } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(workerUrl(pathname, baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new WorkerError(`Сервис анализа не ответил за ${Math.round(timeoutMs / 1000)} с`, { stage });
    }
    throw new WorkerError(`Сервис анализа недоступен: ${err?.message || err}`, { stage });
  }
  clearTimeout(timer);

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new WorkerError('Сервис анализа вернул не-JSON', { stage, detail: text.slice(0, 400) });
  }
  if (!response.ok) {
    throw new WorkerError(payload?.error || `Сервис анализа ответил ${response.status}`, {
      stage,
      detail: payload?.trace || null,
    });
  }
  return payload;
}

/** Состояние воркера: версии библиотек и доступность Demucs. */
export async function workerHealth({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 15000 } = {}) {
  const payload = await request('/health', undefined, { timeoutMs, stage: 'worker', baseUrl });
  return {
    available: true,
    url: baseUrl,
    versions: payload?.versions ?? {},
    models: payload?.models ?? {},
  };
}

/**
 * Базовый анализ файла: темп, лад, громкость, структура.
 * @param {string} path путь к файлу на машине воркера
 */
export async function analyzeFile(path, options = {}) {
  const payload = await request('/analyze', { path }, { ...options, stage: options.stage || 'analyze' });
  return {
    measurements: payload?.measurements ?? {},
    structure: Array.isArray(payload?.structure) ? payload.structure : [],
    methods: payload?.methods ?? {},
  };
}

/**
 * Дескрипторы стемов: активность по секциям, питч баса, аккорды.
 * @param {Record<string,string>} stems имя слоя → путь к файлу
 * @param {Array} sections секции из analyzeFile
 */
export async function analyzeStems(stems, sections, options = {}) {
  const payload = await request('/analyze-stems', { stems, sections }, {
    ...options,
    stage: options.stage || 'stems',
  });
  return {
    stem_descriptors: payload?.stem_descriptors ?? {},
    methods: payload?.methods ?? {},
  };
}

/**
 * Разделение на стемы (Demucs). Долго: на 2 vCPU минута аудио — минуты.
 * @param {string} path путь к исходному файлу
 * @param {string} outDir каталог для результата
 */
export async function separateStems(path, outDir, options = {}) {
  const payload = await request('/separate', {
    path,
    out_dir: outDir,
    model: options.model || 'htdemucs',
  }, {
    ...options,
    timeoutMs: options.timeoutMs ?? SEPARATE_TIMEOUT_MS,
    stage: options.stage || 'separate',
  });
  return {
    stems: payload?.stems ?? {},
    seconds: payload?.seconds ?? null,
    model: payload?.model ?? options.model ?? 'htdemucs',
  };
}
