// Пайплайн режима «Разбор»: файл → измерения → код-двойник → рендер → сравнение.
//
// ЭТАПЫ (их видно пользователю как прогресс):
//   analyze  — темп, лад, громкость, баланс, стерео, структура;
//   separate — разделение на стемы (по требованию, Demucs);
//   stems    — дескрипторы слоёв: активность по секциям, удары, питч, аккорды;
//   twin     — план двойника (TrackSpec) и Strudel-код;
//   render   — офлайн-рендер двойника;
//   compare  — метрики похожести по слоям.
//
// ПРИНЦИПЫ.
//   * Измеряем, а не угадываем: каждый вывод — из числа, полученного из аудио.
//   * Честная деградация: если стемы не разделились, разбор продолжается без
//     них, а метрика помечается «нет данных», а не нулём.
//   * Baseline до улучшений: метрики снимаются ДО того, как что-то улучшили.
//   * Ориентир, не клон: вокал и точное сведение не воспроизводятся, и это
//     записывается в отчёт.
//
// Модуль — тонкая оркестрация: каждый этап живёт в своём файле
// (analyze.js, stems.js, render.js, compare.js), общие утилиты — в helpers.js.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { descriptorsToSpec } from '../transpiler.js';
import { compileTrackSpec } from '../../music/compiler/index.js';
import { convertToWav } from '../audio/ffmpeg.js';
import { analyzeFile, analyzeStems, separateStems } from '../analysis/client.js';
import { analyzeStage } from './analyze.js';
import { separateStage, measureStemLayers, fallbackRhythmFromMix } from './stems.js';
import { renderStage } from './render.js';
import { compareStage, COMPARE_METHOD } from './compare.js';
import { round } from './helpers.js';
import { STEM_LAYERS } from './constants.js';
import { BASE_CAVEATS } from '../caveats.js';

export const PIPELINE_VERSION = 'deep-dive/pipeline@0.2.0';
export const SCHEMA_VERSION = '0.1';

export { BASE_CAVEATS };

/**
 * Основной сценарий разбора.
 *
 * @param {{workspaceDir:string, inputPath:string, fileName?:string,
 *          separate?:boolean, model?:string, onStage?:Function}} params
 */
