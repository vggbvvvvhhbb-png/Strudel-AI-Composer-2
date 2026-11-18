// Зонд фикса E-020 (D-143): офлайн-рендер изолирован в свежем iframe-realm.
//
//   npm run build && node scripts/probe-render-realm.mjs
//
// Проверяет на настоящем Chromium:
//   1. E-020-воспроизводитель через НОВЫЙ путь: 3 быстрых последовательных
//      renderTrackOffline кода с эффектами — все ok (старый путь падал 2/3).
//   2. Детерминизм: два свежих realm на коде с .room() дают идентичный звук
//      (зерно PRNG фиксировано — IR реверберации больше не случайна, E-022).
//   3. Инвариант D-104 между путями: код без room, adapter vs realm —
//      maxAbsDiff ≤ 1e-4, паспорт engineVersion идентичен.
//   4. Живой трек не затронут: позиция воспроизведения растёт после рендера,
//      хвост движка на месте (старый путь пересоздавал контроллер).
//   5. Старый путь всё ещё несёт дефект (честное измерение, не регрессия).
//   6. Пресет Timbre звучит в realm-рендере (не тишина).
// Evidence: docs/evidence/render-realm/probe.json.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { ENGINE_VERSION_STRING } from '../src/audio/engine-version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PROBE_PORT || 3126);
const BASE = `http://127.0.0.1:${PORT}`;

