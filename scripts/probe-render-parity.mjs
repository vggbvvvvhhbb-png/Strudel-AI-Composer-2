import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';
import { decodeWav } from '../src/core/wav.js';
import { RENDER_SEED, RENDER_POLICY_VERSION } from '../src/audio/render/seed.js';

const base = process.env.PROBE_STUDIO_URL || 'http://127.0.0.1:3001';
const codes = {
  synthRoom: 'setCpm(120/4)\n$A: note("c3 e3 g3").s("sawtooth").lpf(800).room(0.3)',
  timbreRoom: 'setCpm(120/4)\n$A: note("c2 e2 g2").s("tp_contrabass_pizz_v1").room(0.3)',
};
const opts = { fromCycle: 0, toCycle: 2, sampleRate: 48000, cps: 0.5 };
const report = { date: new Date().toISOString(), node: process.version, seed: RENDER_SEED, policy: RENDER_POLICY_VERSION, cases: [], pass: false };
let worker;
let page;
try {
  worker = await createRenderWorker();
  report.browserVersion = await worker.browser.version();
  page = await worker.browser.newPage();
  await page.goto(`${base}/studio.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.strudelStudio?.adapter), { timeout: 60_000 });
  for (const [name, code] of Object.entries(codes)) {
    const started = performance.now();
    const a = await worker.render({ code, ...opts });
    const b = await worker.render({ code, ...opts });
    const serverA = decodeWav(a.wav);
    const serverB = decodeWav(b.wav);
    const realm = await page.evaluate(async ({ code, opts }) => {
      const result = await window.strudelStudio.renderTrackOffline({ code, bars: [opts.fromCycle, opts.toCycle], sampleRate: opts.sampleRate, cps: opts.cps, runs: 1 });
      return { sampleRate: result.sampleRate, channels: result.channels.map(channel => Array.from(channel)) };
    }, { code, opts });
    assert.equal(serverA.channels.length, realm.channels.length);
    assert.equal(serverA.channels[0].length, realm.channels[0].length);
    assert.equal(serverA.sampleRate, realm.sampleRate);
    let maxAbsDiff = 0;
    let repeatDiff = 0;
    let peak = 0;
    for (let ch = 0; ch < serverA.channels.length; ch += 1) {
      for (let i = 0; i < serverA.channels[ch].length; i += 1) {
        maxAbsDiff = Math.max(maxAbsDiff, Math.abs(serverA.channels[ch][i] - realm.channels[ch][i]));
        repeatDiff = Math.max(repeatDiff, Math.abs(serverA.channels[ch][i] - serverB.channels[ch][i]));
        peak = Math.max(peak, Math.abs(serverA.channels[ch][i]));
      }
    }
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const item = { name, maxAbsDiff, repeatDiff, peak, wavIdentical: hash(a.wav) === hash(b.wav), fingerprintIdentical: JSON.stringify(a.fingerprint) === JSON.stringify(b.fingerprint), seed: a.fingerprint.seed, policy: a.fingerprint.render_policy, ms: Math.round(performance.now() - started) };
    report.cases.push(item);
    assert.ok(peak > 1e-4, 'пустой рендер');
    assert.ok(maxAbsDiff <= 1e-4, `${name}: D-104 maxAbsDiff=${maxAbsDiff}`);
    assert.ok(repeatDiff <= 1e-4 && item.fingerprintIdentical, `${name}: серверный повтор нарушает допуск D-104`);
    assert.equal(item.seed, RENDER_SEED);
    assert.equal(item.policy, RENDER_POLICY_VERSION);
  }
  report.pass = true;
} catch (error) {
  report.error = String(error.message);
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => {});
  await worker?.close().catch(() => {});
  const evidence = resolve('docs/evidence/render-realm/server-parity.json');
  await writeFile(evidence, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence }, null, 2));
}
