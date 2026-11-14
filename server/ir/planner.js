// LLM-планировщик: описание → Composition IR (спринт S3.2).
//
// Ключевая идея всего проекта в одном файле: LLM не пишет код, он отвечает
// на вопрос «ЧТО играть», а код строит детерминированный компилятор.
//
//   запрос → учебник (скил-карты) → LLM (JSON по схеме) → Zod → IR
//          → при ошибке: ремонтный ретрай с текстом проблемы
//          → если модель недоступна или не выдала валидный IR: правила
//
// Что здесь важно:
//   • учебник собирается из карт, а не из промта: модель получает те же
//     правила, что и человек-композитор (docs/SKILLS.md);
//   • бюджет: не больше maxCalls вызовов на compose (по умолчанию 2 —
//     один основной и один ремонтный);
//   • кэш по (prompt, skillsVersion, seed, схема): повторный запрос не
//     тратит деньги и не меняет результат;
//   • при недоступной модели работает запасной путь planIR — студия не
//     встаёт из-за провайдера.

import { createHash } from 'node:crypto';

import { completeChat } from '../llm/client.js';
import { compileSkills } from '../skills/compile.js';
import { safeValidateIR } from '../../src/ir/schema.js';
import { planIR } from '../../src/ir/intent.js';
import { IR_JSON_SCHEMA, IR_SCHEMA_BRIEF, IR_SCHEMA_VERSION } from './schema-json.js';

/** Бюджет вызовов LLM на один compose. */
export const DEFAULT_MAX_CALLS = 2;

/** Маркер, по которому мок-LLM понимает, что нужен IR, а не TrackSpec. */
export const IR_REQUEST_MARKER = 'COMPOSITION_IR_JSON';

const SYSTEM_RULES = [
  'Ты — планировщик композиции. Твой ответ — ТИПИЗИРОВАННЫЙ ПЛАН (Composition IR), а не код.',
  'Код пишет детерминированный компилятор: любой Strudel-код в ответе — ошибка.',
  'Ответ строго один JSON-объект по схеме ниже. Без пояснений, без markdown, без ```.',
  'Ничего не выдумывай: имя сэмпла берётся только из палитры; если палитра пуста — palette: {}.',
  'Форма важнее сложности: 3–6 секций с разной энергией (контраст соседей ≥ 0.25).',
  'Гармония — римскими цифрами в ладу meta.key.mode; цвет (sus/add9/borrowed/picardy) — по настроению.',
  'Мотив возвращается в разных секциях с вариацией: один motifId, но weight/плотность меняются.',
  'Грув: якоря кика и снейра плотные, перкуссия гуляет; amount — сила отклонения.',
  'Соблюдай бюджет плотности: суммарно не больше 20 событий в секунду.',
].join('\n');

/**
 * Ключ кэша: запрос + версия учебника + зерно + версия схемы.
 * @param {{prompt:string, seed:number, skillsVersion:string, genre?:string|null}} input
 * @returns {string}
 */
export function cacheKey({ prompt, seed, skillsVersion, genre }) {
  return createHash('sha256')
    .update([prompt, seed, skillsVersion, genre ?? '', IR_SCHEMA_VERSION].join('|'), 'utf8')
    .digest('hex');
}

/**
 * Разбирает ответ модели в объект IR.
 * Модель может завернуть JSON в markdown — это нормально, код убирает обёртку.
 * @param {string} text
 * @returns {object|null}
 */