export async function runDeepDive(params) {
  const {
    workspaceDir,
    inputPath,
    fileName = 'track',
    separate = false,
    model = 'htdemucs',
    onStage = () => {},
    // Паспорт приходит сразу после базового анализа — до разделения на стемы.
    // На CPU разделение занимает десятки минут, и ждать результата, чтобы
    // увидеть темп и лад, — это ровно то «используешь ли ты продукт»,
    // которое мы чиним. Подробности — docs/DECISIONS.md (D-090).
    onPassport = () => {},
    // Зависимости подменяются в тестах: без Python-воркера и без браузера
    // пайплайн всё равно должен собираться и проверяться.
    deps = {},
  } = params;

  const analyze = deps.analyze ?? analyzeFile;
  const analyzeStemsLayer = deps.analyzeStems ?? analyzeStems;
  const separateStemsFn = deps.separate ?? separateStems;
  const renderFn = deps.render ?? null;
  const convertFn = deps.convert ?? convertToWav;

  const errors = [];
  const stage = (name, label, progress, detail) => onStage({ stage: name, label, progress, detail });

  await mkdir(workspaceDir, { recursive: true });

  // --- Этап 1: базовый анализ ------------------------------------------------
  const { original, originalWav, measurements, sections } = await analyzeStage({
    inputPath,
    workspaceDir,
    convert: convertFn,
    analyze,
    stage,
  });

  // Паспорт отдаём сразу: измерения уже есть, а впереди — самая долгая
  // часть (разделение на стемы). Пользователь видит темп, лад и громкость
  // через секунды, а не через полчаса.
  const durationS = original.frames / original.sampleRate;
  onPassport({
    measurements,
    sections,
    durationS,
    track: { id: path.basename(workspaceDir), duration_s: round(durationS, 3), file_name: fileName },
  });

  // --- Этап 2: разделение на стемы ------------------------------------------
  const { stemPaths, separation } = await separateStage({
    originalWav,
    workspaceDir,
    model,
    separate,
    separateStems: separateStemsFn,
    stage,
    errors,
  });

  // --- Этап 3: дескрипторы слоёв --------------------------------------------
  stage('stems', 'Измеряем слои', 0.5);
  const { stemDescriptors, stemAudio } = await measureStemLayers({
    stemPaths,
    sections,
    bpm: measurements.tempo.bpm,
    analyzeStems: analyzeStemsLayer,
    errors,
  });

  // Ритм для двойника: сначала измеренный стем ударных. Если разделения не
  // было — атаки берём из самого микса: двойник должен существовать всегда.
  //
  // ЧЕСТНОСТЬ. В stem_descriptors при этом НИЧЕГО не добавляется: там остаются
  // только измеренные стемы. Запасной ритм живёт отдельно и попадает в отчёт
  // как оговорка — пользователь должен видеть, что ударные не разделены.
  const measuredRhythm = stemDescriptors.drums?.onsets;
  let rhythm = measuredRhythm ? { onsets: measuredRhythm, activity: stemDescriptors.drums.activity } : null;
  let rhythmSource = measuredRhythm ? 'stem' : null;
  const caveats = [...BASE_CAVEATS];
  if (!rhythm) {
    const fallback = fallbackRhythmFromMix({
      channels: original.channels,
      sampleRate: original.sampleRate,
      bpm: measurements.tempo.bpm,
      sections,
    });
    if (fallback) {
      rhythm = { onsets: fallback.onsets, activity: fallback.activity };
      rhythmSource = 'mix';
      caveats.push('ударные не разделены: ритм двойника извлечён из микса, часть атак может принадлежать другим слоям');
    }
  }

  // --- Этап 4: код-двойник --------------------------------------------------
  stage('twin', 'Собираем код-двойник', 0.65);
  const descriptors = {
    track: { id: 'deepdive', duration_s: original.frames / original.sampleRate },
    measurements,
    structure: sections,
    stem_descriptors: stemDescriptors,
    rhythm: rhythm ? { ...rhythm, source: rhythmSource } : null,
  };
  const { spec, report } = descriptorsToSpec(descriptors);
  const code = compileTrackSpec(spec);
  const totalBars = spec.structure.sections.reduce((sum, section) => sum + section.cycles, 0);
  const bpm = spec.meta.bpm;

  // --- Этап 5: рендер --------------------------------------------------------
  stage('render', 'Рендерим двойник', 0.75);
  const { mixRender, layerRenders, renderFingerprints } = await renderStage({
    spec,
    code,
    totalBars,
    bpm,
    renderFn,
    errors,
  });

  // --- Этап 6: сравнение ----------------------------------------------------
  stage('compare', 'Сравниваем с оригиналом', 0.9);
  const metrics = compareStage({
    original,
    mixRender,
    layerRenders,
    stemAudio,
    stemDescriptors,
  });

  // --- Сборка результата ----------------------------------------------------
  caveats.push(...(report?.caveats ?? []));
  const result = {
    schema_version: SCHEMA_VERSION,
    track: {
      id: path.basename(workspaceDir),
      duration_s: round(original.frames / original.sampleRate, 3),
      file_name: fileName,
      source: 'upload',
    },
    measurements,
    structure: sections.map((section) => ({
      index: section.index,
      start_s: round(section.start_s, 3),
      end_s: round(section.end_s, 3),
      label: section.label,
      energy: round(section.energy, 4),
    })),
    stems: Object.fromEntries(STEM_LAYERS.map((layer) => {
      const available = Boolean(stemPaths[layer]);
      return [layer, {
        available,
        duration_s: available ? round((stemAudio[layer]?.frames ?? 0) / (stemAudio[layer]?.sampleRate || 1), 3) : null,
      }];
    })),
    stem_descriptors: stemDescriptors,
    recipes: [],
    code_twin: {
      plan: spec,
      code,
      render: mixRender
        ? {
          status: 'rendered',
          wav_url: null, // проставляется маршрутом (нужен id задачи)
          duration_s: round(mixRender.durationS, 3),
          render_ms: mixRender.renderMs,
          fingerprint: mixRender.fingerprint,
        }
        : { status: 'failed' },
      metrics: metrics ? [metrics] : [],
      iterations: [],
      honesty: {
        claims: [
          `темп ${measurements.tempo.bpm} BPM — измерено (уверенность ${measurements.tempo.confidence})`,
          `тональность ${measurements.key.tonic ?? '—'} ${measurements.key.mode} — измерено (уверенность ${measurements.key.confidence})`,
          `форма ${totalBars} тактов, ${sections.length} секций — из структуры трека`,
        ],
        caveats,
      },
    },
    versions: {
      schema: SCHEMA_VERSION,
      pipeline: PIPELINE_VERSION,
      compare: COMPARE_METHOD,
    },
    errors,
  };

  // WAV двойника сохраняем рядом — его отдаёт маршрут.
  let twinWavPath = null;
  if (mixRender?.wav) {
    twinWavPath = path.join(workspaceDir, 'twin.wav');
    await writeFile(twinWavPath, mixRender.wav);
  }

  return {
    result,
    artifacts: {
      spec,
      code,
      twinWavPath,
      totalBars,
      originalWavPath: originalWav,
      stemPaths,
      separationSeconds: separation?.seconds ?? null,
      renderFingerprints,
      // Ритм, по которому построен двойник: измеренный стем ударных или,
      // если разделения не было, — атаки из микса. Нужен экспорту MIDI,
      // чтобы ударные попали в файл даже без стемов.
      rhythm: rhythm ? { onsets: rhythm.onsets, source: rhythmSource } : null,
    },
  };
}

export { buildReference, bassNotesFromPlan } from './helpers.js';
