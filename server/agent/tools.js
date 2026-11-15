// Реестр инструментов агента.
//
// КАЖДЫЙ ИНСТРУМЕНТ — это: имя, человекочитаемое описание, схема аргументов
// (zod), лимит вызовов и исполнитель. Модель видит только описание и схему;
// вызывается только то, что прошло валидацию.
//
// ПРИНЦИПЫ.
// 1. Инструмент, который не может выполниться, честно это говорит
//    ({ok:false, degraded:true, reason}) — и никогда не притворяется, что
//    сработал. «Нет данных» ≠ 0.
// 2. Инструменты без внешних зависимостей работают всегда: библиотека,
//    композиция, компиляция, правка IR, учёт цены.
// 3. Внешние инструменты (интернет) деградируют, а не падают: без ключа
//    режим отвечает по библиотеке и сам говорит, что интернета нет.
//
// Ограничение вызовов на инструмент живёт в SessionGuard (server/agent/guard.js),
// чтобы лимит был частью сессии, а не настройкой реестра.

import { z } from 'zod';

import { librarySearch } from './library.js';
import { webSearch, webFetch } from './web.js';
import { compileTrackSpec } from '../music/compiler/index.js';
import { buildTrack } from '../music/compose/pipeline.js';
import { usageSummary } from '../stats.js';
import { applyTransform, TRANSFORMS } from '../../src/ir/transforms.js';
import { safeValidateIR } from '../../src/ir/schema.js';
import { symbolicReport } from '../../src/oracle/report.js';

const LimitSchema = z.number().int().min(1).max(50).default(10);

/**
 * @typedef {object} AgentTool
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {import('zod').ZodTypeAny} schema
 * @property {boolean} [slow]
 * @property {boolean} [planned]
 * @property {(args:object, ctx:object)=>Promise<object>} run
 */

