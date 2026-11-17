// Импорт первой выборки Timbre Palette (этап 2/3, D-126/D-128).
//
//   node scripts/import-timbre.mjs                 # импорт по манифесту
//   node scripts/import-timbre.mjs --dry-run       # план без скачивания
//   node scripts/import-timbre.mjs --preset tp-upright-soft-v1
//
// ПРАВИЛА ОБРАБОТКИ (отменяют ранний черновик):
//   * оригинал WAV сохраняется БЕЗ изменений (sha256 оригинала в реестре);
//   * никакой слепой обрезки тишины и LUFS-нормализации: производный OGG
//     (libvorbis q5) сохраняет стерео, частоту дискретизации и динамику;
//   * LUFS/спектр/атаки ИЗМЕРЯЮТСЯ существующим паспортом и хранятся,
//     исходник не меняется;
//   * root-ноты берутся из метаданных набора (имена файлов, MappingChart),
//     не угадываются;
//   * идемпотентность: повторный запуск не плодит дубли (sha256-реестр).
//
// Права: источник CC0-1.0 подтверждён по первоисточнику (sources.json);
// каждый ассет получает полную запись прав и атрибуцию TASL с кредитом
// автора поднабора. Реестр — server/music/data/timbre/, OGG-пресеты —
// в git (D-130), банк-исходник (originals/) — вне git.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import ffmpegPath from 'ffmpeg-static';

import { readWav } from '../server/deepdive/pipeline/helpers.js';
import { buildPassport } from '../server/samples/passport.js';
import {
  TIMBRE_DIR, TIMBRE_AUDIO_DIR, loadTimbreCatalog, auditTimbre,
} from '../server/samples/timbre.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const MANIFEST = JSON.parse(readFileSync(path.join(here, 'timbre-import-manifest.json'), 'utf8'));
const BANKS = JSON.parse(readFileSync(path.join(root, 'server/music/data/sample-banks.json'), 'utf8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const presetFilter = args.includes('--preset') ? args[args.indexOf('--preset') + 1] : null;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const slug = (text) => String(text).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function runFfmpeg(argsList) {
  const res = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...argsList], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (res.status !== 0) {
    throw new Error(`ffmpeg: ${res.stderr?.trim() || res.error?.message || `код ${res.status}`}`);
  }
}

