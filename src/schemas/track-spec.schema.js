import { z } from 'zod';

// Schema copied from the document "От статичных циклов..."
// Section: Архитектура Решения №1 → Схема JSON-спецификации
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
    roles: z.record(
      z.enum([
        'kick', 'snare', 'hats', 'perc', 'sub',
        'bass', 'pad', 'chords', 'lead', 'arp', 'fx', 'texture'
      ]),
      z.object({
        activeIn: z.array(z.string()),
        pattern: z.string(),
        sound: z.string(),
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
        swing: z.number().min(0).max(1).optional()
      })
    )
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
