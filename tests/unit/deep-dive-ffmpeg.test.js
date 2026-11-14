// Конвертация загруженного трека в WAV (ffmpeg) — проверка без сети.
//
// Отдельно проверяется, что поиск ffmpeg не бросает исключение: раньше
// кандидаты собирались асинхронно, но вызывались без await, и разбор падал
// с «ffmpegCandidates is not a function or its return value is not iterable».

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findFfmpeg, convertToWav } from '../../server/deepdive/audio/ffmpeg.js';
import { encodeWav, decodeWav } from '../../src/core/wav.js';

let workspace;
let inputPath;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'deepdive-ffmpeg-'));
  inputPath = path.join(workspace, 'in.wav');
  const mono = new Float64Array(44100);
  for (let i = 0; i < mono.length; i += 1) mono[i] = Math.sin((2 * Math.PI * 220 * i) / 44100) * 0.5;
  await writeFile(inputPath, Buffer.from(encodeWav([mono], 44100)));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('ffmpeg', () => {
  it('поиск бинарника не бросает исключение', async () => {
    const binary = await findFfmpeg();
    expect(binary === null || typeof binary === 'string').toBe(true);
  });

  it('конвертация даёт WAV, который читается нашим декодером', async () => {
    const binary = await findFfmpeg();
    if (!binary) {
      // ffmpeg в среде нет — проверяем честную деградацию: понятная ошибка,
      // а не исключение.
      const result = await convertToWav(inputPath, path.join(workspace, 'out.wav'));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('ffmpeg');
      return;
    }
    const outputPath = path.join(workspace, 'out.wav');
    const result = await convertToWav(inputPath, outputPath);
    expect(result.ok).toBe(true);
    const decoded = decodeWav(await readFile(outputPath));
    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.channels.length).toBe(2); // приводим к стерео
    expect(decoded.frames).toBeGreaterThan(44000);
  });
});
