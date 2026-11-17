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
import express from 'express';
import { z } from 'zod';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildPassport } from '../samples/passport.js';
import { downloadSampleWav } from '../samples/download.js';
import { addToPool, listPool, searchPool, getFromPool, POOL_AUDIO_DIR } from '../samples/pool.js';
import { readWav } from '../deepdive/pipeline/helpers.js';
import { loadTimbreCatalog, timbreReport, attributionLinesForCode, timbreAudioFile, TIMBRE_DIR } from '../samples/timbre.js';
import { resolveTimbre } from '../samples/timbre-resolver.js';
import { loadRegistry } from '../music/licenses.js';

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

/**
 * GET /api/timbre/catalog — каталог пресетов Timbre Palette (D-126).
 *
 * Публичные метаданные пресетов и статус прав. Грузится лениво по запросу
 * UI, а не в основном чанке. Каталог пуст — честный пустой каталог.
 */
router.get('/api/timbre/catalog', (req, res) => {
  const registry = loadRegistry();
  const bankNames = Object.values(registry.banks ?? {}).flatMap((bank) => bank.names ?? []);
  const catalog = loadTimbreCatalog();
  const report = timbreReport(catalog, { bankNames });
  // Strudel-совместимая карта для samples(map, base): регистрация и прогрев
  // в браузере строятся из неё, а не из самодельных путей (D-126/D-128).
  let sampleMap = { _base: '/timbre-audio/' };
  try {
    sampleMap = JSON.parse(readFileSync(path.join(TIMBRE_DIR, 'strudel-map.json'), 'utf8'));
  } catch {
    // Карты нет — каталог пуст или не импортирован: честная деградация.
  }
  res.json({ ...report, sampleMap });
});

/**
 * GET /api/timbre/resolve — подбор пресета под партию (Resolver v1, D-128).
 * Параметры: role, family, low/high (MIDI-диапазон), profile, style, limit.
 */
router.get('/api/timbre/resolve', (req, res) => {
  const query = {};
  if (req.query.role) query.role = String(req.query.role);
  if (req.query.family) query.family = String(req.query.family);
  if (req.query.profile) query.profile = String(req.query.profile);
  if (req.query.style) query.style = String(req.query.style);
  const low = Number(req.query.low);
  const high = Number(req.query.high);
  if (Number.isFinite(low) && Number.isFinite(high)) query.range = [low, high];
  const limit = Number(req.query.limit);
  if (Number.isFinite(limit)) query.limit = limit;
  res.json({ candidates: resolveTimbre(query) });
});

/**
 * GET /timbre-audio/:alias/:file — OGG пресета, same-origin (D-128).
 *
 * Пропуск — запись в реестре: файл обязан быть зарегистрированным ассетом
 * пресета. Обход пути и незарегистрированные файлы — 404. Отказ загрузки
 * для пресета — ошибка рендера, а не тихая подмена синтезатором.
 */
router.get('/timbre-audio/:alias/:file', (req, res) => {
  const file = timbreAudioFile(req.params.alias, req.params.file);
  if (!file) {
    res.status(404).json({ error: 'файл пресета не найден или не зарегистрирован в каталоге' });
    return;
  }
  res.setHeader('content-type', 'audio/ogg');
  res.setHeader('content-length', String(statSync(file).size));
  res.setHeader('cache-control', 'no-store');
  createReadStream(file).pipe(res);
});

/**
 * POST /api/timbre/attribution — строки атрибуции (TASL) для кода треков.
 *
 * Экспорт и шеринг обязаны нести атрибуцию CC-BY ассетов, которые звучат
 * в коде. Логика одна на сервере и в гейте (server/samples/timbre.js).
 * Тело: {codes: string[]} — до 64 кодов за запрос.
 */
router.post('/api/timbre/attribution', express.json({ limit: '2mb' }), (req, res) => {
  const codes = Array.isArray(req.body?.codes) ? req.body.codes : null;
  if (!codes || codes.length > 64 || codes.some((code) => typeof code !== 'string')) {
    res.status(400).json({ error: 'нужен массив codes (до 64 строк)' });
    return;
  }
  const catalog = loadTimbreCatalog();
  res.json({ attributions: codes.map((code) => attributionLinesForCode(code, catalog)) });
});

export default router;
