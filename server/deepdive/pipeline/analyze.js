// Этап 1: базовый анализ трека.
//
// Конвертация в WAV, измерения по миксу (громкость, спектральный баланс,
// стерео) и разбор ответа Python-воркера (темп, лад, структура).
//
// ПРИНЦИП. Отсюда вниз по пайплайну идут только числа. Ничего не угадывается:
// темп приходит из измерения, лад — из хромаграммы, секции — из самоподобия.

import path from 'node:path';

import { measureMix } from '../audio/measure.js';
import { readWav, round } from './helpers.js';

/**
 * @param {object} params
 * @param {string} params.inputPath путь к загруженному файлу
 * @param {string} params.workspaceDir каталог задачи
 * @param {Function} params.convert конвертация в WAV
 * @param {Function} params.analyze анализ через Python-воркер
 * @param {Function} params.stage отчёт о прогрессе
 */
export async function analyzeStage({ inputPath, workspaceDir, convert, analyze, stage }) {
  stage('analyze', 'Читаем трек', 0.05);
  const originalWav = path.join(workspaceDir, 'original.wav');
  const conversion = await convert(inputPath, originalWav);
  if (!conversion.ok) {
    const err = new Error(`Не удалось прочитать аудиофайл: ${conversion.error}`);
    err.stage = 'analyze';
    throw err;
  }
  const original = await readWav(originalWav);
  const mix = measureMix(original.channels, original.sampleRate);

  stage('analyze', 'Ищем темп, лад и структуру', 0.25);
  const analysis = await analyze(originalWav, { stage: 'analyze' });
  const tempo = analysis.measurements.tempo ?? {};
  const key = analysis.measurements.key ?? {};
  const structure = analysis.structure ?? [];

  const measurements = {
    tempo: {
      bpm: round(tempo.bpm, 3),
      confidence: round(tempo.confidence, 3),
      candidates: Array.isArray(tempo.candidates)
        ? tempo.candidates.map((candidate) => ({
          bpm: round(candidate.bpm, 3),
          kind: candidate.kind,
          confidence: round(candidate.confidence, 3),
        }))
        : [],
    },
    key: {
      tonic: key.tonic ?? null,
      mode: key.mode ?? 'unknown',
      confidence: round(key.confidence, 3),
    },
    loudness: mix.loudness,
    spectral_balance: mix.spectral_balance,
    stereo: mix.stereo,
  };

  const sections = structure.map((section) => ({
    index: section.index,
    start_s: section.start_s,
    end_s: section.end_s,
    label: section.label,
    energy: section.energy,
  }));

  return { original, originalWav, measurements, sections };
}
