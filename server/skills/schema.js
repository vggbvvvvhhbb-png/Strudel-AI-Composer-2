// Схема скил-карты: frontmatter + разобранное тело.
//
// Спека: docs/SKILLS.md, раздел «Формат файла».
// Frontmatter задаётся Zod-схемой SkillFront — она фиксирует формат карты
// и не даёт «тихо протухнуть» карте при редактировании вручную.
//
// Тело разбирается на секции: COMPACT (дистиллят ≤ 400 токенов), RECIPE,
// EXAMPLES, DO / DON'T, MEASURE, EVOLVE. В системный промт попадает только
// COMPACT — остальное живёт как RAG-тело.

import { z } from 'zod';

/** Виды карт. */
export const SKILL_KINDS = ['workflow', 'core', 'groove', 'harmony', 'arrangement', 'mix', 'genre'];

/** Обязательные секции тела карты (docs/SKILLS.md). */
export const REQUIRED_SECTIONS = ['COMPACT', 'RECIPE', 'EXAMPLES', "DO / DON'T", 'MEASURE', 'EVOLVE'];

/** Способы измерения эволюции скила: без метода «стало лучше» не считается. */
export const SCORE_METHODS = ['ab', 'metric', 'spike'];

/**
 * Frontmatter карты. Ровно та схема, что в docs/SKILLS.md.
 */
export const SkillFront = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  kind: z.enum(SKILL_KINDS),
  tags: z.array(z.string()).min(1),
  refs: z.array(z.string()).default([]),          // id других карт
  paramRanges: z.record(z.tuple([z.number(), z.number()])).default({}),
  compact: z.boolean().default(true),
  scoreHistory: z.array(z.object({
    date: z.string(), metric: z.string(),
    before: z.number(), after: z.number(), n: z.number(),
    method: z.enum(SCORE_METHODS),
  })).default([]),
});

/**
 * Полная карта: frontmatter + разобранное тело.
 *
 * `compact` в frontmatter — флаг «у карты есть дистиллят»,
 * `compact` в теле карты — сам текст секции COMPACT.
 * Чтобы не спорить за одно имя, frontmatter хранится отдельным объектом.
 */
export const SkillDocSchema = z.object({
  frontmatter: SkillFront,
  body: z.string(),
  compact: z.string(),
  recipe: z.string(),
  examples: z.array(z.string()),
  sections: z.record(z.string()),
});

/**
 * Человекочитаемый список проблем Zod.
 * @param {import('zod').ZodError} error
 * @returns {string}
 */
export function formatIssues(error) {
  return (error?.issues || [])
    .map((issue) => `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`)
    .join('; ');
}
