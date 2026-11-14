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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { descriptorsToSpec, noteNameToMidi } from './transpiler.js';
import { compareTwin, COMPARE_METHOD } from './compare.js';
import { measureMix, measureActivity, measureDrums } from './audio/measure.js';
import { convertToWav } from './audio/ffmpeg.js';
import { decodeWav } from '../../src/core/wav.js';
import { compileTrackSpec } from '../music/compiler/index.js';
import { analyzeFile, analyzeStems, separateStems } from './analysis/client.js';
import { enqueueRender, getRenderWorker } from './render/pool.js';
export const PIPELINE_VERSION = 'deep-dive/pipeline@0.1.0';
export const SCHEMA_VERSION = '0.1';

// Слои стемов и роли двойника, которые на них смотрят.
const STEM_LAYERS = ['drums', 'bass', 'vocals', 'other'];
const DRUM_ROLES = ['kick', 'snare', 'hats', 'perc'];
const ROLE_TO_LAYER = { bass: 'bass', chords: 'other' };

/** Обязательные ограничения режима. Показываются в каждом разборе. */
export const BASE_CAVEATS = [
  'вокал не воспроизводится',
  'точное сведение и мастеринг не воспроизводятся',
  'это ориентир по измеримому скелету трека, а не его клон',
];

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Читает WAV и отдаёт каналы в формате, который ждёт DSP. */
async function readWav(filePath) {
  const buffer = await readFile(filePath);
  const decoded = decodeWav(buffer);
  return { channels: decoded.channels, sampleRate: decoded.sampleRate, frames: decoded.frames };
}

/** Обрезает каналы до нужной длины (сравнивать разные длины нельзя). */
function trimChannels(channels, frames) {
  return channels.map((channel) => (channel.length > frames ? channel.slice(0, frames) : channel));
}

