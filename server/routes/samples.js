// Маршруты локального пула сэмплов (D-115).
//
//   POST /api/samples/passport  — паспорт звука: скачать превью, измерить,
//                                  зарегистрировать в пуле с лицензией;
//   GET  /api/samples/pool      — что в пуле (паспорта, лицензии, атрибуции).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МАРШРУТ. «Охотник» ищет звук, потом должен его услышать
// и понять. Паспорт — это перевод звука в числа, по которым композитор
// строит бит вокруг него.
//
// ЛИЦЕНЗИЯ. Запись в пул невозможна без разрешённой лицензии: неразрешённая
// отклоняется на входе, а в записи лежит строка атрибуции.

import { Router } from 'express';
import { z } from 'zod';

import { buildPassport } from '../samples/passport.js';
import { downloadSampleWav } from '../samples/download.js';
import { addToPool, listPool, searchPool, POOL_AUDIO_DIR } from '../samples/pool.js';
import { readWav } from '../deepdive/pipeline/helpers.js';

const router = Router();

const passportSchema = z.object({
  id: z.string().min(1).max(80),
  previewUrl: z.string().url().max(500),
  name: z.string().max(200).optional(),
  author: z.string().max(120).optional(),
  url: z.string().max(500).optional(),
  license: z.string().max(120).optional(),
  licenseId: z.enum(['cc0', 'cc-by']).optional(),
  /** Не скачивать и не измерять — только зарегистрировать в пуле. */
  measure: z.boolean().default(true),
});

/**
 * POST /api/samples/passport — паспорт звука и регистрация в пуле.
 */
router.post('/api/samples/passport', async (req, res) => {
  const parsed = passportSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректный запрос: нужен id и previewUrl' });
    return;
  }
  const body = parsed.data;

  try {
    let passport = null;
    let file = null;
    if (body.measure) {
      const download = await downloadSampleWav({
        previewUrl: body.previewUrl,
        outDir: POOL_AUDIO_DIR,
        id: body.id,
      });
      if (!download.ok) {
        res.status(502).json({ error: `Паспорт не снят: ${download.error}` });
        return;
      }
      const audio = await readWav(download.wavPath);
      passport = buildPassport(audio.channels, audio.sampleRate, {
        name: body.name ?? body.id,
        source: body.url ?? body.previewUrl,
      });
      file = download.wavPath;
    }

    const added = addToPool({
      id: body.id,
      name: body.name ?? body.id,
      author: body.author ?? null,
      url: body.url ?? null,
      license: body.license ?? null,
      licenseId: body.licenseId ?? null,
      passport,
      file,
    });
    if (!added.ok) {
      res.status(422).json({ error: added.reason });
      return;
    }
    res.json({ ok: true, entry: added.entry, passport });
  } catch (err) {
    res.status(500).json({ error: `Паспорт не снят: ${err?.message || err}` });
  }
});

/**
 * GET /api/samples/pool — содержимое пула; ?q= ищет по описанию.
 */
router.get('/api/samples/pool', (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (query) {
    res.json({ ok: true, query, results: searchPool(query) });
    return;
  }
  res.json({ ok: true, samples: listPool() });
});

export default router;
