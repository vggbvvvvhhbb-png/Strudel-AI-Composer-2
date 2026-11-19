// Этапы 2 и 3: разделение на стемы и измерение слоёв.
//
// РАЗДЕЛЕНИЕ (Demucs) может не удаться — это не смерть разбора: слои просто
// не появятся, а метрики по ним будут «нет данных», а не ноль.
//
// ИЗМЕРЕНИЕ СЛОЁВ идёт в два прохода:
//   * Node (тот же DSP, что и в студии) — активность по секциям и удары;
//   * Python (chroma/piptrack там точнее) — питч баса и аккорды.
//
// ЧЕСТНОСТЬ КОНТРАКТА. В stem_descriptors попадают только ИЗМЕРЕННЫЕ стемы.
// Если разделения не было, там не будет «д drums»: подмена измеренного слоя
// догадкой — это ровно то, чего в этом проекте быть не должно.

import path from 'node:path';

import { measureActivity, measureDrums } from '../audio/measure.js';
import { readWav } from './helpers.js';
import { STEM_LAYERS } from './constants.js';
import { isInsufficientMemory } from '../analysis/client.js';

/**
 * Этап 2: разделение трека на стемы.
 *
 * @returns {Promise<{stemPaths: Record<string,string>, separation: object|null}>}
 */
export async function separateStage({
  originalWav,
  workspaceDir,
  model,
  separate,
  separateStems,
  stage,
  errors,
}) {
  const stemPaths = {};
  let separation = null;
  if (!separate) return { stemPaths, separation };

  stage('separate', 'Разделяем трек на стемы', 0.35, 'это самая долгая операция');
  try {
    const stemsDir = path.join(workspaceDir, 'stems');
    separation = await separateStems(originalWav, stemsDir, { model, stage: 'separate' });
    for (const [layer, file] of Object.entries(separation.stems ?? {})) {
      if (file) stemPaths[layer] = file;
    }
  } catch (err) {
    // Отказ по памяти — измеренный факт о машине, а не сбой. Разбор продолжается
    // без стемов, но человек должен увидеть ЧТО кончилось, СКОЛЬКО было
    // свободно и что можно сделать (D-158).
    if (isInsufficientMemory(err)) {
      errors.push({
        stage: 'separate',
        message: memoryAdvice(err),
        fatal: false,
        status: 'insufficient_memory',
        kind: err.kind ?? null,
        measured: err.measured ?? null,
        attempts: (err.attempts ?? []).map((item) => ({
          step: item?.step ?? null,
          ok: Boolean(item?.ok),
          kind: item?.kind ?? null,
          error: item?.error ?? null,
        })),
      });
    } else {
      // Честная деградация: разбор продолжается без стемов.
      errors.push({ stage: 'separate', message: `Разделение на стемы не удалось: ${err.message}` });
    }
  }
  return { stemPaths, separation };
}

/**
 * Человеческий текст отказа по памяти: что случилось, что измерено, что делать.
 *
 * Числа подставляются из измерения, а не выдумываются. Если числа нет —
 * пишется «нет данных», а не ноль (D-102).
 *
 * @param {import('../analysis/client.js').InsufficientMemoryError} err
 * @returns {string}
 */
export function memoryAdvice(err) {
  const kind = err?.kind ?? null;
  const measured = err?.measured ?? null;
  const available = measured?.available_commit_mb ?? null;
  const attempts = Array.isArray(err?.attempts) ? err.attempts : [];
  const tried = attempts.length
    ? attempts.map((item) => item?.step).filter(Boolean).join(' → ')
    : null;

  const what = {
    cuda_oom: 'видеопамять GPU исчерпана',
    host_alloc: 'оперативная память исчерпана',
    commit_limit: 'лимит выделения памяти Windows (commit) исчерпан',
    worker_crashed: 'процесс Demucs был убит системой',
  }[kind] ?? 'памяти не хватило';

  const parts = [`Разделение на стемы не состоялось: ${what}.`];
  if (available !== null && available !== undefined) {
    parts.push(`Свободный commit memory на момент отказа: ${available} МБ.`);
  } else {
    parts.push('Запас памяти на момент отказа: нет данных.');
  }
  if (tried) parts.push(`Пробованные экономные режимы: ${tried}.`);
  parts.push(
    'Что можно сделать: закройте тяжёлые программы (браузер, редакторы, Ollama), '
    + 'увеличьте файл подкачки на диске со свободным местом или возьмите короткий фрагмент трека.',
  );
  return parts.join(' ');
}


/**
 * Этап 3: дескрипторы слоёв.
 *
 * @param {object} params
 * @param {Record<string,string>} params.stemPaths пути к файлам стемов
 * @param {Array} params.sections секции трека
 * @param {number} params.bpm измеренный темп (нужен для сетки ударов)
 * @param {Function} params.analyzeStems анализ стемов через Python
 * @param {Array} params.errors список деградаций
 */
export async function measureStemLayers({ stemPaths, sections, bpm, analyzeStems, errors }) {
  const stemDescriptors = {};
  const stemAudio = {};

  for (const layer of STEM_LAYERS) {
    const file = stemPaths[layer];
    if (!file) continue;
    try {
      const audio = await readWav(file);
      stemAudio[layer] = audio;
      const descriptor = { activity: measureActivity(audio.channels, audio.sampleRate, sections) };
      if (layer === 'drums') {
        const drums = measureDrums(audio.channels, audio.sampleRate, { bpm, sections });
        descriptor.onsets = drums.onsets;
      }
      stemDescriptors[layer] = descriptor;
    } catch (err) {
      errors.push({ stage: 'stems', message: `Слой «${layer}» не прочитан: ${err.message}` });
    }
  }

  // Питч баса и аккорды считает Python (chroma/piptrack там точнее).
  if (Object.keys(stemPaths).length) {
    try {
      const pythonDescriptors = await analyzeStems(stemPaths, sections, { stage: 'stems' });
      for (const [layer, descriptor] of Object.entries(pythonDescriptors.stem_descriptors ?? {})) {
        stemDescriptors[layer] = { ...(stemDescriptors[layer] ?? {}), ...descriptor };
        // Активность измеряем в Node (тот же DSP, что и студия) — Python-версия
        // остаётся запасной, если своих стемов нет.
        if (stemDescriptors[layer].activity && descriptor.activity) {
          stemDescriptors[layer].activity = { ...descriptor.activity, ...stemDescriptors[layer].activity };
        }
      }
    } catch (err) {
      errors.push({ stage: 'stems', message: `Питч и аккорды не измерены: ${err.message}` });
    }
  }

  return { stemDescriptors, stemAudio };
}

/**
 * Запасной ритм: атаки из самого микса.
 *
 * Нужен, когда разделения не было (или оно не удалось), а двойник всё равно
 * должен существовать. Детектор атак работает по любому сигналу.
 *
 * ЧЕСТНАЯ ОГОВОРКА. В миксе слышны все слои, поэтому часть атак (бас, смена
 * аккорда) может попасть в «ударные». Поэтому результат помечается как
 * деградация, а не выдаётся за измерение стема.
 *
 * @returns {{onsets: object, activity: object}|null}
 */
export function fallbackRhythmFromMix({ channels, sampleRate, bpm, sections }) {
  const drums = measureDrums(channels, sampleRate, { bpm, sections });
  if (!drums?.onsets?.hits?.length) return null;
  return { onsets: drums.onsets, activity: drums.activity };
}