async function download(url, outFile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, buffer);
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/** Измерение оригинала: 16-bit PCM читается напрямую, иначе копия для DSP. */
async function measureOriginal(origFile) {
  try {
    return await readWav(origFile);
  } catch (error) {
    if (!/PCM 16-bit/.test(String(error?.message))) throw error;
    const tmp = `${origFile}.measure16.wav`;
    runFfmpeg(['-i', origFile, '-acodec', 'pcm_s16le', tmp]);
    try {
      return await readWav(tmp);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

function zoneBounds(roots, index) {
  const sorted = [...roots].sort((a, b) => a - b);
  const position = sorted.indexOf(roots[index]);
  const low = position === 0 ? 0 : Math.ceil((sorted[position - 1] + roots[index]) / 2);
  const high = position === sorted.length - 1 ? 127 : Math.floor((roots[index] + sorted[position + 1]) / 2) - 1;
  return { key_low: low, key_high: Math.max(low, high) };
}

const catalog = loadTimbreCatalog();
const bankNames = Object.values(BANKS.banks ?? {}).flatMap((bank) => bank.names ?? []);
const today = new Date().toISOString().slice(0, 10);
const source = catalog.sources[MANIFEST.source];
if (!source || source.rights_status !== 'approved') {
  console.error(`Источник «${MANIFEST.source}» не approved в реестре — импорт запрещён (fail-closed).`);
  process.exit(1);
}

const strudelMap = {
  _base: '/timbre-audio/',
  ...(() => {
    const file = path.join(TIMBRE_DIR, 'strudel-map.json');
    if (!existsSync(file)) return {};
    const { _base, ...rest } = JSON.parse(readFileSync(file, 'utf8'));
    return rest;
  })(),
};
let imported = 0;
let skipped = 0;
const failures = [];

for (const preset of MANIFEST.presets) {
  if (presetFilter && preset.id !== presetFilter) continue;
  const alias = preset.strudelAlias;
  const presetDir = path.join(TIMBRE_AUDIO_DIR, alias);
  const origDir = path.join(TIMBRE_AUDIO_DIR, 'originals', MANIFEST.source);
  const roots = preset.assets.map((asset) => asset.root_midi);
  const assetIds = [];

  for (const [index, asset] of preset.assets.entries()) {
    const assetId = `${MANIFEST.source}/${slug(path.basename(asset.path))}`;
    assetIds.push(assetId);
    const origFile = path.join(origDir, path.basename(asset.path));
    const oggFile = path.join(presetDir, `${asset.note.replace('#','s')}.ogg`);
    const existing = catalog.assets[assetId];

    if (dryRun) {
      console.log(`[план] ${assetId} -> ${alias}/${asset.note}.ogg (root ${asset.root_midi})`);
      continue;
    }

    try {
      // 1. Оригинал: скачиваем только если нет или sha256 не совпал.
      let origBuffer;
      if (existsSync(origFile)) {
        origBuffer = readFileSync(origFile);
        if (existing?.sha256 && sha256(origBuffer) !== existing.sha256) {
          console.warn(`[импорт] ${assetId}: sha256 оригинала изменился — перекачиваю`);
          origBuffer = await download(MANIFEST.baseUrl + asset.path.split('/').map(encodeURIComponent).join('/'), origFile);
        } else {
          skipped += 1;
        }
      } else {
        origBuffer = await download(MANIFEST.baseUrl + asset.path.split('/').map(encodeURIComponent).join('/'), origFile);
      }
      const origHash = sha256(origBuffer);

      // 2. Производный OGG: без нормализации и обрезки, стерео/sr сохраняются.
      let oggBuffer;
      if (existsSync(oggFile) && existing?.sha256_derived) {
        oggBuffer = readFileSync(oggFile);
        if (sha256(oggBuffer) !== existing.sha256_derived) {
          runFfmpeg(['-i', origFile, '-c:a', 'libvorbis', '-q:a', '5', oggFile]);
          oggBuffer = readFileSync(oggFile);
        }
      } else {
        mkdirSync(presetDir, { recursive: true });
        runFfmpeg(['-i', origFile, '-c:a', 'libvorbis', '-q:a', '5', oggFile]);
        oggBuffer = readFileSync(oggFile);
      }

      // 3. Паспорт — тем же DSP, что и весь проект; исходник не меняется.
      const audio = await measureOriginal(origFile);
      const name = `${preset.name} — ${asset.note.toUpperCase()}`;
      const passport = buildPassport(audio.channels, audio.sampleRate, {
        name,
        source: MANIFEST.blobUrl + asset.path.split('/').map(encodeURIComponent).join('/'),
      });

      const attribution = `«${name}» by ${preset.creator} — ${source.license} — ${MANIFEST.blobUrl}${asset.path}`;
      const encodedPath = asset.path.split('/').map(encodeURIComponent).join('/');
      catalog.assets[assetId] = {
        id: assetId,
        name,
        source: MANIFEST.source,
        source_url: MANIFEST.blobUrl + encodedPath,
        creator: preset.creator,
        license: source.license,
        licenseId: source.licenseId,
        license_url: source.license_url,
        checked_at: today,
        commercial_use: source.commercial_use,
        redistribution: source.redistribution,
        derivatives: source.derivatives,
        ai_use: source.ai_use,
        attribution,
        rights_status: 'approved',
        rights_notes: 'Оригинал WAV сохранён без изменений; производный OGG (libvorbis q5) без нормализации и обрезки тишины; стерео и частота дискретизации сохранены. Root-нота из метаданных набора.',
        sha256: origHash,
        sha256_derived: sha256(oggBuffer),
        duration_s: passport.durationS,
        sample_rate: audio.sampleRate,
        channels: audio.channels.length,
        root_midi: asset.root_midi,
        tags: preset.tags,
        descriptor: passport,
        file: `${alias}/${asset.note.replace('#','s')}.ogg`,
        original_file: `originals/${MANIFEST.source}/${path.basename(asset.path)}`,
      };

      // 4. Зона: root из метаданных, границы — середины между соседями.
      const bounds = zoneBounds(roots, index);
      const zone = {
        instrument_id: preset.id,
        asset_id: assetId,
        root_key: asset.root_midi,
        key_low: bounds.key_low,
        key_high: bounds.key_high,
        velocity_low: null,
        velocity_high: null,
        round_robin_group: /rr1/i.test(path.basename(asset.path)) ? 'rr1' : null,
        loop_start_s: null,
        loop_end_s: null,
      };
      const zoneIndex = catalog.zones.findIndex((z) => z.instrument_id === preset.id && z.asset_id === assetId);
      if (zoneIndex >= 0) catalog.zones[zoneIndex] = zone;
      else catalog.zones.push(zone);

      imported += 1;
      console.log(`[импорт] ${assetId}: ${passport.durationS} с, ${audio.sampleRate} Гц, `
        + `центроид ${passport.spectral.centroidHz ?? 'нет данных'} Гц, LUFS ${passport.loudness.lufsI ?? 'нет данных'}`);
    } catch (error) {
      failures.push(`${assetId}: ${error?.message || error}`);
      console.error(`[импорт] ОШИБКА ${assetId}: ${error?.message || error}`);
    }
  }

  if (dryRun) continue;

  // Пресет: дескриптор — паспорт среднего root (измерение, не интерпретация).
  const middleId = assetIds[Math.floor(assetIds.length / 2)];
  catalog.presets[preset.id] = {
    id: preset.id,
    name: preset.name,
    family: preset.family,
    roles: preset.roles,
    strudelAlias: alias,
    tags: preset.tags,
    version: preset.version,
    timbreProfile: preset.timbreProfile,
    descriptor: catalog.assets[middleId]?.descriptor ?? null,
    descriptor_asset: middleId,
  };
  strudelMap[alias] = Object.fromEntries(
    preset.assets.map((asset) => [asset.note, `${alias}/${asset.note.replace('#','s')}.ogg`]),
  );
}

if (dryRun) {
  console.log(`[план] пресетов: ${MANIFEST.presets.length}, ассетов: ${MANIFEST.presets.reduce((n, p) => n + p.assets.length, 0)}`);
  process.exit(0);
}

// Реестры пишутся только после успешного импорта; аудит обязателен.
const audit = auditTimbre(catalog, { bankNames });
if (!audit.ok) {
  console.error('Аудит каталога после импорта КРАСНЫЙ — реестры не записаны:');
  for (const issue of audit.issues) console.error(`  • ${issue.detail}`);
  process.exit(1);
}

const writeJson = (file, payload) => writeFileSync(path.join(TIMBRE_DIR, file), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
writeJson('assets.json', { note: JSON.parse(readFileSync(path.join(TIMBRE_DIR, 'assets.json'), 'utf8')).note, assets: catalog.assets });
writeJson('presets.json', { note: JSON.parse(readFileSync(path.join(TIMBRE_DIR, 'presets.json'), 'utf8')).note, presets: catalog.presets });
writeJson('zones.json', { note: JSON.parse(readFileSync(path.join(TIMBRE_DIR, 'zones.json'), 'utf8')).note, zones: catalog.zones });
writeJson('strudel-map.json', strudelMap);

console.log('');
console.log(`Импорт завершён: новых/обновлённых ${imported}, без изменений ${skipped}, ошибок ${failures.length}`);
console.log(`Каталог: пресетов ${audit.totals.presets}, ассетов ${audit.totals.assets} (approved ${audit.totals.approvedAssets}), зон ${audit.totals.zones}`);
console.log('Strudel-манифест: server/music/data/timbre/strudel-map.json');
if (failures.length) process.exit(1);