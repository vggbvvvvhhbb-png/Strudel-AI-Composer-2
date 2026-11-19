// P5: локальный ориентир по зарегистрированному WAV, не транскрипция и не клон.
// DSP и Python-анализ общие с сервером; наружу выходят только агрегаты.
import { mkdir } from 'node:fs/promises';
import { analyzeFile, analyzeStems, separateStems } from '../server/deepdive/analysis/client.js';
import { readWav, round, trimChannels } from '../server/deepdive/pipeline/helpers.js';
import { buildPassport } from '../server/samples/passport.js';

const LAYERS = ['drums', 'bass', 'other', 'vocals'];
const MAX_SECONDS = 240;
const DESCRIPTOR_SECONDS = 12;
const BANDS = ['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'];
const MODES = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian'];
const CHARACTERS = new Set([
  'тёмный', 'средний', 'яркий', 'резкий по верхам', 'редкие атаки', 'ударный',
  'плотный', 'без выраженного тона', 'тональный', 'тихий', 'громкий',
]);

function audioFrames(audio) {
  if (!Number.isFinite(audio?.sampleRate) || audio.sampleRate <= 0 || !audio.channels?.length) {
    throw new Error('analyze_reference: WAV не содержит каналов с корректной частотой дискретизации');
  }
  const frames = Math.min(...audio.channels.map((channel) => channel.length));
  if (!Number.isFinite(frames) || frames <= 0) throw new Error('analyze_reference: WAV пуст');
  return frames;
}

function mean(values) {
  const measured = values.filter(Number.isFinite);
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
}

