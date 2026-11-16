// Маршруты локального пула сэмплов (D-115).
//
//   POST /api/samples/passport  — паспорт звука: скачать превью, измерить,
//                                  зарегистрировать в пуле с лицензией;
//   GET  /api/samples/pool      — что в пуле (паспорта, лицензии, атрибуции);
//   GET  /api/samples/pool/:id/audio — прослушать сэмпл пула до выбора.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МАРШРУТ. «Охотник» ищет звук, потом должен его услышать
// и понять. Паспорт — это перевод звука в числа, по которым композитор
// строит бит вокруг него.
//
// ЛИЦЕНЗИЯ. Запись в пул невозможна без разрешённой лицензии: неразрешённая
// отклоняется на входе, а в записи лежит строка атрибуции.

import { Router } from 'express';
import { z } from 'zod';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildPassport } from '../samples/passport.js';
import { downloadSampleWav } from '../samples/download.js';
import { addToPool, listPool, searchPool, getFromPool, POOL_AUDIO_DIR } from '../samples/pool.js';
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

/**
 * GET /api/samples/pool/:id/audio — WAV сэмпла из пула.
 *
 * Отдаётся только файл, зарегистрированный в пуле и лежащий в каталоге
 * аудио пула: запись в реестре не должна читать произвольные файлы диска.
 */
router.get('/api/samples/pool/:id/audio', (req, res) => {
  const entry = getFromPool(req.params.id);
  if (!entry) {
    res.status(404).json({ error: `сэмпл не найден в пуле: ${req.params.id}` });
    return;
  }
  const file = entry.file ? path.resolve(String(entry.file)) : null;
  const audioDir = path.resolve(POOL_AUDIO_DIR);
  if (!file || !file.startsWith(`${audioDir}${path.sep}`) || !existsSync(file)) {
    res.status(404).json({ error: 'аудио сэмпла недоступно: файл не в каталоге пула или отсутствует' });
    return;
  }
  res.setHeader('content-type', 'audio/wav');
  res.setHeader('content-length', String(statSync(file).size));
  res.setHeader('cache-control', 'no-store');
  createReadStream(file).pipe(res);
});

export default router;
