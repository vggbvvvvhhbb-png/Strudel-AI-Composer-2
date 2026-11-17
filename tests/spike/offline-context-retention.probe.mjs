#!/usr/bin/env node
// Воспроизводитель E-020 / D-133: быстрые последовательные офлайн-рендеры
// в одной странице ловят cross-context connect (удержание узлов superdough
// 1.3.0). Запуск: npm run build && node tests/spike/offline-context-retention.probe.mjs
//
// Ожидание на ИСХОДНОМ адаптере: 1-й рендер ok, 2-й и 3-й падают с
// InvalidAccessError «different audio context». Пауза между рендерами
// (300 мс / 2 с) не помогает — удержание сильное. Длинные рендеры и
// человеческий темп суждения дают GC очистить пул, поэтому в реальном
// использовании дефект не проявлялся.
//
// Трейс: каждый createBiquadFilter помечается идентификатором и стеком
// создания; перехват AudioNode.connect логирует контексты при ошибке.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PROBE_PORT || 3125);
const BASE = `http://127.0.0.1:${PORT}`;
const GAP_MS = Number(process.env.GAP_MS || 0);

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
try {
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('нет сборки: npm run build');
  await waitServer();
  browser = await chromium.launch({
    executablePath: BROWSER_PATHS.find(existsSync),
    args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__filters = {};
    window.__bad = [];
    let fid = 0; let cid = 0;
    const OrigOffline = window.OfflineAudioContext;
    window.OfflineAudioContext = class extends OrigOffline {
      constructor(...a) { super(...a); this.__id = `off${++cid}`; }
    };
    const origCreate = BaseAudioContext.prototype.createBiquadFilter;
    BaseAudioContext.prototype.createBiquadFilter = function (...a) {
      const node = origCreate.apply(this, a);
      node.__fid = `f${++fid}`;
      window.__filters[node.__fid] = { ctx: this.__id ?? 'live' };
      return node;
    };
    const origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      try { return origConnect.call(this, dest, ...rest); } catch (e) {
        if (dest?.__fid) window.__bad.push({ fid: dest.__fid, born: window.__filters[dest.__fid]?.ctx, now: this.context?.__id ?? 'live' });
        throw e;
      }
    };
  });
  await page.goto(`${BASE}/tinder.html`, { waitUntil: 'domcontentloaded' });
  await page.click('#btn-start');
  await page.waitForFunction(() => /Слушайте|Не удалось/.test(document.getElementById('status')?.textContent ?? ''), { timeout: 120_000 });

  const result = await page.evaluate(async (gap) => {
    const code = 'setCpm(120/4)\n$A: note("c3 e3 g3").s("sawtooth").lpf(800).room(0.3)._pianoroll()';
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      window.__bad.length = 0;
      try {
        await window.strudelStudio.adapter.renderCodeOffline({ code, fromCycle: 0, toCycle: 4, sampleRate: 48000, cps: 0.5 });
        out.push({ i, ok: true });
      } catch (err) {
        out.push({ i, ok: false, error: String(err?.message || err).slice(0, 70), staleFrom: window.__bad.slice(0, 2) });
      }
      if (gap) await new Promise((r) => setTimeout(r, gap));
    }
    return out;
  }, GAP_MS);
  console.log(JSON.stringify(result, null, 1));
  const failed = result.filter((r) => !r.ok).length;
  console.log(`\nE-020: ${failed}/3 рендеров упали (ожидаемо 2/3 на исходном адаптере, GAP_MS=${GAP_MS}).`);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}