export async function analyzeReferenceFile(filePath, { outDir, progress = () => {}, signal } = {}) {
  if (!filePath) throw new Error('analyze_reference: нужен зарегистрированный WAV');
  if (!outDir) throw new Error('analyze_reference: нужен task-specific outDir');
  const checkAbort = () => signal?.throwIfAborted();
  const stage = (name, message) => {
    checkAbort();
    progress({ stage: name, message, eta: null });
    checkAbort();
  };
  const caveats = [
    'Ориентир не клон: только измеренные агрегаты, без переноса мелодии или исходного аудио.',
    'Вокал не воспроизводится: vocals описан только агрегатами.',
    'Дескрипторы тембра относятся к первым min(12 с, длительность) секундам каждого стема, не ко всему треку.',
  ];
  const number = (value, field) => {
    const result = round(value);
    if (result === null) caveats.push(`${field}: нет данных — признак не измерен или нечисловой.`);
    return result;
  };
  const numbers = (source, keys, prefix) => Object.fromEntries(
    keys.map((key) => [key, number(source?.[key], `${prefix}.${key}`)]),
  );

  stage('read', 'Читаем WAV и проверяем предел 240 с');
  const audio = await readWav(filePath);
  checkAbort();
  const durationS = audioFrames(audio) / audio.sampleRate;
  if (durationS > MAX_SECONDS) {
    throw new Error('analyze_reference: длительность превышает предел 240 с; тяжёлый анализ не запущен');
  }

  stage('analyze', 'Измеряем темп, тональность, громкость и секционную энергию');
  const analysis = await analyzeFile(filePath, { stage: 'analyze_reference' });
  checkAbort();
  const measured = analysis?.measurements;
  const tempo = numbers(measured?.tempo, ['bpm', 'confidence'], 'measurements.tempo');
  const tonic = typeof measured?.key?.tonic === 'string' && /^[A-G][#b]?$/.test(measured.key.tonic)
    ? measured.key.tonic : null;
  const mode = MODES.includes(measured?.key?.mode) ? measured.key.mode : null;
  if (tonic === null) caveats.push('measurements.key.tonic: нет данных — тоника не определена.');
  if (mode === null) caveats.push('measurements.key.mode: нет данных — лад не определён.');
  const key = { tonic, mode, confidence: number(measured?.key?.confidence, 'measurements.key.confidence') };
  const loudness = numbers(measured?.loudness, [
    'lufs_integrated', 'lufs_max', 'lufs_range', 'true_peak_dbtp', 'peak_dbfs', 'crest_db',
  ], 'measurements.loudness');
  const structure = analysis?.structure?.length ? analysis.structure.map((section, index) => ({
    index: number(section?.index, `structure.${index}.index`),
    start_s: number(section?.start_s, `structure.${index}.start_s`),
    end_s: number(section?.end_s, `structure.${index}.end_s`),
    energy: number(section?.energy, `structure.${index}.energy`),
  })) : null;
  if (structure === null) caveats.push('structure: нет данных — секции не измерены.');

  stage('separate', 'Разделяем ориентир на четыре слоя (htdemucs)');
  await mkdir(outDir, { recursive: true });
  checkAbort();
  const separated = await separateStems(filePath, outDir, { model: 'htdemucs', stage: 'separate' });
  checkAbort();
  // Даже при расширении ответа воркера не анализируем посторонние файлы/слои.
  const paths = Object.fromEntries(LAYERS.filter((layer) => typeof separated?.stems?.[layer] === 'string'
    && separated.stems[layer]).map((layer) => [layer, separated.stems[layer]]));
  let stemAnalysis = null;
  if (Object.keys(paths).length) {
    stage('analyze_stems', 'Измеряем активность и энергию стемов');
    stemAnalysis = await analyzeStems(paths, structure ?? [], { stage: 'analyze_stems' });
    checkAbort();
  } else {
    caveats.push('analyzeStems: нет данных — Demucs не вернул ни одного стема.');
  }

  const stems = {};
  for (const layer of LAYERS) {
    stage('descriptor', `Измеряем короткий дескриптор: ${layer}`);
    const stem = {
      available: false, descriptor: null, analyzedSeconds: null, activityMean: null, energyMean: null, reason: null,
    };
    stems[layer] = stem;
    if (!paths[layer]) {
      stem.reason = 'Нет данных: Demucs не вернул этот слой.';
      caveats.push(`stems.${layer}: ${stem.reason}`);
      continue;
    }
    let channels;
    let sampleRate;
    try {
      const decoded = await readWav(paths[layer]);
      checkAbort();
      sampleRate = decoded.sampleRate;
      const frames = Math.min(audioFrames(decoded), Math.floor(Math.min(DESCRIPTOR_SECONDS, durationS) * sampleRate));
      if (frames < 1) throw new Error('окно дескриптора пусто');
      channels = trimChannels(decoded.channels, frames);
      stem.analyzedSeconds = frames / sampleRate;
      stem.available = true;
    } catch {
      checkAbort();
      stem.reason = 'Нет данных: WAV стема недоступен, пуст или не декодируется.';
      caveats.push(`stems.${layer}: ${stem.reason}`);
      continue;
    }
    // Полный паспорт содержит пути и ноты: наружу отдаём только агрегаты.
    const passport = buildPassport(channels, sampleRate);
    const prefix = `stems.${layer}.descriptor`;
    stem.descriptor = {
      loudness: numbers(passport?.loudness, ['lufsI', 'peakDbfs', 'crestDb'], `${prefix}.loudness`),
      spectral: {
        ...numbers(passport?.spectral, ['centroidHz', 'rolloffHz', 'flatness'], `${prefix}.spectral`),
        bands: numbers(passport?.spectral?.bands, BANDS, `${prefix}.spectral.bands`),
      },
      transients: numbers(passport?.transients, ['count', 'densityPerSec'], `${prefix}.transients`),
      tonal: numbers(passport?.tonal, ['voicedRatio'], `${prefix}.tonal`),
      tempo: numbers(passport?.tempo, ['bpm', 'confidence'], `${prefix}.tempo`),
      character: Array.isArray(passport?.character) ? passport.character.filter((trait) => CHARACTERS.has(trait)) : null,
    };
    if (stem.descriptor.character === null) caveats.push(`${prefix}.character: нет данных — характер не определён.`);
    const layerAnalysis = stemAnalysis?.stem_descriptors?.[layer];
    stem.activityMean = number(mean(Object.values(layerAnalysis?.activity ?? {})), `stems.${layer}.activityMean`);
    stem.energyMean = number(mean((Array.isArray(layerAnalysis?.energy) ? layerAnalysis.energy : [])
      .map((point) => point?.value)), `stems.${layer}.energyMean`);
  }
  checkAbort();
  const model = separated?.model === 'htdemucs' ? separated.model : null;
  if (model === null) caveats.push('model: нет данных — воркер не подтвердил htdemucs.');
  // Не копируем свободный methods-текст Python: fallback-исключения содержат пути.
  return {
    durationS,
    measurements: { tempo, key, loudness },
    structure,
    stems,
    model,
    separationSeconds: number(separated?.seconds, 'separationSeconds'),
    methods: {
      analysis: 'analyzeFile (общий Python-воркер)',
      separation: 'separateStems (запрошен htdemucs)',
      stems: stemAnalysis ? 'analyzeStems (общий Python-воркер); средние активности и нормализованной энергии' : null,
      descriptor: 'buildPassport (общий DSP); первые ≤12 с; без высот и времён атак',
    },
    caveats,
  };
}
