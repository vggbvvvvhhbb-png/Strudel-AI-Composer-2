// Скачивание превью сэмпла и приведение к WAV (D-115).
//
// ЧТО ЭТО ДЕЛАЕТ. Найденный в Freesound сэмпл нужно измерить, а для этого
// нужен сам звук. Freesound отдаёт превью по прямой ссылке с CDN — она
// публична и не требует OAuth.
//
// БЕЗОПАСНОСТЬ. Скачивается только с разрешённых хостов Freesound, размер
// ограничен, ответ декодируется как аудио, а не как страница. Файл с чужого
// хоста не качается вовсе.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { checkFreesoundUrl } from '../agent/freesound.js';
import { convertToWav } from '../deepdive/audio/ffmpeg.js';

/** Максимальный размер превью: 10 МБ — сэмплы студийного качества столько не весят. */
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

/**
 * Скачивает превью и сохраняет WAV.
 *
 * @param {{previewUrl:string, outDir:string, id:string}} options
 * @returns {Promise<{ok:boolean, wavPath?:string, error?:string, bytes?:number}>}
 */
export async function downloadSampleWav({ previewUrl, outDir, id }) {
  const check = checkFreesoundUrl(previewUrl);
  if (!check.ok) return { ok: false, error: check.reason };

  let res;
  try {
    res = await fetch(check.url, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: 'audio/*' },
    });
  } catch (err) {
    return { ok: false, error: `превью не скачалось: ${err?.message || err}` };
  }
  if (!res.ok) return { ok: false, error: `превью вернуло ${res.status}` };

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_PREVIEW_BYTES) {
    return { ok: false, error: `превью больше ${MAX_PREVIEW_BYTES} байт` };
  }

  await mkdir(outDir, { recursive: true });
  const rawPath = path.join(outDir, `${id}.preview`);
  const wavPath = path.join(outDir, `${id}.wav`);
  await writeFile(rawPath, buffer);

  const conversion = await convertToWav(rawPath, wavPath, { sampleRate: 44100 });
  if (!conversion.ok) {
    return { ok: false, error: conversion.error ?? 'не удалось привести к WAV' };
  }
  return { ok: true, wavPath, bytes: buffer.length };
}
