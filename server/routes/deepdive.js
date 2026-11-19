// Маршруты режима «Разбор» (Deep Dive).
//
// КОНТУР. Разбор — дорогая операция (десятки секунд, а с разделением на стемы —
// минуты), поэтому ответ — это поток SSE: пользователь видит этапы, а не «висит».
//
// ПРИВАТНОСТЬ. Загруженный файл живёт во временном каталоге задачи и удаляется
// по TTL. Наружу он не отдаётся; пользователю возвращаются только измерения,
// код двойника и его WAV.
//
// ОТДЕЛЬНО ОТ СТУДИИ. Маршруты живут под /api/deepdive и не трогают
// существующие пути композиции: студия работает как работала.

import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, readFile, stat, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDeepDive, buildReference, bassNotesFromPlan } from '../deepdive/pipeline.js';
import { buildMidi } from '../deepdive/midi.js';
import { workerHealth, separateStems } from '../deepdive/analysis/client.js';
import { closeRenderWorker, enqueueRender, getRenderWorker } from '../deepdive/render/pool.js';
import { refineTwin, createWorkerRenderer } from '../deepdive/refine.js';
import { createJobStore } from '../deepdive/jobs.js';
import { separationQueue } from '../deepdive/queue.js';
import { acquireLock } from '../deepdive/lock.js';
import {
  generateAccessToken,
  isAuthorized,
  readToken,
  permalinkFor,
} from '../deepdive/access.js';
import {
  estimateDeepDive,
  formatEstimate,
  isKnownModel,
  DEFAULT_SEPARATION_MODEL,
} from '../../src/deepdive/estimate.js';

const router = Router();

const MAX_BYTES = 100 * 1024 * 1024; // 100 МБ — полноценный трек
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000; // неделя (D-084)
// Каталог задач. В Docker это общий том с воркером анализа: пути к файлам
// должны совпадать у обоих контейнеров, иначе воркер не увидит загрузку.
const ROOT = process.env.DD_WORKSPACE_DIR || path.join(os.tmpdir(), 'strudel-deepdive');
// Мьютексы. Общий том с хостом: деплой берёт ТОТ ЖЕ лок, поэтому разбор и
// сборка образа не могут идти одновременно (см. deploy/deploy-server.sh).
const LOCK_DIR = process.env.DD_LOCK_DIR || path.join(ROOT, '..', 'locks');

const ALLOWED_MIME = new Set([
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav',
  'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/mp3', 'application/octet-stream',
]);

/**
 * Хранилище задач: в памяти + на диске.
 * Готовый результат лежит в `<ROOT>/<job-id>/job.json`, поэтому доступен по
 * прямой ссылке `/razbor/<job-id>` даже после перезапуска сервера.
 */
const jobStore = createJobStore({ root: ROOT, ttlMs: JOB_TTL_MS });

// Свой бюджет запросов для /api/deepdive (D-088): общий лимит /api в 20
// req/min рассчитан на лёгкие запросы студии, а здесь живёт длинный SSE-поток
// и опрос состояния задачи после обрыва связи.
const deepdiveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много запросов к режиму «Разбор». Подождите минуту.' },
});
router.use('/api/deepdive', deepdiveLimiter);

/**
 * Прямая ссылка на задачу: без аккаунтов, по идентификатору И токену.
 *
 * Токен живёт во фрагменте ссылки — сервер его не видит, клиент достаёт сам
 * и передаёт заголовком (см. server/deepdive/access.js).
 *
 * Режим выдачи ссылок — переменная окружения DEEPDIVE_LINK_MODE:
 *   token (по умолчанию) — ссылка с токеном, вернуться можно по ней;
 *   off                  — ссылка не выдаётся вовсе: разбор виден только
 *                          в той сессии, где он запущен.
 */
const LINK_MODE = process.env.DEEPDIVE_LINK_MODE === 'off' ? 'off' : 'token';

/** Ответ без различения «нет задачи» и «нет доступа». */
function notFound(res) {
  res.status(404).json({ error: 'Разбор не найден или ссылка недействительна' });
}

/**
 * Проверка доступа к задаче.
 *
 * Токен обязателен всегда: без него знание идентификатора (UUID) давало бы
 * доступ к чужому отчёту. Отказ — тоже 404, чтобы по коду ответа нельзя
 * было проверить, существует ли задача.
 *
 * @param {object} req запрос express
 * @param {object} job задача
 * @returns {boolean} true — доступ есть
 */
function accessGranted(req, job) {
  return isAuthorized(job, readToken(req));
}

