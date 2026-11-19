import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createDaemon } from '../local/daemon.mjs';
import { createDaemonClient } from '../local/client.mjs';
import { runNativeAgent } from '../server/agent/native.js';
import { SessionGuard } from '../server/agent/guard.js';
import { MODES } from '../server/agent/modes.js';
import { fallbackSpec } from '../server/music/compose/pipeline.js';
import { encodeWav } from '../src/core/wav.js';
import { runStrudel } from '../server/music/strudel-runtime.mjs';

const outputIndex = process.argv.indexOf('--out');
const evidence = resolve(outputIndex < 0 ? 'docs/evidence/agent/reference-probe.json' : process.argv[outputIndex + 1] ?? '');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error('--out требует путь к evidence JSON');
const workspace = await mkdtemp(resolve('.scratch/reference-probe-'));
const token = randomBytes(24).toString('hex');
const report = { date: new Date().toISOString(), node: process.version, source: 'own synthetic signal, not a music-quality benchmark', checks: {}, stages: [], model: 'scripted mock, real tools and Python/Demucs' };
let daemon;
try {
  daemon = await createDaemon({ token, stateDir: join(workspace, 'state'), log: () => {} });
  await new Promise(resolve => daemon.server.listen(0, '127.0.0.1', resolve));
  const env = { LOCAL_DAEMON_URL: `http://127.0.0.1:${daemon.server.address().port}`, LOCAL_DAEMON_TOKEN: token };
  const client = createDaemonClient({ baseUrl: env.LOCAL_DAEMON_URL, token });
  const health = await client.health();
  report.analysis = health.analysis;
  assert.equal(health.analysis.available, true, 'Python недоступен');
  assert.equal(health.analysis.demucs_available, true, 'Demucs недоступен');

  const sr = 22050;
  const seconds = 12;
  const signal = Float64Array.from({ length: sr * seconds }, (_, i) => {
    const t = i / sr;
    const kickTime = t % 0.5;
    return 0.12 * Math.sin(2 * Math.PI * 130.8128 * t) + 0.45 * Math.exp(-kickTime * 55) * Math.sin(2 * Math.PI * 70 * kickTime);
  });
  const input = join(workspace, 'own-reference.wav');
  await writeFile(input, Buffer.from(encodeWav([signal, signal], sr)));
  const source = await client.submit('analyze', { path: input });
  await client.wait(source.id);
  let round = 0;
  let guidePresent = false;
  let referencePresent = false;
  let final;
  const started = performance.now();
  for await (const event of runNativeAgent({
    prompt: `Сделай techno бит, референс: ${source.id}`,
    mode: MODES.composer,
    env,
    guard: new SessionGuard({ maxSteps: 8, maxToolCalls: 8, maxWallMs: 420_000 }),
    completeChatTools: async () => {
      const call = [
        { name: 'analyze_reference', arguments: { taskId: source.id } },
        { name: 'compose_spec', arguments: { prompt: 'techno' } },
        { name: 'compile', arguments: {} },
      ][round++];
      return call ? { content: null, toolCalls: [{ id: `probe-${round}`, ...call }] } : { content: 'Ориентир, не клон.', toolCalls: [] };
    },
    completeChat: async ({ messages }) => {
      referencePresent = messages[0].content.includes('Измеренный локальный аудиореференс');
      guidePresent = messages[0].content.includes('edu-guide-techno');
      const spec = fallbackSpec('techno', 1);
      spec.parts.roles.bass.instrumentId = 'tp-contrabass-pizz-v1';
      return JSON.stringify(spec);
    },
  })) {
    if (event.type === 'tool_end') report.stages.push({ tool: event.id, ok: event.ok, ms: event.ms, reason: event.reason });
    if (event.type === 'native_result') final = event;
  }
  report.wallMs = Math.round(performance.now() - started);
  report.fallbackComposed = Boolean(final?.bag?.spec);
  const failed = daemon.queue.list().find(task => task.type === 'analyze_reference' && task.state === 'error');
  if (failed) {
    report.processFailureCode = /кодом (\d+)/.exec(failed.error ?? '')?.[1] ?? null;
    report.resourceRefusal = /commit memory Windows/.test(failed.error ?? '');
    report.availableCommitMb = Number(/commit memory Windows (\d+) МБ/.exec(failed.error ?? '')?.[1]) || null;
  }
  assert.ok(report.stages.every(s => s.ok), JSON.stringify(report.stages));
  assert.ok(final.bag.reference?.passport);
  assert.ok(referencePresent && guidePresent);
  const run = await runStrudel(final.bag.code, { cycles: 4 });
  assert.equal(run.ok, true, run.error);
  assert.ok(Object.values(run.parts).some(events => events.length > 0));
  const passport = final.bag.reference.passport;
  report.passport = passport;
  report.candidates = Object.fromEntries(Object.entries(final.bag.reference.candidates).map(([role, candidates]) => [role, candidates.map(c => ({ id: c.id, score: c.score, reasons: c.reasons }))]));
  report.checks = { realDemucsPassport: true, registeredSourceOnly: true, referenceInComposePrompt: referencePresent, genreGuidePreserved: guidePresent, compiledEvents: true, noReferenceAudioInComposition: true };
  report.bpm = final.bag.spec.meta.bpm;
  report.instrumentId = final.bag.spec.parts.roles.bass.instrumentId;
  report.code = final.bag.code;
  report.events = Object.values(run.parts).reduce((sum, events) => sum + events.length, 0);
  const serialized = JSON.stringify(passport);
  assert.ok(!serialized.includes(workspace) && !serialized.includes(token), 'паспорт раскрывает путь или токен');
} catch (error) {
  report.error = String(error.message);
  process.exitCode = 1;
} finally {
  if (daemon) {
    await daemon.registry.close();
    await new Promise(resolve => daemon.server.close(resolve));
  }
  await writeFile(evidence, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, stages: report.stages, wallMs: report.wallMs, error: report.error ?? null, evidence }, null, 2));
  await rm(workspace, { recursive: true, force: true });
}
