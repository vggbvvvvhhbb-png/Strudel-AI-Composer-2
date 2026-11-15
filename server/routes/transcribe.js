import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { recordUsage, TRANSCRIPTION_PRICE_PER_HOUR_USD } from '../stats.js';
import { currentUsageContext } from '../llm/context.js';

const router = Router();

const MAX_BYTES = 10 * 1024 * 1024; // 10 МБ — как в требованиях

// Только аудио: расширение приходит от MediaRecorder (webm/ogg/mp4).
const ALLOWED_MIME = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/flac',
  'video/webm', // MediaRecorder в некоторых браузерах отдаёт webm с video-контейнером
]);

const upload = multer({
  storage: multer.memoryStorage(),
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

// Groq Whisper — OpenAI-совместимый эндпоинт транскрипции.
//
// Groq считает не токены, а секунды аудио: whisper-large-v3-turbo стоит
// $0.04 за час. Поэтому просим verbose_json — в нём есть длительность,
// без неё цену посчитать нечем, и мы честно говорим «нет данных».
async function transcribeWithGroq(file) {
  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'audio.webm');
  form.append('model', config.groqTranscribeModel);
  form.append('response_format', 'verbose_json');

  const res = await fetch(`${config.groqBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Groq ${res.status}: ${detail || res.statusText}`);
  }
  const json = await res.json();
  const text = typeof json?.text === 'string' ? json.text.trim() : '';
  const durationSec = Number(json?.duration);
  return { text, durationSec: Number.isFinite(durationSec) ? durationSec : null };
}

/**
 * Записать стоимость транскрипции в учёт.
 * @param {number|null} durationSec длительность аудио в секундах
 */
function recordTranscription(durationSec) {
  const context = currentUsageContext();
  const costUsd = durationSec === null
    ? 0
    : (durationSec / 3600) * TRANSCRIPTION_PRICE_PER_HOUR_USD;
  recordUsage({
    model: config.groqTranscribeModel,
    provider: 'groq',
    feature: 'transcribe',
    promptTokens: 0,
    completionTokens: 0,
    costUsd,
    durationMs: durationSec === null ? 0 : Math.round(durationSec * 1000),
    operationId: context.operationId || null,
    sessionId: context.sessionId || null,
    group: context.group || null,
  });
}

router.post('/api/transcribe', (req, res) => {
  if (!config.groqApiKey) {
    res.status(503).json({ error: 'Голосовой ввод недоступен: не задан GROQ_API_KEY' });
    return;
  }

  upload.single('audio')(req, res, async (err) => {
    if (err) {
      const tooBig = err?.code === 'LIMIT_FILE_SIZE';
      res.status(tooBig ? 413 : 400).json({
        error: tooBig ? 'Запись слишком длинная (максимум 10 МБ)' : err?.message || 'Не удалось принять аудио',
      });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Аудиофайл не получен' });
      return;
    }
    try {
      const { text, durationSec } = await transcribeWithGroq(req.file);
      if (!text) {
        res.status(422).json({ error: 'Не удалось распознать речь' });
        return;
      }
      recordTranscription(durationSec);
      res.json({ text });
    } catch (e) {
      console.error(`[transcribe] ошибка: ${e.message}`);
      res.status(502).json({ error: 'Сервис распознавания речи недоступен' });
    }
  });
});

export default router;
