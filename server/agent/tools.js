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
import {
  freesoundSearch,
  freesoundBudgetState,
} from './freesound.js';
import { buildPassport } from '../samples/passport.js';
import { downloadSampleWav } from '../samples/download.js';
import { addToPool, searchPool, POOL_AUDIO_DIR } from '../samples/pool.js';
import { readWav } from '../deepdive/pipeline/helpers.js';
import { compileTrackSpec } from '../music/compiler/index.js';
import { buildTrack } from '../music/compose/pipeline.js';
import { usageSummary, recordUsage } from '../stats.js';
import { searchBudgetState } from './budget.js';
import { applyTransform, TRANSFORMS } from '../../src/ir/transforms.js';
import { safeValidateIR } from '../../src/ir/schema.js';
import { symbolicReport } from '../../src/oracle/report.js';
import { specFromPlan } from '../../src/music/expand.js';
import { applyPartEdit, PART_OPS } from '../../src/music/part-edit.js';
import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';
import { schemaShape, zodToJsonSchema } from './json-schema.js';

const LimitSchema = z.number().int().min(1).max(50).default(10);

/**
 * Предел длины описания трека.
 *
 * Раньше здесь стояло 600 символов, а маршрут агента принимает 4000. Модель
 * отдавала в инструмент весь пользовательский запрос — и длинный запрос
 * гарантированно падал с «String must contain at most 600 character(s)».
 * План, построенный по правилам, режет запрос до 400 символов и потому
 * проходил, а план от модели — нет. Теперь предел совпадает с пределом
 * маршрута: обрезать описание трека нельзя, а режет его уже сам сборщик.
 */
const PROMPT_MAX = 4000;

/**
 * Модель часто присылает объект JSON-строкой («{"meta":…}»). Данные при
 * этом валидные, но zod на строке падает с «Expected object, received
 * string». Разбираем строку заранее — тогда ошибка останется честной
 * только для действительно негодного аргумента.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function parseJsonArg(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** План трека (IR): принимается и объектом, и JSON-строкой. */
