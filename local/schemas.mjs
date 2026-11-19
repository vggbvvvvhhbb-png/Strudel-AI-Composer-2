// Схемы payload'ов задач локального демона.
//
// ЗАЧЕМ СТРОГО. Задачу ставит клиент, а демон выполняет её на машине
// владельца: путь к файлу, каталог вывода, параметры рендера. Мягкая проверка
// «поле есть — и ладно» пропускает и опечатки, и лишние поля, которые
// завтра начнут что-то значить. Поэтому: неизвестное поле — отказ.
//
// Схемы живут рядом с tasks.mjs, а не в сервере: демон — единственный, кто
// их исполняет, и он же их проверяет.

import { z } from 'zod';

const PATH = z.string().min(1).max(4096);
const TIMEOUT = z.number().int().min(100).max(3_600_000).optional();
const CYCLE = z.number().int().min(0).max(4096).optional();

export const TASK_SCHEMAS = {
  render: z.object({
    code: z.string().min(1).max(200_000),
    fromCycle: CYCLE,
    toCycle: CYCLE,
    sampleRate: z.number().int().min(8000).max(192000).optional(),
    cps: z.number().min(0.01).max(10).optional(),
    wantWav: z.boolean().optional(),
    wantEvents: z.boolean().optional(),
    poolSamples: z.boolean().optional(),
    outPath: PATH.optional(),
  }).strict(),

  analyze: z.object({
    path: PATH,
    timeoutMs: TIMEOUT,
  }).strict(),

  analyze_reference: z.object({
    sourceTaskId: z.string().min(1).max(128),
  }).strict(),

  separate: z.object({
    path: PATH,
    outDir: PATH.optional(),
    model: z.enum(['htdemucs', 'htdemucs_ft', 'mdx_extra', 'mdx_extra_q']).optional(),
    timeoutMs: TIMEOUT,
  }).strict(),

  analyze_stems: z.object({
    stems: z.record(PATH),
    sections: z.array(z.unknown()).max(64).optional(),
    timeoutMs: TIMEOUT,
  }).strict(),

  passport: z.object({
    path: PATH,
    name: z.string().min(1).max(200).optional(),
    source: z.string().min(1).max(500).optional(),
  }).strict(),
};

/**
 * Тело запроса «поставить задачу».
 *
 * Строго: неизвестное поле верхнего уровня — отказ. Иначе клиент, который
 * пришлёт `{type, payload, unexpected}`, будет думать, что его просьба учтена,
 * а демон её проигнорирует.
 *
 * `id` — необязательный идентификатор задачи от клиента: даёт идемпотентность
 * (повторный запрос с тем же id не ставит работу второй раз). Ограничен по
 * длине и по алфавиту, потому что id попадает в имя файла рендера — тут не
 * должно быть ни «../», ни разделителей пути.
 */
export const TASK_REQUEST_SCHEMA = z.object({
  type: z.string().min(1).max(64),
  payload: z.record(z.unknown()).default({}),
  id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
}).strict();

/**
 * Проверяет payload задачи по её типу.
 * @param {string} type
 * @param {object} payload
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateTaskPayload(type, payload) {
  const schema = TASK_SCHEMAS[type];
  if (!schema) return { ok: false, error: `неизвестный тип задачи: ${type}` };
  const parsed = schema.safeParse(payload ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const field = first?.path?.length ? first.path.join('.') : 'payload';
  return { ok: false, error: `payload задачи ${type}: ${field} — ${first?.message ?? 'неверное значение'}` };
}
