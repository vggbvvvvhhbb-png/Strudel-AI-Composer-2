#!/usr/bin/env node
// ГЕЙТ E — «Охотник»: найди редкий звук → паспорт → бит (гайд «ПРОРЫВ», §12).
//
// ЧТО ПРОВЕРЯЕМ. Цепочка тулзов проходит end-to-end за ≤3 мин:
//   freesound_search → sample_passport → compose_spec(sampleId) → compile →
//   локальный рендер, в котором НАЙДЕННЫЙ СЭМПЛ СЛЫШЕН (события в рендере),
//   лицензия каждого скачанного сэмпла видна в реестре пула.
//
// ДВА РЕЖИМА.
//   node scripts/gate-e.mjs          — офлайн: детерминированная цепочка на
//     синтезированном WAV + честная деградация без ключей. Сети не требует.
//   node scripts/gate-e.mjs --live   — живой проход: реальный поиск Freesound,
//     скачивание превью, паспорт, план вокруг паспорта, рендер. Требует
//     FREESOUND_API_KEY. LLM может быть недоступен — тогда план собирается
//     из библиотеки, и это честно помечается «нет данных», а не зелёным.
//
// Пишет отчёт: docs/evidence/agent/gate-e.json (офлайн)
//              docs/evidence/agent/gate-e-live.json (--live)

import 'dotenv/config';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTool } from '../server/agent/tools.js';
import { getFromPool, poolLicenseRegistry, POOL_AUDIO_DIR } from '../server/samples/pool.js';
import { buildTrack, fallbackSpec } from '../server/music/compose/pipeline.js';
import { completeChat } from '../server/llm/router.js';
import { createRenderWorker, poolAudioFile } from '../server/deepdive/render/render-worker.mjs';
import { sampleSoundName, passportHints, applySamplePlan } from '../server/music/compose/sample-plan.js';
import { checkSpec } from '../server/music/spec/check.js';
import { compileTrackSpec } from '../server/music/compiler/index.js';
import { encodeWav } from '../src/core/wav.js';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIVE = process.argv.includes('--live');
const BUDGET_SECONDS = 180; // гейт E: end-to-end ≤3 мин
const QUERY = process.env.GATE_E_QUERY || 'glass hit metallic';

const startedAt = Date.now();
const checks = [];
function check(id, title, ok, detail = null) {
  checks.push({ id, title, ok, detail });
  const mark = ok === true ? 'OK  ' : ok === 'no-data' ? 'НЕТ ДАННЫХ' : 'ПРОВАЛ';
  console.log(`[${mark}] ${title}${detail ? ` — ${detail}` : ''}`);
}
const seconds = () => (Date.now() - startedAt) / 1000;

/** Синтетический WAV: четыре затухающих тональных удара — есть атаки и тон. */
function synthWav() {
  const rate = 44100;
  const n = Math.floor(rate * 0.3);
  const channel = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    channel[i] = Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 18) * 0.6;
  }
  return Buffer.from(encodeWav([channel], rate));
}

async function renderWithSample(worker, code, bpm, id, sound) {
  const result = await worker.render({
    code,
    fromCycle: 0,
    toCycle: 8,
    cps: bpm / 240,
    poolSamples: [{ id, sound }],
  });
  const sampleEvents = (result.events ?? []).filter((e) => JSON.stringify(e).includes(sound));
  return { result, sampleEvents: sampleEvents.length, totalEvents: result.events?.length ?? 0 };
}