export function parseIrJson(text) {
  if (typeof text !== 'string') return null;
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Текст ошибки для ремонтного ретрая: путь и сообщение Zod, по-русски и кратко.
 * @param {import('zod').ZodError} error
 * @returns {string}
 */
export function repairHint(error) {
  const issues = (error?.issues ?? []).slice(0, 8).map((issue) => {
    const path = issue.path?.join('.') || 'корень';
    return `- ${path}: ${issue.message}`;
  });
  return issues.join('\n') || '- неизвестная ошибка';
}

/**
 * Планирование через LLM.
 *
 * @param {object} input
 * @param {string} input.prompt описание трека
 * @param {number} [input.seed] зерно детерминизма
 * @param {string} [input.genre] жанр принудительно
 * @param {number} [input.bpm] темп принудительно
 * @param {number} [input.maxCalls] бюджет вызовов LLM (по умолчанию 2)
 * @param {AbortSignal} [input.signal]
 * @param {Function} [input.onUsage] колбэк учёта токенов
 * @param {Function} [input.complete] подмена LLM-клиента (тесты)
 * @returns {Promise<{ir:object, source:'llm'|'rules', calls:number, repaired:boolean,
 *   skillsVersion:string, tokens:number, bookTokens:number, issues:string[], reason?:string}>}
 */
export async function planWithLLM(input = {}) {
  const {
    prompt = '', seed = 1, genre = null, bpm = null,
    maxCalls = DEFAULT_MAX_CALLS, signal, onUsage,
    complete = completeChat,
  } = input;

  const book = compileSkills({ prompt, genre });
  const key = cacheKey({ prompt, seed, skillsVersion: book.skillsVersion, genre });

  const cached = plannerCache.get(key);
  if (cached) {
    return { ...cached, cached: true };
  }

  const system = [
    SYSTEM_RULES,
    `seed: ${seed}`,
    'Схема Composition IR (кратко):',
    IR_SCHEMA_BRIEF,
    'Учебник (правила композиции):',
    book.text,
    `${IR_REQUEST_MARKER}`,
  ].join('\n\n');

  const user = [
    `Запрос: ${prompt}`,
    bpm ? `Темп: ${bpm} BPM (обязателен).` : '',
    genre ? `Жанр: ${genre} (обязателен).` : '',
    'Верни JSON с планом трека.',
  ].filter(Boolean).join('\n');

  let calls = 0;
  let repaired = false;
  let lastIssues = [];
  let lastReason = null;

  while (calls < maxCalls) {
    calls += 1;
    let content;
    try {
      content = await complete({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        signal,
        onUsage,
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'composition_ir',
            schema: IR_JSON_SCHEMA,
            strict: false,
          },
        },
      });
    } catch (err) {
      lastReason = `LLM недоступен: ${err?.message || err}`;
      break;
    }

    const parsed = parseIrJson(content);
    if (!parsed) {
      lastIssues = ['ответ не является JSON-объектом'];
      lastReason = 'ответ не является JSON-объектом';
      continue;
    }

    const validation = safeValidateIR(parsed);
    if (validation.ok) {
      const result = {
        ir: validation.data,
        source: 'llm',
        calls,
        repaired,
        skillsVersion: book.skillsVersion,
        tokens: book.tokens,
        bookTokens: book.tokens,
        issues: lastIssues,
        cached: false,
      };
      plannerCache.set(key, result);
      return result;
    }

    lastIssues = validation.error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    lastReason = 'IR не прошёл проверку схемы';
    repaired = true;
  }

  // Запасной путь: правила. Студия работает всегда.
  const fallback = planIR(prompt, { seed, genre: genre || undefined, bpm: bpm || undefined });
  const result = {
    ir: fallback,
    source: 'rules',
    calls,
    repaired,
    skillsVersion: book.skillsVersion,
    tokens: book.tokens,
    bookTokens: book.tokens,
    issues: lastIssues,
    reason: lastReason || 'план LLM не принят',
    cached: false,
  };
  plannerCache.set(key, result);
  return result;
}

/**
 * Кэш планировщика в памяти процесса.
 * Ключ: prompt + seed + skillsVersion + схема. Значение: результат планирования.
 * Ограничение — 200 записей (FIFO), чтобы процесс не разрастался.
 */
const plannerCache = new Map();
const CACHE_LIMIT = 200;

/**
 * Состояние кэша — для /api/skills/stats и тестов.
 * @returns {{size:number, keys:string[]}}
 */
export function plannerCacheStats() {
  return { size: plannerCache.size, keys: [...plannerCache.keys()] };
}

/** Очистка кэша (тесты, смена учебника вручную). */
export function clearPlannerCache() {
  plannerCache.clear();
}