function sanitizeName(name) {
  const base = path.basename(String(name || 'track')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 80) || 'track';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdir(ROOT, { recursive: true }).then(() => cb(null, ROOT), cb);
    },
    filename: (_req, file, cb) => {
      cb(null, `${randomUUID()}-${sanitizeName(file.originalname)}`);
    },
  }),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const type = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_MIME.has(type)) {
      cb(new Error('Неподдерживаемый формат аудио'));
      return;
    }
    cb(null, true);
  },
});

/** Убирает старые задачи: и из памяти, и с диска. */
async function pruneJobs() {
  await jobStore.prune();
}

/** Пишет SSE-событие. */
function sse(res, payload) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Пинг потока: разбор может молчать десятки минут (Demucs не отдаёт
 * событий), и без пинга соединение рвут — прокси по таймауту, клиент по
 * таймауту тела ответа. SSE-комментарий клиенту не виден, но любой байт
 * сбрасывает таймаут соединения.
 */
const KEEPALIVE_MS = 20_000;

function startKeepalive(res) {
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, KEEPALIVE_MS);
  timer.unref?.();
  return timer;
}

/**
 * Метка «разбор идёт».
 *
 * Файл-маркер в общем с хостом каталоге: деплой перед сборкой образа
 * смотрит, есть ли живые маркеры, и не начинает сборку, пока разбор идёт.
 * Лок защищает тяжёлую часть, а маркер — весь разбор, включая первые
 * секунды анализа, когда лок ещё не взят.
 */
const RUNNING_DIR = path.join(LOCK_DIR, 'running');

async function markRunning(jobId) {
  await mkdir(RUNNING_DIR, { recursive: true });
  await writeFile(path.join(RUNNING_DIR, `${jobId}.job`), String(Date.now()), 'utf8');
}

async function clearRunning(jobId) {
  await rm(path.join(RUNNING_DIR, `${jobId}.job`), { force: true }).catch(() => {});
}

