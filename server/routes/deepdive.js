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
import { randomUUID } from 'node:crypto';
import { mkdir, rm, readFile, stat, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDeepDive, buildReference, bassNotesFromPlan } from '../deepdive/pipeline.js';
import { buildMidi } from '../deepdive/midi.js';
import { workerHealth } from '../deepdive/analysis/client.js';
import { closeRenderWorker, enqueueRender, getRenderWorker } from '../deepdive/render/pool.js';
import { refineTwin, createWorkerRenderer } from '../deepdive/refine.js';

const router = Router();

const MAX_BYTES = 100 * 1024 * 1024; // 100 МБ — полноценный трек
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000; // неделя (D-084)
const ROOT = path.join(os.tmpdir(), 'strudel-deepdive');

const ALLOWED_MIME = new Set([
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav',
  'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/mp3', 'application/octet-stream',
]);

/** Задачи в памяти. Результат разбора не должен жить вечно. */
const jobs = new Map();

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
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt < JOB_TTL_MS) continue;
    jobs.delete(id);
    if (job.workspaceDir) {
      await rm(job.workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Пишет SSE-событие. */
function sse(res, payload) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

    const job = {
      id: jobId,
      status: 'running',
      progress: 0,
      createdAt: Date.now(),
      workspaceDir,
      inputPath,
      result: null,
      artifacts: null,
    };
    jobs.set(jobId, job);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sse(res, { type: 'stage', stage: 'upload', label: 'Файл получен', progress: 0.02 });

    try {
      const separate = String(req.body?.separate ?? '') === '1';
      const model = String(req.body?.model || 'htdemucs');
      const { result, artifacts } = await runDeepDive({
        workspaceDir,
        inputPath,
        fileName: sanitizeName(req.file.originalname),
        separate,
        model,
        onStage: (event) => {
          job.progress = event.progress ?? job.progress;
          sse(res, { type: 'stage', ...event });
        },
      });
      result.code_twin.render.wav_url = `/api/deepdive/jobs/${jobId}/twin.wav`;
      job.result = result;
      job.artifacts = artifacts;
      job.status = 'done';
      job.progress = 1;
      sse(res, { type: 'result', payload: result });
    } catch (err) {
      job.status = 'error';
      job.error = err?.message || String(err);
      sse(res, {
        type: 'error',
        stage: err?.stage || 'analyze',
        message: err?.message || 'Разбор не удался',
      });
    } finally {
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
  const job = jobs.get(jobId);
  if (!job?.result) {
    res.status(404).json({ error: 'Разбор не найден — сначала разберите трек' });
    return;
  }
  const iterations = Math.max(1, Math.min(5, Number(req.body?.iterations) || 3));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

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
    sse(res, { type: 'result', payload: job.result });
  } catch (err) {
    sse(res, { type: 'error', stage: 'refine', message: err?.message || 'Итерации не удались' });
  } finally {
    res.end();
  }
});

/** Состояние задачи. */
router.get('/api/deepdive/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Задача не найдена' });
    return;
  }
  res.json({
    ok: true,
    id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error ?? null,
  });
});

/** WAV двойника — для A/B-плеера. */
router.get('/api/deepdive/jobs/:id/twin.wav', async (req, res) => {
  const job = jobs.get(req.params.id);
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
router.get('/api/deepdive/jobs/:id/midi', (req, res) => {
  const job = jobs.get(req.params.id);
  const result = job?.result;
  if (!result) {
    res.status(404).json({ error: 'Задача не найдена' });
    return;
  }
  const midi = buildMidi({
    bpm: result.measurements?.tempo?.bpm,
    name: result.track?.file_name,
    drums: result.stem_descriptors?.drums?.onsets,
    bass: result.stem_descriptors?.bass?.pitch,
  });
  res.writeHead(200, {
    'Content-Type': 'audio/midi',
    'Content-Length': midi.length,
    'Content-Disposition': `attachment; filename="deep-dive-twin.mid"`,
  });
  res.end(midi);
});

/** Состояние режима: воркер анализа и рендерер. */
router.get('/api/deepdive/health', async (_req, res) => {
  let worker = { available: false, error: 'не проверен' };
  try {
    worker = await workerHealth();
  } catch (err) {
    worker = { available: false, error: err?.message || String(err) };
  }
  const render = { available: true, note: 'рендерер поднимается при первом разборе' };
  res.json({ ok: Boolean(worker.available), worker, render });
});

// Периодическая уборка. Раз в час — достаточно.
const pruneTimer = setInterval(() => {
  pruneJobs().catch(() => {});
}, 60 * 60 * 1000);
pruneTimer.unref?.();

process.once('SIGTERM', () => closeRenderWorker().catch(() => {}));
process.once('SIGINT', () => closeRenderWorker().catch(() => {}));

export default router;
