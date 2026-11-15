import { z } from 'zod';

import { PART_ID_RE, refinePartIdentity } from './parts.js';

// Schema copied from the document "От статичных циклов..."
// Section: Архитектура Решения №1 → Схема JSON-спецификации

// Партия трека. Ключ записи в `parts.roles` — идентификатор партии
// (`P001`, `VIOLIN_1`), а роль (`kick`, `bass`, `violin`) — атрибут партии:
// у 100 дорожек роли повторяются, а идентичности — нет (D-100).
// Если `role` не указан, роль выводится из ключа — так живёт легаси-форма.
export const PartSchema = z.object({
  role: z.string().optional(),
  activeIn: z.array(z.string()),
  pattern: z.string(),
  sound: z.string(),
  // Сдвиг регистра партии в полутонах. Задаётся экспансией: у оркестра
  // голоса стоят в разных регистрах, и без этого «разделение регистров»
  // в скоре равно нулю (измерено).
  transpose: z.number().int().min(-48).max(48).optional(),
  effects: z.array(z.object({
    name: z.string(),
    params: z.array(z.any())
  })).optional(),
  // Огибающая громкости по шагам сетки: mini-нотация чисел
  // ("0.8 0.5 0.6 ~"). Нужна для двойника: velocity ударов измерена,
  // а параметр effects.gain принимает только одно число.
  gainPattern: z.string().optional(),
  // Свинг сетки: 0 — ровно, 0.5 — прямолинейно, >0.5 — задержка второй
  // доли. Приходит из измерений (drums.onsets.swing).
  swing: z.number().min(0).max(1).optional(),
  // Группы измеренных ударов: сэмпл + шаги сетки + динамика + сдвиг.
  // Это точный способ выразить РИТМ ИЗ ТРЕКА: список шагов через
  // .beat("0,4,8,12",16), динамика через .gain(), микротайминг через
  // .late(ms(x)). Свинг при этом не «параметр», а измеренный сдвиг.
  // Если groups заданы, они важнее pattern.
  groups: z.array(z.object({
    sample: z.string(),
    steps: z.array(z.number().int().min(0).max(63)),
    gain: z.number().min(0).max(2),
    lateMs: z.number().optional()
  })).optional(),
  // Переопределения по секциям: имя секции -> свой рисунок.
  // Нужно двойнику: в разных секциях трека ритм и набор слоёв разные,
  // а part.activeIn ссылается на имя секции, а не на индекс.
  sections: z.record(z.string(), z.object({
    pattern: z.string().optional(),
    sound: z.string().optional(),
    groups: z.array(z.object({
      sample: z.string(),
      steps: z.array(z.number().int().min(0).max(63)),
      gain: z.number().min(0).max(2),
      lateMs: z.number().optional()
    })).optional(),
    gainPattern: z.string().optional()
  })).optional()
});

export const TrackSpecSchema = z.object({
  meta: z.object({
    style: z.enum([
      'lo-fi', 'techno', 'house', 'ambient',
      'dubstep', 'synthwave', 'trap', 'jazz', 'rock', 'cinematic'
    ]),
    bpm: z.number().min(60).max(180),
    key: z.string().regex(/^[A-G][#b]?[a-z]*$/),
    schemaVersion: z.string().regex(/^\d+\.\d+$/).optional()
  }),
  structure: z.object({
    sections: z.array(z.object({
      name: z.enum([
        'intro', 'build', 'drop', 'breakdown',
        'fill', 'outro', 'verse', 'chorus', 'bridge'
      ]),
      cycles: z.number().int().min(1),
      energy: z.number().min(0).max(1),
      harmony: z.string(),
      parameters: z.object({
        cutoff: z.tuple([z.number(), z.number()]).optional(),
        gain: z.tuple([z.number(), z.number()]).optional()
      }).optional()
    }))
  }),
  parts: z.object({
    // Ключ — идентификатор партии, не роль. Идентификатор должен быть
    // пригоден как метка в коде (`$VIOLIN_1:`), поэтому латиница и цифры.
    roles: z.record(
      z.string().regex(PART_ID_RE, 'идентификатор партии: латиница, цифры, подчёркивание'),
      PartSchema
    ).superRefine(refinePartIdentity)
  }),
  reasoning: z.string().optional()
});

export function validateTrackSpec(data) {
  return TrackSpecSchema.parse(data);
}

export function safeValidateTrackSpec(data) {
  const result = TrackSpecSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid track spec: ${result.error.message}`);
  }
  return result.data;
}