router.post('/api/deepdive/analyze', (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const tooBig = uploadErr?.code === 'LIMIT_FILE_SIZE';
      res.status(tooBig ? 413 : 400).json({
        error: tooBig ? 'Файл слишком большой (максимум 100 МБ)' : uploadErr?.message || 'Не удалось принять файл',
      });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Аудиофайл не получен' });
      return;
    }

    const jobId = randomUUID();
    const workspaceDir = path.join(ROOT, jobId);
    await mkdir(workspaceDir, { recursive: true });
    // Загруженный файл переносим в каталог задачи: там он живёт до TTL.
    const inputPath = path.join(workspaceDir, `input-${sanitizeName(req.file.originalname)}`);
    try {
      await rename(req.file.path, inputPath);
    } catch {
      // Файл мог оказаться на другом томе — тогда копируем содержимое.
      const buffer = await readFile(req.file.path);
      await writeFile(inputPath, buffer);
    }

    const separate = String(req.body?.separate ?? '') === '1';
    const requestedModel = String(req.body?.model || DEFAULT_SEPARATION_MODEL);
    const model = isKnownModel(requestedModel) ? requestedModel : DEFAULT_SEPARATION_MODEL;

    const accessToken = generateAccessToken();
    const job = jobStore.create({
      id: jobId,
      status: 'running',
      progress: 0,
      createdAt: Date.now(),
      fileName: sanitizeName(req.file.originalname),
      model,
      separate,
      workspaceDir,
      inputPath,
      accessToken,
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sse(res, { type: 'stage', stage: 'upload', label: 'Файл получен', progress: 0.02 });
    // Идентификатор и ссылка приходят сразу: по ним можно вернуться к
    // разбору позже, даже если вкладку закрыть.
    sse(res, {
      type: 'job',
      id: jobId,
      permalink: LINK_MODE === 'off' ? null : permalinkFor(jobId, accessToken),
      // Токен уходит в поток один раз: клиент хранит его в памяти и
      // передаёт серверу заголовком. В ссылке он живёт во фрагменте.
      accessToken,
      separate,
      model,
    });

    const keepalive = startKeepalive(res);

    // Оценка времени: длительность трека известна только после анализа, но
    // браузер считает свою по файлу. Серверная оценка приходит с паспортом.
    let estimate = null;

    // Мьютекс задачи. Берём его сразу, но НЕ ждём перед анализом: паспорт
    // должен прийти за секунды даже если мьютекс занят. Ждём его только перед
    // разделением на стемы — до этого момента тяжёлой работы нет.
    const lockPromise = separate
      ? acquireLock(LOCK_DIR, {
        name: 'job',
        label: `разбор ${jobId.slice(0, 8)}`,
        timeoutMs: 3 * 60 * 60 * 1000,
        onWait: (info) => {
          sse(res, {
            type: 'stage',
            stage: 'queue',
            label: `Ждём мьютекс: занято (${info.owner})`,
            progress: 0.05,
          });
        },
      }).then((handle) => ({ handle })).catch((err) => ({ error: err }))
      : Promise.resolve({ handle: null });

    await markRunning(jobId);

    /**
     * Разделение на стемы — тяжёлая операция. Она идёт через очередь
     * (одна за раз) и под мьютексом (деплой не может встать на середине).
     */
    const queuedSeparation = async (originalWav, stemsDir, options) => separationQueue.run(
      async () => {
        const lock = await lockPromise;
        if (lock?.error) throw lock.error;
        try {
          sse(res, {
            type: 'stage', stage: 'separate', label: 'Разделение на стемы', progress: 0.3,
            ...(estimate ? { eta: { seconds: estimate.secondsMax, label: formatEstimate(estimate) } } : {}),
          });
          const separation = await separateStems(originalWav, stemsDir, {
            model: options?.model || model,
            stage: 'separate',
          });
          return separation;
        } finally {
          await lock?.handle?.release?.();
        }
      },
      {
        onQueued: (info) => {
          if (info.started) return;
          sse(res, {
            type: 'stage',
            stage: 'queue',
            label: `В очереди на разделение (позиция ${info.position}) — тяжёлая операция идёт по одной`,
            progress: 0.3,
          });
        },
      },
    );

    try {
      const { result, artifacts } = await runDeepDive({
        workspaceDir,
        inputPath,
        fileName: sanitizeName(req.file.originalname),
        separate,
        model,
        deps: { separate: queuedSeparation },
        onStage: (event) => {
          job.progress = event.progress ?? job.progress;
          const payload = { type: 'stage', ...event };
          sse(res, payload);
        },
        onPassport: (passport) => {
          // Паспорт — измерения, а не обещание качества. Отдаём сразу,
          // не дожидаясь стемов.
          estimate = estimateDeepDive({ durationS: passport.durationS, separate, model });
          sse(res, {
            type: 'passport',
            payload: {
              measurements: passport.measurements,
              structure: passport.sections,
              track: passport.track,
            },
            estimate: {
              minutesMin: estimate.minutesMin,
              minutesMax: estimate.minutesMax,
              label: formatEstimate(estimate),
              basis: estimate.basis,
              separate: estimate.separate,
            },
          });
        },
      });
      result.code_twin.render.wav_url = `/api/deepdive/jobs/${jobId}/twin.wav`;
      job.result = result;
      job.artifacts = artifacts;
      job.status = 'done';
      job.progress = 1;
      job.finishedAt = Date.now();
      // Результат уходит на диск: с этого момента он доступен по прямой
      // ссылке /razbor/<job-id>, даже если вкладку закрыть или сервер перезапустить.
      await jobStore.save(job);
      sse(res, { type: 'result', payload: result, permalink: LINK_MODE === 'off' ? null : permalinkFor(jobId, accessToken) });
    } catch (err) {
      job.status = 'error';
      job.error = err?.message || String(err);
      job.finishedAt = Date.now();
      await jobStore.save(job);
      sse(res, {
        type: 'error',
        stage: err?.stage || 'analyze',
        message: err?.message || 'Разбор не удался',
      });
    } finally {
      clearInterval(keepalive);
      await clearRunning(jobId);
      const lock = await lockPromise;
      await lock?.handle?.release?.();
      res.end();
    }
  });
});

/**
 * Цикл самоулучшения: LLM правит план по метрикам, код пересобирается,
 * рендерится и сравнивается заново. Baseline (итерация 0) не меняется.
 */