/** @type {AgentTool[]} */
export const TOOLS = [
  {
    id: 'library_search',
    title: 'Поиск по библиотеке',
    description:
      'Ищет по нашей локальной библиотеке: сэмплы (с указанием лицензии), банки, знания '
      + '(прогрессии, формы, рецепты, переходы, роли), пресеты студии, карточки навыков. '
      + 'Работает без сети и без ключей.',
    schema: z.object({
      query: z.string().max(200).default(''),
      kind: z.enum(['samples', 'banks', 'knowledge', 'presets', 'skills']).default('samples'),
      limit: LimitSchema,
    }),
    async run(args) {
      return { ok: true, degraded: false, ...librarySearch(args) };
    },
  },
  {
    id: 'compose_spec',
    title: 'Сборка спеки трека',
    description:
      'Собирает спеку трека по описанию: план → спека → компиляция → оценка. Если модель '
      + 'недоступна, спека собирается из библиотеки, и в ответе будет честная отметка об этом.',
    schema: z.object({
      prompt: z.string().min(3).max(600),
      style: z.string().max(40).optional(),
      seed: z.number().int().optional(),
    }),
    async run(args, ctx) {
      const result = await buildTrack({
        prompt: args.prompt,
        style: args.style,
        seed: args.seed ?? 1,
        completeChat: ctx.completeChat,
        signal: ctx.signal,
        onUsage: ctx.onUsage,
      });
      return {
        ok: true,
        degraded: Boolean(result.usedFallback),
        reason: result.usedFallback
          ? 'Модель не ответила или ответила невалидно — спека собрана из библиотеки знаний.'
          : null,
        style: result.style,
        attempts: result.attempts,
        usedFallback: result.usedFallback,
        spec: result.spec,
        code: result.compiled?.code ?? null,
        parts: result.compiled?.parts ?? null,
        sections: result.compiled?.sections ?? null,
      };
    },
  },
  {
    id: 'compile',
    title: 'Компиляция спеки в код',
    description: 'Детерминированно превращает спеку в играющий Strudel-код. Один и тот же вход — один и тот же выход.',
    schema: z.object({
      spec: z
        .object({
          meta: z.object({ style: z.string(), bpm: z.number(), key: z.string() }).passthrough(),
          parts: z.object({ roles: z.record(z.any()) }).passthrough(),
          structure: z.object({ sections: z.array(z.any()) }).passthrough(),
        })
        .passthrough()
        .optional(),
    }),
    async run(args) {
      if (!args.spec) {
        return { ok: false, degraded: false, reason: 'нет спеки для компиляции — сначала вызови compose_spec' };
      }
      const code = compileTrackSpec(args.spec);
      return { ok: true, degraded: false, code, parts: Object.keys(args.spec?.parts?.roles ?? {}) };
    },
  },
  {
    id: 'edit_ir',
    title: 'Правка трека (типизированные трансформы)',
    description:
      'Меняет одну партию существующего трека без перегенерации остальных: мрачнее, светлее, '
      + 'плотнее, другой тембр, сдвиг октавы, свинг, новая гармония. Возвращает измеренную дельту.',
    schema: z.object({
      ir: z.object({ meta: z.any(), sections: z.any(), layers: z.any() }).passthrough(),
      transform: z.enum(Object.keys(TRANSFORMS)),
      role: z.string().optional(),
      amount: z.number().optional(),
      steps: z.number().optional(),
      mode: z.string().optional(),
      sectionId: z.string().optional(),
      rhythm: z.string().optional(),
      template: z.string().optional(),
    }),
    async run(args) {
      const packed = safeValidateIR(args.ir);
      if (!packed.ok) {
        return { ok: false, degraded: false, reason: `план не проходит проверку: ${packed.errors?.join('; ')}` };
      }
      const extra = [];
      for (const key of ['role', 'amount', 'steps', 'mode', 'sectionId', 'rhythm', 'template']) {
        if (args[key] !== undefined) extra.push(args[key]);
      }
      const next = applyTransform(args.ir, args.transform, ...extra);
      const checked = safeValidateIR(next);
      if (!checked.ok) {
        return { ok: false, degraded: false, reason: `после правки план невалиден: ${checked.errors?.join('; ')}` };
      }
      const before = symbolicReport(args.ir);
      const after = symbolicReport(next);
      return {
        ok: true,
        degraded: false,
        transform: args.transform,
        ir: next,
        delta: {
          scoreBefore: before.score.total,
          scoreAfter: after.score.total,
          bpmBefore: before.bpm,
          bpmAfter: after.bpm,
          keyBefore: before.key,
          keyAfter: after.key,
        },
      };
    },
  },
  {
    id: 'usage_report',
    title: 'Отчёт по расходу',
    description: 'Сколько токенов и денег ушло: по сессии, за день, по модели и по фиче.',
    schema: z.object({
      scope: z.enum(['session', 'day', 'all']).default('session'),
    }),
    async run(args) {
      const summary = usageSummary();
      if (args.scope === 'session') {
        return {
          ok: true,
          degraded: false,
          scope: 'session',
          sessions: summary.sessions.slice(0, 5),
          night: summary.night,
          today: summary.today,
        };
      }
      if (args.scope === 'day') {
        return { ok: true, degraded: false, scope: 'day', day: summary.night, today: summary.today };
      }
      return {
        ok: true,
        degraded: false,
        scope: 'all',
        costUsd: summary.costUsd,
        totalTokens: summary.totalTokens,
        byModel: summary.byModel,
        byFeature: summary.byFeature,
        byDay: summary.byDay,
        unpricedModels: summary.unpricedModels,
      };
    },
  },
  {
    id: 'web_search',
    title: 'Поиск в интернете',
    description:
      'Ищет в интернете по текстовому запросу. Без ключа провайдера инструмент честно '
      + 'сообщает, что интернет недоступен, и агент отвечает по локальной библиотеке.',
    schema: z.object({
      query: z.string().min(2).max(300),
      numResults: z.number().int().min(1).max(10).default(5),
      depth: z.enum(['basic', 'deep']).default('basic'),
    }),
    async run(args, ctx) {
      const result = await webSearch(args, { env: ctx.env, fetchImpl: ctx.fetchImpl });
      return { ok: result.ok, degraded: Boolean(result.degraded), reason: result.reason ?? null, ...result };
    },
  },
  {
    id: 'web_fetch',
    title: 'Чтение страницы',
    description:
      'Читает страницу по URL и отдаёт текст. Локальные адреса и метаданные закрыты. '
      + 'Без ключа провайдера инструмент честно сообщает, что интернет недоступен.',
    schema: z.object({
      url: z.string().min(8).max(500),
      maxChars: z.number().int().min(200).max(20_000).default(4000),
    }),
    async run(args, ctx) {
      const result = await webFetch(args, { env: ctx.env, fetchImpl: ctx.fetchImpl });
      return { ok: result.ok, degraded: Boolean(result.degraded), reason: result.reason ?? null, ...result };
    },
  },
  {
    id: 'render_local',
    title: 'Локальный рендер в WAV',
    description: 'Рендерит код трека в WAV на машине пользователя (тот же движок, тот же fingerprint).',
    schema: z.object({
      code: z.string().min(1).max(20_000),
      bars: z.number().int().min(1).max(64).default(16),
      bpm: z.number().int().min(40).max(220).default(120),
    }),
    planned: true,
    async run() {
      return {
        ok: false,
        degraded: true,
        reason:
          'Локальный рендер — это фаза B (пакет local/, D-097). Пока трек рендерит студия в браузере.',
      };
    },
  },
  {
    id: 'deep_dive',
    title: 'Разбор трека',
    description:
      'Глубокий разбор чужого трека: темп, лад, громкость, стемы, оценка по слоям. '
      + 'Занимает 14–27 минут — вызывается только по явному запросу.',
    schema: z.object({
      url: z.string().max(500).optional(),
      file: z.string().max(500).optional(),
    }),
    slow: true,
    async run() {
      return {
        ok: false,
        degraded: true,
        reason:
          'Разбор идёт через существующий контур «Разбор» (14–27 минут со стемами). '
          + 'Вызывайте его из студии явно, а не из агента.',
      };
    },
  },
];

const BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]));

/**
 * @param {string} id
 * @returns {AgentTool|undefined}
 */
export function toolById(id) {
  return BY_ID.get(id);
}

/**
 * Паспорт инструментов для промта и для панели.
 * @param {string[]} [only] ограничить списком режима
 * @returns {Array<object>}
 */
export function toolManifest(only = null) {
  return TOOLS
    .filter((tool) => !only || only.includes(tool.id))
    .map((tool) => ({
      id: tool.id,
      title: tool.title,
      description: tool.description,
      slow: Boolean(tool.slow),
      planned: Boolean(tool.planned),
      args: describeSchema(tool.schema),
    }));
}

/**
 * Человекочитаемое описание аргументов (для промта модели).
 * @param {import('zod').ZodTypeAny} schema
 * @returns {string}
 */
function describeSchema(schema) {
  try {
    const shape = schema?.shape ?? {};
    return Object.entries(shape)
      .map(([key, value]) => {
        const description = value?.description ?? '';
        const optional = value?.isOptional?.() ? ' (необязательный)' : '';
        return `- ${key}: ${value?._def?.typeName ?? 'значение'}${optional}${description ? ` — ${description}` : ''}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Вызов инструмента с валидацией аргументов. Ошибка валидации — это не
 * «инструмент сломался», а «модель ошиблась в аргументах»: возвращаем текст
 * ошибки, чтобы модель могла поправиться.
 *
 * @param {string} id
 * @param {object} args
 * @param {object} ctx
 * @returns {Promise<object>}
 */
export async function runTool(id, args = {}, ctx = {}) {
  const tool = toolById(id);
  if (!tool) {
    return { ok: false, degraded: false, reason: `неизвестный инструмент: ${id}` };
  }
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'аргумент'}: ${issue.message}`);
    return {
      ok: false,
      degraded: false,
      reason: `неверные аргументы (${errors.join('; ')})`,
      expected: tool.args ?? null,
    };
  }
  try {
    return await tool.run(parsed.data, ctx);
  } catch (err) {
    return { ok: false, degraded: false, reason: `инструмент ${id} упал: ${err?.message || err}` };
  }
}