const IrSchema = z.preprocess(parseJsonArg, z.object({
  meta: z.any(),
  sections: z.any(),
  layers: z.any(),
}).passthrough());

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
      prompt: z.string().min(3).max(PROMPT_MAX),
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
        // Почему спека модели не прошла: без этого агент не может понять,
        // что именно чинить, и просто повторяет тот же запрос.
        errors: result.errors ?? null,
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
    description:
      'Детерминированно превращает спеку в играющий Strudel-код. Спеку берёт из текущей '
      + 'сессии (то, что собрал compose_spec) — передавать её не нужно: модель часто '
      + 'придумывает невалидную спеку, и та ломала бы компиляцию. Один и тот же вход — один и тот же выход.',
    schema: z.object({}),
    async run(args, ctx) {
      const spec = ctx?.currentSpec ?? null;
      if (!spec) {
        return { ok: false, degraded: false, reason: 'нет спеки для компиляции — сначала вызови compose_spec' };
      }
      const code = compileTrackSpec(spec);
      return { ok: true, degraded: false, code, parts: Object.keys(spec?.parts?.roles ?? {}) };
    },
  },
  {
    id: 'expand_plan',
    title: 'Экспансия плана в дорожки',
    description:
      'Детерминированно разворачивает план (форма, гармония, состав групп) в 30-100+ дорожек: '
      + 'у каждой дорожки своя идентичность, свой рисунок и своя громкость. Бюджет полифонии '
      + 'соблюдается: не более N атак на такт на группу. Работает без сети и без ключей.',
    schema: z.object({
      plan: z.object({
        style: z.string().max(40).optional(),
        key: z.string().max(20).optional(),
        bpm: z.number().int().min(60).max(180).optional(),
        sections: z.array(z.object({
          name: z.string().min(1),
          bars: z.number().int().min(1).max(64),
          energy: z.number().min(0).max(1).optional(),
          harmony: z.string().max(80).optional(),
        })).min(1).max(16),
        groups: z.array(z.object({
          group: z.string().min(1).max(30),
          role: z.string().min(1).max(30),
          count: z.number().int().min(1).max(24),
          sound: z.string().max(30).optional(),
          activeIn: z.array(z.string()).optional(),
        })).min(1).max(24),
      }),
      compile: z.boolean().default(true),
    }),
    async run(args) {
      const { spec, report } = specFromPlan(args.plan);
      const checked = TrackSpecSchema.safeParse(spec);
      if (!checked.success) {
        return {
          ok: false,
          degraded: false,
          reason: `план не развернулся в валидную спеку: ${checked.error.issues.slice(0, 3).map((issue) => issue.message).join('; ')}`,
        };
      }
      const code = args.compile ? compileTrackSpec(checked.data) : null;
      return {
        ok: true,
        degraded: false,
        voices: report.voices,
        budgetOk: report.budgetOk,
        attacksPerBar: report.totalAttacksPerBar,
        attackBudget: report.globalBudget,
        groups: report.groups,
        spec: checked.data,
        code,
      };
    },
  },
  {
    id: 'edit_part',
    title: 'Правка одной дорожки',
    description:
      'Меняет ОДНУ дорожку трека по её идентификатору (VIOLIN_3, LEAD_1): тембр, рисунок, '
      + 'громкость, роль, переопределение в секции. Остальные дорожки не трогаются и не '
      + 'перегенерируются. Работает без сети и без ключей.',
    schema: z.object({
      id: z.string().min(1).max(60),
      op: z.enum(Object.keys(PART_OPS)),
      params: z.record(z.any()).default({}),
    }),
    async run(args, ctx) {
      const spec = ctx?.currentSpec ?? null;
      if (!spec) {
        return { ok: false, degraded: false, reason: 'нет спеки для правки — сначала собери трек (compose_spec)' };
      }
      const result = applyPartEdit(spec, { id: args.id, op: args.op, params: args.params });
      if (!result.ok) {
        return { ok: false, degraded: false, reason: result.error };
      }
      const checked = TrackSpecSchema.safeParse(result.spec);
      if (!checked.success) {
        return {
          ok: false,
          degraded: false,
          reason: `после правки спека невалидна: ${checked.error.issues.slice(0, 3).map((issue) => issue.message).join('; ')}`,
        };
      }
      return {
        ok: true,
        degraded: false,
        id: args.id,
        op: args.op,
        changed: result.changed,
        spec: checked.data,
        code: compileTrackSpec(checked.data),
      };
    },
  },
  {
    id: 'edit_ir',
    title: 'Правка трека (типизированные трансформы)',
    description:
      'Меняет одну партию существующего трека без перегенерации остальных: мрачнее, светлее, '
      + 'плотнее, другой тембр, сдвиг октавы, свинг, новая гармония. Возвращает измеренную дельту.',
    schema: z.object({
      ir: IrSchema,
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
      const result = await webSearch(args, {
        env: ctx.env,
        fetchImpl: ctx.fetchImpl,
        budgetState: ctx.budgetState ?? searchBudgetState,
      });
      // Цена поиска измерена провайдером (costDollars.total) — записываем её
      // как измеренную, а не как оценку (D-102). Модель в этом счётчике не
      // участвует: у Exa своя единица — доллары за запрос.
      const cost = Number(result?.costDollars?.total ?? 0);
      if (result?.ok && cost > 0) {
        recordUsage({
          model: 'exa-search',
          provider: 'exa',
          feature: 'web_search',
          tool: 'web_search',
          costUsd: cost,
          estimated: false,
          durationMs: ctx.durationMs ?? 0,
        });
      }
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
      // Текст, который уже пришёл из поиска: тогда страницу не качаем второй раз.
      text: z.string().max(20_000).optional(),
    }),
    async run(args, ctx) {
      const result = await webFetch(args, { env: ctx.env, fetchImpl: ctx.fetchImpl });
      return { ok: result.ok, degraded: Boolean(result.degraded), reason: result.reason ?? null, ...result };
    },
  },
  {
    id: 'freesound_search',
    title: 'Поиск сэмплов в Freesound',
    description:
      'Ищет редкие звуки в Freesound. Берутся только свободные лицензии: CC0 или Attribution '
      + '(нужна атрибуция). Ограничение по длительности есть. Без ключа провайдера инструмент '
      + 'честно сообщает, что поиск недоступен, и агент продолжает по локальной библиотеке.',
    schema: z.object({
      query: z.string().min(2).max(200),
      license: z.enum(['cc0', 'by']).default('cc0'),
      durationMax: z.number().int().min(1).max(300).default(30),
      sort: z.enum(['relevance', 'rating_desc', 'duration_desc', 'duration_asc']).default('relevance'),
      numResults: z.number().int().min(1).max(20).default(5),
    }),
    async run(args, ctx) {
      const result = await freesoundSearch(args, {
        env: ctx.env,
        fetchImpl: ctx.fetchImpl,
        now: ctx.now,
        budgetState: ctx.freesoundBudgetState ?? freesoundBudgetState,
      });
      // Запрос к Freesound тарифицируется по числу обращений: считаем его.
      // Ошибка тоже считается — обращение к провайдеру уже было.
      if (result.ok || result.requestSent) {
        recordUsage({
          model: 'freesound-search',
          provider: 'freesound',
          feature: 'freesound_search',
          tool: 'freesound_search',
          costUsd: 0,
          estimated: false,
          durationMs: ctx.durationMs ?? 0,
        });
      }
      return { ok: result.ok, degraded: Boolean(result.degraded), reason: result.reason ?? null, ...result };
    },
  },
  {
    id: 'sample_passport',
    title: 'Паспорт звука',
    description:
      'Скачивает превью найденного сэмпла, измеряет его (тембр, транзиенты, тон, темп) '
      + 'и кладёт в локальный пул с лицензией и строкой атрибуции. Работает только '
      + 'с разрешёнными лицензиями (CC0/CC-BY).',
    schema: z.object({
      id: z.string().min(1).max(80),
      previewUrl: z.string().url().max(500),
      name: z.string().max(200).optional(),
      author: z.string().max(120).optional(),
      url: z.string().max(500).optional(),
      license: z.string().max(120).optional(),
      licenseId: z.enum(['cc0', 'cc-by']).optional(),
    }),
    async run(args) {
      const download = await downloadSampleWav({
        previewUrl: args.previewUrl,
        outDir: POOL_AUDIO_DIR,
        id: args.id,
      });
      if (!download.ok) {
        return { ok: false, degraded: true, reason: `превью не скачалось: ${download.error}` };
      }
      const audio = await readWav(download.wavPath);
      const passport = buildPassport(audio.channels, audio.sampleRate, {
        name: args.name ?? args.id,
        source: args.url ?? args.previewUrl,
      });
      const added = addToPool({
        id: args.id,
        name: args.name ?? args.id,
        author: args.author ?? null,
        url: args.url ?? null,
        license: args.license ?? null,
        licenseId: args.licenseId ?? null,
        passport,
        file: download.wavPath,
      });
      if (!added.ok) {
        return { ok: false, degraded: false, reason: added.reason };
      }
      return {
        ok: true,
        degraded: false,
        id: args.id,
        passport,
        attribution: added.entry.attribution,
        licenseId: added.entry.licenseId,
      };
    },
  },
  {
    id: 'pool_search',
    title: 'Поиск по локальному пулу',
    description:
      'Ищет по локальному пулу сэмплов: описание звука («стеклянный удар с металлическим '
      + 'хвостом») сопоставляется с измеренными признаками записанных сэмплов.',
    schema: z.object({
      query: z.string().min(2).max(200),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    async run(args) {
      const results = searchPool(args.query, { limit: args.limit });
      return {
        ok: true,
        degraded: false,
        query: args.query,
        found: results.length,
        results: results.map((item) => ({
          id: item.entry.id,
          name: item.entry.name,
          licenseId: item.entry.licenseId,
          attribution: item.entry.attribution,
          score: item.score,
          matched: item.matched,
          character: item.entry.passport?.character ?? null,
          durationS: item.entry.passport?.durationS ?? null,
        })),
      };
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
    const shape = schemaShape(schema);
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
 * Схемы инструментов в формате нативных вызовов (OpenAI-совместимый).
 *
 * Это машинное описание реестра: провайдер получает только те инструменты,
 * которые разрешены режимом, и сам выбирает, что вызвать. Аргументы приходят
 * от API уже объектами — разбирать JSON руками больше не нужно.
 *
 * @param {string[]} [only] ограничить списком режима
 * @returns {Array<{type:'function', function:{name:string, description:string, parameters:object}}>}
 */
export function toolApiSchemas(only = null) {
  return TOOLS
    .filter((tool) => !only || only.includes(tool.id))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.id,
        description: tool.description,
        parameters: zodToJsonSchema(tool.schema),
      },
    }));
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