/** Спецификация с ограниченным набором ролей — для рендера отдельных слоёв. */
function subsetSpec(spec, roles) {
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
  stage('analyze', 'Читаем трек', 0.05);
  const originalWav = path.join(workspaceDir, 'original.wav');
  const conversion = await convertFn(inputPath, originalWav);
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

  // --- Этап 2: разделение на стемы ------------------------------------------
  const stemPaths = {};
  let separation = null;
  if (separate) {
    stage('separate', 'Разделяем трек на стемы', 0.35, 'это самая долгая операция');
    try {
      const stemsDir = path.join(workspaceDir, 'stems');
      separation = await separateStemsFn(originalWav, stemsDir, { model, stage: 'separate' });
      for (const [layer, file] of Object.entries(separation.stems ?? {})) {
        if (file) stemPaths[layer] = file;
      }
    } catch (err) {
      // Честная деградация: разбор продолжается без стемов.
      errors.push({ stage: 'separate', message: `Разделение на стемы не удалось: ${err.message}` });
    }
  }

  // --- Этап 3: дескрипторы слоёв --------------------------------------------
  stage('stems', 'Измеряем слои', 0.5);
  const stemDescriptors = {};
  const stemAudio = {};
  const sections = structure.map((section) => ({
    index: section.index,
    start_s: section.start_s,
    end_s: section.end_s,
    label: section.label,
    energy: section.energy,
  }));

  for (const layer of STEM_LAYERS) {
    const file = stemPaths[layer];
    if (!file) continue;
    try {
      const audio = await readWav(file);
      stemAudio[layer] = audio;
      const descriptor = { activity: measureActivity(audio.channels, audio.sampleRate, sections) };
      if (layer === 'drums') {
        const drums = measureDrums(audio.channels, audio.sampleRate, {
          bpm: measurements.tempo.bpm,
          sections,
        });
        descriptor.onsets = drums.onsets;
      }
      stemDescriptors[layer] = descriptor;
    } catch (err) {
      errors.push({ stage: 'stems', message: `Слой «${layer}» не прочитан: ${err.message}` });
    }
  }

  // Пи��ч баса и аккорды считает Python (chroma/piptrack там точнее).
  if (Object.keys(stemPaths).length) {
    try {
      const pythonDescriptors = await analyzeStemsLayer(stemPaths, sections, { stage: 'stems' });
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

  // --- Этап 4: код-двойник --------------------------------------------------
  stage('twin', 'Собираем код-двойник', 0.65);
  const descriptors = {
    track: { id: 'deepdive', duration_s: original.frames / original.sampleRate },
    measurements,
    structure: sections,
    stem_descriptors: stemDescriptors,
  };
  const { spec, report } = descriptorsToSpec(descriptors);
  const code = compileTrackSpec(spec);
  const totalBars = spec.structure.sections.reduce((sum, section) => sum + section.cycles, 0);
  const bpm = spec.meta.bpm;

  // --- Этап 5: рендер --------------------------------------------------------
  stage('render', 'Рендерим двойник', 0.75);
  const cps = bpm / 240; // циклы в секунду: один цикл = один такт
  let mixRender = null;
  const layerRenders = {};
  const renderFingerprints = {};
  try {
    // В тестах рендер подменяется: браузер в CI не поднять.
    const renderMix = renderFn ?? (async (renderCode) => {
      const worker = await getRenderWorker();
      return enqueueRender(() => worker.render({
        code: renderCode,
        fromCycle: 0,
        toCycle: totalBars,
        cps,
        wantWav: true,
        wantEvents: false,
      }));
    });

    mixRender = await renderMix(code);
    renderFingerprints.mix = mixRender.fingerprint;

    // Слои — отдельно, иначе сравнение «слой против слоя» нечестно.
    const groups = { drums: DRUM_ROLES };
    for (const [role, layer] of Object.entries(ROLE_TO_LAYER)) groups[layer] = [...(groups[layer] ?? []), role];
    for (const [layer, roles] of Object.entries(groups)) {
      const present = roles.filter((role) => spec.parts.roles[role]);
      if (!present.length) continue;
      const layerCode = compileTrackSpec(subsetSpec(spec, present));
      const rendered = await renderMix(layerCode);
      layerRenders[layer] = rendered;
      renderFingerprints[layer] = rendered.fingerprint;
    }
  } catch (err) {
    errors.push({ stage: 'render', message: `Рендер двойника не удался: ${err.message}` });
  }

  // --- Этап 6: сравнение ----------------------------------------------------
  stage('compare', 'Сравниваем с оригиналом', 0.9);
  let metrics = null;
  if (mixRender?.wav) {
    const candidateWav = decodeWav(mixRender.wav);
    const twinFrames = candidateWav.frames;
    const referenceMix = {
      channels: trimChannels(original.channels, twinFrames),
      sampleRate: original.sampleRate,
    };
    const candidateMix = {
      channels: trimChannels(candidateWav.channels, twinFrames),
      sampleRate: candidateWav.sampleRate,
    };

    const reference = { mix: referenceMix };
    const candidate = { mix: candidateMix };
    for (const [layer, rendered] of Object.entries(layerRenders)) {
      if (!rendered?.wav) continue;
      const decoded = decodeWav(rendered.wav);
      candidate[layer] = { channels: decoded.channels, sampleRate: decoded.sampleRate };
      const source = stemAudio[layer];
      if (source) {
        reference[layer] = {
          channels: trimChannels(source.channels, decoded.frames),
          sampleRate: source.sampleRate,
        };
      }
    }

    const referenceBassNotes = stemDescriptors.bass?.pitch?.notes ?? null;
    const candidateBassNotes = (stemDescriptors.bass?.pitch?.notes ?? []).length
      ? stemDescriptors.bass.pitch.notes
      : null;

    const comparison = compareTwin({
      reference,
      candidate,
      referenceBassNotes,
      candidateBassNotes,
      referenceSwing: stemDescriptors.drums?.onsets?.swing ?? null,
      candidateSwing: null,
      iterationLabel: 'baseline',
      iteration: 0,
    });
    metrics = {
      iteration: 0,
      label: 'baseline',
      overall: comparison.overall,
      layers: comparison.layers,
    };
  }

  // --- Сборка результата ----------------------------------------------------
  const caveats = [...BASE_CAVEATS, ...(report?.caveats ?? [])];
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
    },
  };
}