router.post('/api/deepdive/refine', async (req, res) => {
  const jobId = String(req.body?.job || '');
  const job = await jobStore.get(jobId);
  if (!job?.result || !accessGranted(req, job)) {
    notFound(res);
    return;
  }
  const iterations = Math.max(1, Math.min(5, Number(req.body?.iterations) || 3));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const keepalive = startKeepalive(res);

  try {
    // Оригинал для сравнения читаем с диска — те же файлы, что и в разборе.
    const reference = await buildReference({
      originalWavPath: job.artifacts?.originalWavPath,
      stemPaths: job.artifacts?.stemPaths,
    });

    // Рендеры строго последовательные: движок переключает глобальный аудиоконтекст.
    const worker = await getRenderWorker();
    const queuedWorker = { render: (args) => enqueueRender(() => worker.render(args)) };
    const totalBars = job.artifacts?.totalBars ?? 16;
    const bpm = Number(job.result.code_twin.plan?.meta?.bpm) || 120;
    const renderCandidate = createWorkerRenderer(queuedWorker, {
      fromCycle: 0,
      toCycle: totalBars,
      cps: bpm / 240,
    });

    const outcome = await refineTwin({
      plan: job.result.code_twin.plan,
      code: job.result.code_twin.code,
      metrics: job.result.code_twin.metrics?.[0] ?? null,
      measurements: job.result.measurements,
      stem_descriptors: job.result.stem_descriptors,
      options: {
        render: renderCandidate,
        reference,
        referenceBassNotes: job.result.stem_descriptors?.bass?.pitch?.notes ?? null,
        referenceSwing: job.result.stem_descriptors?.drums?.onsets?.swing ?? null,
        candidateBassNotes: (plan) => bassNotesFromPlan(plan),
        iterations,
        onIteration: (entry) => sse(res, {
          type: 'stage',
          stage: `refine-${entry.iteration}`,
          label: entry.status === 'ok'
            ? `Итерация ${entry.iteration}: ${entry.changes?.join('; ') || 'без изменений'}`
            : `Итерация ${entry.iteration}: ${entry.error || 'без изменений'}`,
          progress: Math.min(0.95, 0.1 + 0.8 * (entry.iteration / iterations)),
          detail: entry.delta ? `общая оценка ${entry.delta.overall > 0 ? '+' : ''}${entry.delta.overall}` : undefined,
        }),
      },
    });
    job.result.code_twin.iterations = outcome?.iterations ?? [];
    if (outcome?.best?.code) job.result.code_twin.code = outcome.best.code;
    job.result.code_twin.refine_log = outcome?.log ?? [];
    job.result.code_twin.stop_reason = outcome?.stopReason ?? null;
    // Улучшенный результат тоже уходит на диск: по ссылке должен открыться
    // именно он, а не версия до итераций.
    await jobStore.save(job);
    sse(res, { type: 'result', payload: job.result });
  } catch (err) {
    sse(res, { type: 'error', stage: 'refine', message: err?.message || 'Итерации не удались' });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

/**
 * Состояние задачи.
 *
 * Отвечает и по памяти, и по диску: готовый разбор доступен по прямой
 * ссылке даже после перезапуска сервера. Именно этот эндпойнт клиент
 * опрашивает после обрыва SSE-потока.
 */
router.get('/api/deepdive/jobs/:id', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job || !accessGranted(req, job)) {
    notFound(res);
    return;
  }
  res.json({
    ok: true,
    id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result ?? null,
    error: job.error ?? null,
    permalink: LINK_MODE === 'off' ? null : permalinkFor(job.id, job.accessToken),
    fromDisk: Boolean(job.fromDisk),
  });
});

/** WAV двойника — для A/B-плеера. */
router.get('/api/deepdive/jobs/:id/twin.wav', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job || !accessGranted(req, job)) {
    notFound(res);
    return;
  }
  const file = job?.artifacts?.twinWavPath;
  if (!file || !existsSync(file)) {
    res.status(404).json({ error: 'Рендер двойника недоступен' });
    return;
  }
  const info = await stat(file);
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
  });
  const buffer = await readFile(file);
  res.end(buffer);
});

/** MIDI двойника: ударные и бас. */
router.get('/api/deepdive/jobs/:id/midi', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job || !accessGranted(req, job)) {
    notFound(res);
    return;
  }
  const result = job?.result;
  if (!result) {
    res.status(404).json({ error: 'Отчёт ещё не готов' });
    return;
  }
  const midi = buildMidi({
    bpm: result.measurements?.tempo?.bpm,
    name: result.track?.file_name,
    // Ударные: измеренный стем, а если разделения не было — ритм из микса,
    // по которому построен двойник. Бас — только измеренный питч-трек.
    drums: result.stem_descriptors?.drums?.onsets ?? job.artifacts?.rhythm?.onsets ?? null,
    bass: result.stem_descriptors?.bass?.pitch,
  });
  res.writeHead(200, {
    'Content-Type': 'audio/midi',
    'Content-Length': midi.length,
    'Content-Disposition': `attachment; filename="deep-dive-twin.mid"`,
  });
  res.end(midi);
});

/** Состояние режима: воркер анализа, рендерер и очередь тяжёлых операций. */
router.get('/api/deepdive/health', async (_req, res) => {
  let worker = { available: false, error: 'не проверен' };
  try {
    worker = await workerHealth();
  } catch (err) {
    worker = { available: false, error: err?.message || String(err) };
  }
  const render = { available: true, note: 'рендерер поднимается при первом разборе' };
  res.json({
    ok: Boolean(worker.available),
    worker,
    render,
    queue: separationQueue.stats(),
    jobs: { inMemory: jobStore.size() },
  });
});

// Периодическая уборка. Раз в час — достаточно.
const pruneTimer = setInterval(() => {
  pruneJobs().catch(() => {});
}, 60 * 60 * 1000);
pruneTimer.unref?.();

process.once('SIGTERM', () => closeRenderWorker().catch(() => {}));
process.once('SIGINT', () => closeRenderWorker().catch(() => {}));

export default router;