const BROWSER_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), MOCK_LLM: '1', NODE_ENV: 'test' },
  stdio: 'ignore',
});
const waitServer = async () => {
  for (let i = 0; i < 120; i += 1) {
    try { const res = await fetch(`${BASE}/api/health`); if (res.ok) return; } catch { /* поднимается */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('сервер не поднялся');
};

let browser;
const evidence = { generatedAt: new Date().toISOString(), probe: 'render-realm (E-020/D-143)' };
try {
  if (!existsSync(path.join(ROOT, 'dist', 'render-realm.html'))) throw new Error('нет сборки: npm run build');
  await waitServer();
  browser = await chromium.launch({
    executablePath: BROWSER_PATHS.find(existsSync),
    args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.warn('[pageerror]', String(err).slice(0, 160)));
  await page.goto(`${BASE}/studio.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.strudelStudio?.adapter), { timeout: 120_000 });

  const catalog = await (await fetch(`${BASE}/api/timbre/catalog`)).json();
  const alias = catalog.presets?.[0]?.strudelAlias;
  if (!alias) throw new Error('каталог Timbre пуст — нечем проверить пресет');

  const result = await page.evaluate(async ({ timbreAlias, engineVersion }) => {
    const EFFECT_CODE = 'setCpm(120/4)\n$A: note("c3 e3 g3").s("sawtooth").lpf(800).room(0.3)._pianoroll()';
    // Без room: IR реверберации в живом адаптере случайна (E-022), поэтому
    // межпутевое сравнение D-104 честнее делать на коде без реверберации.
    const CLEAN_CODE = 'setCpm(120/4)\n$A: note("c3 e3 g3").s("sawtooth").lpf(800)';
    const LIVE_CODE = 'setCpm(120/4)\n$B: note("c4").s("sine")';
    const opts = { fromCycle: 0, toCycle: 4, sampleRate: 48000, cps: 0.5 };
    const channelsOf = (buffer) => {
      const out = [];
      for (let c = 0; c < buffer.numberOfChannels; c += 1) out.push(Float64Array.from(buffer.getChannelData(c)));
      return out;
    };
    const maxAbsDiff = (a, b) => {
      let max = 0;
      const frames = Math.min(a[0].length, b[0].length);
      for (let c = 0; c < Math.min(a.length, b.length); c += 1) {
        for (let i = 0; i < frames; i += 1) max = Math.max(max, Math.abs(a[c][i] - b[c][i]));
      }
      return max;
    };
    const realmRender = (code) => window.strudelStudio.renderTrackOffline({ code, bars: [0, 4], sampleRate: 48000, cps: 0.5, runs: 1 });
    const out = {};

    // 1. Одиночный adapter-рендер чистого кода на свежей странице — эталон.
    const t0 = performance.now();
    const baseBuffer = await window.strudelStudio.adapter.renderCodeOffline({ code: CLEAN_CODE, ...opts });
    out.adapterBaseline = { ok: true, ms: Math.round(performance.now() - t0) };
    const baseChannels = channelsOf(baseBuffer);

    // 2. Три быстрых последовательных realm-рендера с эффектами — E-020.
    out.realmRenders = [];
    const realmChannelSets = [];
    let realmReport = null;
    for (let i = 0; i < 3; i += 1) {
      const t = performance.now();
      try {
        const r = await realmRender(EFFECT_CODE);
        out.realmRenders.push({ i, ok: true, ms: Math.round(performance.now() - t), lufsI: r.report?.lufsI ?? null });
        realmChannelSets.push(r.channels);
        if (i === 0) realmReport = r.report;
      } catch (err) {
        out.realmRenders.push({ i, ok: false, ms: Math.round(performance.now() - t), error: String(err?.message || err).slice(0, 120) });
      }
    }

    // 3. Детерминизм realm: код с room, два свежих realm — идентичный звук
    //    (зерно PRNG фиксировано + ожидание IR, D-143/E-022).
    out.realmDeterminism = realmChannelSets.length >= 2 ? {
      maxAbsDiff: maxAbsDiff(realmChannelSets[0], realmChannelSets[1]),
    } : null;

    // 4. Инвариант D-104 между путями: чистый код, adapter vs realm.
    let cleanRealm = null;
    try {
      cleanRealm = await realmRender(CLEAN_CODE);
    } catch (err) {
      out.cleanRealmError = String(err?.message || err).slice(0, 120);
    }
    out.d104 = cleanRealm ? {
      maxAbsDiff: maxAbsDiff(baseChannels, cleanRealm.channels),
      engineVersionMatch: realmReport?.engineVersion === engineVersion,
      engineVersion: realmReport?.engineVersion ?? null,
      renderMode: realmReport?.renderMode ?? null,
    } : null;

    // 5. Живой трек не затронут realm-рендером.
    await window.strudelStudio.adapter.evaluate(LIVE_CODE);
    await new Promise((r) => setTimeout(r, 400));
    const posBefore = window.strudelStudio.adapter.position();
    await realmRender(EFFECT_CODE);
    await new Promise((r) => setTimeout(r, 400));
    const posAfter = window.strudelStudio.adapter.position();
    out.liveIntact = {
      cyclesBefore: posBefore.cycles,
      cyclesAfter: posAfter.cycles,
      advancing: posAfter.cycles > posBefore.cycles,
      tailPresent: Boolean(window.strudelStudio.adapter.outputNode()),
    };
    window.strudelStudio.adapter.stop();

    // 6. Старый путь всё ещё несёт дефект: два быстрых adapter-рендера подряд.
    out.legacyPath = { renders: [] };
    for (let i = 0; i < 2; i += 1) {
      try {
        await window.strudelStudio.adapter.renderCodeOffline({ code: EFFECT_CODE, ...opts });
        out.legacyPath.renders.push({ i, ok: true });
      } catch (err) {
        out.legacyPath.renders.push({ i, ok: false, error: String(err?.message || err).slice(0, 120) });
      }
    }
    out.legacyPath.defectConfirmed = out.legacyPath.renders.some((r) => !r.ok);

    // 7. Пресет Timbre звучит в realm-рендере.
    const timbreCode = `setCpm(120/4)\n$T: note("c3 e3 g3 c4").s("${timbreAlias}")`;
    try {
      const r = await realmRender(timbreCode);
      const lufs = r.report?.lufsI ?? null;
      out.timbre = { ok: true, alias: timbreAlias, lufsI: lufs, audible: Number.isFinite(lufs) && lufs > -60 };
    } catch (err) {
      out.timbre = { ok: false, alias: timbreAlias, error: String(err?.message || err).slice(0, 160) };
    }
    return out;
  }, { timbreAlias: alias, engineVersion: ENGINE_VERSION_STRING });

  evidence.result = result;
  const realmOk = result.realmRenders.every((r) => r.ok);
  const determinismOk = result.realmDeterminism && result.realmDeterminism.maxAbsDiff <= 1e-4;
  const d104Ok = result.d104 && result.d104.maxAbsDiff <= 1e-4 && result.d104.engineVersionMatch;
  const liveOk = result.liveIntact.advancing && result.liveIntact.tailPresent;
  const timbreOk = result.timbre.ok && result.timbre.audible;
  evidence.gate = {
    realm3of3: realmOk,
    realmDeterminism: Boolean(determinismOk),
    d104: Boolean(d104Ok),
    liveIntact: liveOk,
    timbreAudible: timbreOk,
    legacyDefectConfirmed: result.legacyPath.defectConfirmed,
  };
  evidence.pass = realmOk && determinismOk && d104Ok && liveOk && timbreOk;

  const dir = path.join(ROOT, 'docs', 'evidence', 'render-realm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'probe.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence.gate, null, 1));
  console.log(`d104 maxAbsDiff=${result.d104?.maxAbsDiff}, realmDeterminism maxAbsDiff=${result.realmDeterminism?.maxAbsDiff}, realm ms=${result.realmRenders.map((r) => r.ms).join('/')}, adapter ms=${result.adapterBaseline.ms}`);
  console.log(evidence.pass ? '\nЗОНД ЗЕЛЁНЫЙ: E-020 закрыт realm-изоляцией.' : '\nЗОНД КРАСНЫЙ — см. probe.json.');
  process.exitCode = evidence.pass ? 0 : 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}