async function main() {
  console.log(`ГЕЙТ E — «Охотник», режим: ${LIVE ? 'ЖИВОЙ' : 'офлайн'}\n`);
  let worker = null;
  const synthFile = path.join(POOL_AUDIO_DIR, 'gate-e-synth.wav');

  try {
    if (!LIVE) {
      // 1. Деградация поиска без ключа — честный отказ, не падение.
      const noKey = await runTool('freesound_search', { query: QUERY }, { env: {} });
      check('degrade', 'без ключа поиск честно деградирует', noKey.ok === false && noKey.degraded === true && String(noKey.reason).includes('недоступен'), noKey.reason);

      // 2. Неизмеренное не превращается в число.
      const weak = passportHints({ tonal: { note: 'C', voicedRatio: 0.1 }, tempo: { bpm: 120, confidence: 0.05 } });
      check('honest', 'слабый паспорт: тон и темп — «нет данных»', weak.key === null && weak.bpm === null && weak.sources.key.includes('нет данных'));

      // 3. План вокруг паспорта валиден и компилируется.
      const entry = {
        id: 'gate-e-synth',
        name: 'Gate E synth',
        licenseId: 'cc0',
        passport: { tonal: { note: 'A', voicedRatio: 0.8 }, tempo: { bpm: 120, confidence: 0.9 }, transients: { densityPerSec: 4 }, character: ['яркий'] },
      };
      const { spec } = applySamplePlan(fallbackSpec('techno', 1), { entry });
      const checked = checkSpec(spec);
      check('plan', 'план вокруг паспорта проходит проверку', checked.ok === true, (checked.errors ?? []).join('; ') || null);
      check('meta', 'измеренные тон и темп в мете', spec.meta.key === 'Amin' && spec.meta.bpm === 120, `${spec.meta.key} ${spec.meta.bpm} BPM`);

      // 4. Раздача WAV пула защищена от обхода каталога.
      check('traversal', 'обход каталога в pool-audio отвергается', poolAudioFile('../pool.json') === null && poolAudioFile('a/b.wav') === null);

      // 5. compose_spec с несуществующим сэмплом честно отказывает.
      const missing = await runTool('compose_spec', { prompt: 'бит', sampleId: 'нет-такого-в-пуле' }, {});
      check('missing', 'несуществующий sampleId — честный отказ', missing.ok === false && String(missing.reason).includes('не найден'));

      // 6. Рендер: синтезированный сэмпл пула СЛЫШЕН в событиях.
      mkdirSync(POOL_AUDIO_DIR, { recursive: true });
      writeFileSync(synthFile, synthWav());
      worker = await createRenderWorker();
      const sound = sampleSoundName(entry.id);
      const { result, sampleEvents, totalEvents } = await renderWithSample(worker, compileTrackSpec(checked.spec ?? spec), spec.meta.bpm, entry.id, sound);
      check('audible', 'сэмпл пула звучит в рендере', sampleEvents > 0, `${sampleEvents} событий сэмпла из ${totalEvents}`);
      check('l0', 'рендер без клиппинга', result.report?.clipCount === 0 && result.report?.truePeakDbtp <= 0, `true peak ${result.report?.truePeakDbtp?.toFixed(2)} dBTP, клиппинг ${result.report?.clipCount}`);
      check('fingerprint', 'паспорт рендера знает о сэмплах пула', JSON.stringify(result.fingerprint.pool_samples ?? []).includes(sound));
    } else {
      const keyPresent = Boolean(String(process.env.FREESOUND_API_KEY ?? '').trim());
      if (!keyPresent) {
        check('key', 'FREESOUND_API_KEY задан', false, 'живой режим без ключа не проходит — это честно');
        return finish();
      }

      // 1. Живой поиск: только свободные лицензии.
      let t = Date.now();
      const search = await runTool('freesound_search', { query: QUERY, license: 'cc0', durationMax: 10, numResults: 5 }, { env: process.env });
      const licensesOk = (search.results ?? []).every((r) => r.licenseId === 'cc0' || r.licenseId === 'cc-by');
      check('search', 'живой поиск Freesound', search.ok === true && search.results?.length > 0 && licensesOk, `${search.results?.length ?? 0} результатов за ${((Date.now() - t) / 1000).toFixed(1)} с, отклонено ${search.filteredOut ?? 0}`);
      if (!search.ok) return finish();
      const pick = search.results.find((r) => r.previewUrl);
      if (!pick) {
        check('preview', 'есть результат с превью', false);
        return finish();
      }

      // 2. Паспорт: скачивание + измерение + пул.
      t = Date.now();
      const pass = await runTool('sample_passport', {
        id: String(pick.id), previewUrl: pick.previewUrl, name: pick.name,
        author: pick.username, url: pick.url, license: pick.license, licenseId: pick.licenseId,
      }, { env: process.env });
      const p = pass.passport ?? {};
      check('passport', 'скачивание и паспорт звука', pass.ok === true && p.durationS > 0 && Number.isFinite(p.spectral?.centroidHz), `${p.durationS} с, центроид ${p.spectral?.centroidHz} Гц, ${((Date.now() - t) / 1000).toFixed(1)} с`);
      if (!pass.ok) return finish();

      // 3. Лицензия и атрибуция в записи пула.
      const entry = getFromPool(String(pick.id));
      check('license', 'лицензия и атрибуция в пуле', Boolean(entry?.licenseId) && Boolean(entry?.attribution), entry?.attribution);

      // 4. План вокруг паспорта (LLM — как повезёт, деградация честная).
      t = Date.now();
      const build = await buildTrack({
        prompt: `сделай бит вокруг звука «${pick.name}»`,
        seed: 7,
        completeChat,
        sampleEntry: entry,
      });
      const hunter = build.spec?.parts?.roles?.HUNTER_1;
      check('plan', 'план вокруг паспорта собран', Boolean(hunter) && hunter.sound === sampleSoundName(pick.id), `fallback=${build.usedFallback}, ${((Date.now() - t) / 1000).toFixed(1)} с`);
      check('llm', 'LLM-шаг композитора', build.usedFallback ? 'no-data' : true, build.usedFallback ? 'провайдер недоступен — план из библиотеки (честная деградация)' : `модель ответила, попыток ${build.attempts}`);
      check('measured', 'измеренные признаки применены или честно «нет данных»', build.sample !== null, JSON.stringify(build.sample));

      // 5. Компиляция и рендер: сэмпл СЛЫШЕН.
      const sound = sampleSoundName(pick.id);
      check('compile', 'код содержит сэмпл пула', String(build.compiled?.code ?? '').includes(sound));
      worker = await createRenderWorker();
      t = Date.now();
      const { result, sampleEvents, totalEvents } = await renderWithSample(worker, build.compiled.code, build.spec.meta.bpm, String(pick.id), sound);
      check('audible', 'найденный сэмпл звучит в рендере', sampleEvents > 0, `${sampleEvents} событий из ${totalEvents}, рендер ${((Date.now() - t) / 1000).toFixed(1)} с`);
      check('l0', 'рендер без клиппинга', result.report?.clipCount === 0 && result.report?.truePeakDbtp <= 0, `true peak ${result.report?.truePeakDbtp?.toFixed(2)} dBTP, LUFS-I ${result.report?.lufsI?.toFixed(1)}`);

      // 6. Реестр лицензий видит скачанный сэмпл.
      const registry = poolLicenseRegistry();
      check('registry', 'реестр лицензий пула содержит сэмпл', Boolean(registry.samples?.[String(pick.id)]), `всего в пуле: ${registry.totals.samples}`);

      // 7. Бюджет гейта: ≤3 мин.
      check('budget', `end-to-end ≤${BUDGET_SECONDS} с`, seconds() <= BUDGET_SECONDS, `${seconds().toFixed(1)} с`);
    }
  } catch (err) {
    check('crash', 'цепочка не упала', false, String(err?.message || err));
  } finally {
    if (worker) await worker.close().catch(() => {});
    if (existsSync(synthFile)) unlinkSync(synthFile);
  }
  return finish();

  async function finish() {
    const failed = checks.filter((c) => c.ok === false).length;
    const noData = checks.filter((c) => c.ok === 'no-data').length;
    const passed = checks.filter((c) => c.ok === true).length;
    const report = {
      gate: 'E',
      mode: LIVE ? 'live' : 'offline',
      date: new Date().toISOString(),
      query: LIVE ? QUERY : null,
      wallSeconds: Number(seconds().toFixed(1)),
      budgetSeconds: BUDGET_SECONDS,
      passed,
      failed,
      noData,
      checks,
      machine: { platform: process.platform, cpus: os.cpus().length, node: process.version },
    };
    const outFile = path.join(ROOT, 'docs', 'evidence', 'agent', LIVE ? 'gate-e-live.json' : 'gate-e.json');
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nИТОГ: ${passed}/${checks.length} зелёных, ${noData} «нет данных», ${failed} провалов; ${seconds().toFixed(1)} с`);
    console.log(`Отчёт: ${path.relative(ROOT, outFile)}`);
    process.exit(failed ? 1 : 0);
  }
}

main();