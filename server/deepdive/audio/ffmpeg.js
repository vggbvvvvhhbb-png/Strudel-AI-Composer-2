// Приведение произвольного аудиофайла к WAV, который Node умеет мерить сам.
//
// ЗАЧЕМ. Пользователь загружает mp3/ogg/flac, а Node-измерения (громкость,
// полосы, атаки) работают с PCM-сигналом. Конвертировать должен локальный
// ffmpeg — в песочнице, без сети.
//
// БЕЗОПАСНОСТЬ. ffmpeg запускается с ограничениями: без сети, без протоколов,
// с лимитом по времени и по размеру вывода. Файл приходит от пользователя —
// доверять ему нельзя.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_SAMPLE_RATE = 44100;

/** Кандидаты ffmpeg: системный, затем ffmpeg-static из node_modules. */
async function ffmpegCandidates() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  candidates.push('ffmpeg');
  try {
    // ffmpeg-static — dev-зависимость: в собранном образе его может не быть.
    const url = new URL('../../../node_modules/ffmpeg-static/index.js', import.meta.url);
    const mod = await import(url.href).catch(() => null);
    if (mod?.default) candidates.push(mod.default);
  } catch {
    // модуль не установлен — обойдёмся системным ffmpeg
  }
  return candidates.filter(Boolean);
}

/** Ищет рабочий ffmpeg. Возвращает путь или null. */
export async function findFfmpeg() {
  for (const candidate of await ffmpegCandidates()) {
    if (candidate === 'ffmpeg' || existsSync(candidate)) {
      try {
        await execFileAsync(candidate, ['-version'], { timeout: 10000 });
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Конвертирует любой поддерживаемый файл в PCM 16-bit WAV (стерео).
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{timeoutMs?:number, sampleRate?:number}} [options]
 * @returns {Promise<{ok:boolean, sampleRate:number, error?:string}>}
 */
export async function convertToWav(inputPath, outputPath, options = {}) {
  const binary = await findFfmpeg();
  if (!binary) {
    return { ok: false, sampleRate: DEFAULT_SAMPLE_RATE, error: 'ffmpeg недоступен на сервере' };
  }
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    // Без сети: запрещаем всё, что ходит наружу.
    '-protocol_whitelist', 'file,pipe',
    '-i', inputPath,
    '-vn',
    '-ac', '2',
    '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le',
    '-y',
    outputPath,
  ];
  try {
    await execFileAsync(binary, args, {
      timeout: options.timeoutMs ?? 120000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, sampleRate };
  } catch (err) {
    const stderr = String(err?.stderr || err?.message || '').slice(0, 400);
    return { ok: false, sampleRate, error: stderr || 'конвертация не удалась' };
  }
}
