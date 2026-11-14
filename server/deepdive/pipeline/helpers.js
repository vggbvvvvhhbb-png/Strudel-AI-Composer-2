// Общие утилиты пайплайна разбора.
//
// Здесь только то, что не принадлежит ни одному конкретному этапу: чтение
// WAV, обрезка сигнала до общей длины, округление чисел для контракта и
// перевод плана двойника в ноты баса.

import { readFile } from 'node:fs/promises';

import { decodeWav } from '../../../src/core/wav.js';
import { noteNameToMidi } from '../transpiler.js';

/** Округление для контракта: нечисло превращается в null, а не в ноль. */
export function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Читает WAV и отдаёт каналы в формате, который ждёт DSP. */
export async function readWav(filePath) {
  const buffer = await readFile(filePath);
  const decoded = decodeWav(buffer);
  return { channels: decoded.channels, sampleRate: decoded.sampleRate, frames: decoded.frames };
}

/** Обрезает каналы до нужной длины (сравнивать разные длины нельзя). */
export function trimChannels(channels, frames) {
  return channels.map((channel) => (channel.length > frames ? channel.slice(0, frames) : channel));
}

/** Спецификация с ограниченным набором ролей — для рендера отдельных слоёв. */
export function subsetSpec(spec, roles) {
  const kept = {};
  for (const role of roles) {
    if (spec.parts.roles[role]) kept[role] = spec.parts.roles[role];
  }
  return { ...spec, parts: { roles: kept } };
}

/**
 * Собирает «оригинал» для сравнения: микс и доступные слои с диска.
 * Используется циклом самоулучшения — там нужен тот же сигнал, что и в разборе.
 *
 * @param {{originalWavPath?:string, stemPaths?:Record<string,string>}} paths
 */
export async function buildReference(paths = {}) {
  const reference = {};
  if (paths.originalWavPath) {
    try {
      const original = await readWav(paths.originalWavPath);
      reference.mix = { channels: original.channels, sampleRate: original.sampleRate };
    } catch {
      // микс недоступен — слои всё равно можно сравнивать
    }
  }
  for (const [layer, file] of Object.entries(paths.stemPaths ?? {})) {
    if (!file) continue;
    try {
      const audio = await readWav(file);
      reference[layer] = { channels: audio.channels, sampleRate: audio.sampleRate };
    } catch {
      // слой недоступен — метрика будет «нет данных», а не ноль
    }
  }
  return reference;
}

/**
 * Ноты баса из плана двойника — чтобы сравнивать бас «план против оригинала».
 * План хранит бас как сетку шагов по секциям; здесь она переводится в ноты.
 *
 * @param {object} plan TrackSpec двойника
 * @returns {Array<{time_s:number, midi:number, duration_s:number}>|null}
 */
export function bassNotesFromPlan(plan) {
  const part = plan?.parts?.roles?.bass;
  const sections = plan?.structure?.sections ?? [];
  if (!part?.bars?.length || !sections.length) return null;
  const bpm = Number(plan?.meta?.bpm) || 120;
  const barSec = 240 / bpm;
  const notes = [];
  let barCursor = 0;
  part.bars.forEach((sectionBars, sectionIndex) => {
    const section = sections[sectionIndex];
    const sectionBarsCount = Array.isArray(sectionBars) ? sectionBars.length : 0;
    for (let barIndex = 0; barIndex < sectionBarsCount; barIndex += 1) {
      const steps = sectionBars[barIndex] ?? [];
      const stepSec = barSec / Math.max(1, steps.length);
      steps.forEach((token, stepIndex) => {
        if (!token || token === '~') return;
        const name = String(token).replace(/\*\d+$/, '').trim();
        const midi = noteNameToMidi(name);
        if (!Number.isFinite(midi)) return;
        notes.push({
          time_s: barCursor * barSec + stepIndex * stepSec,
          midi,
          duration_s: stepSec,
        });
      });
      barCursor += 1;
    }
  });
  return notes.length ? notes : null;
}
