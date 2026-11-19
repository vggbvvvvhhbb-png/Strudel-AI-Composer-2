// Реальный handler и токенизированная очередь, без HTTP/Python/Chromium/LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemon } from '../../local/daemon.mjs';

let stateDir;
let daemon;
let referenceAnalyzer;
let analysisProbe;
const ownerPath = path.resolve('owner-registered-reference.wav');
const attackerPath = path.resolve('request-path-must-never-be-used.wav');

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'local-p5-gating-'));
  analysisProbe = vi.fn(async () => ({ available: true, details: { demucs_available: true } }));
  referenceAnalyzer = vi.fn(async (_file, { progress }) => {
    progress({ stage: 'analyze', message: 'test progress' });
    return { durationS: 1, stems: {}, caveats: ['Ориентир не клон'] };
  });
  daemon = await createDaemon({
    token: 'reference-test-owner-token', stateDir, log: () => {}, analysisProbe, referenceAnalyzer,
    renderFactory: async () => ({
      render: async () => ({ wav: Buffer.from('test-wav'), fingerprint: 'test', durationS: 1 }),
      close: async () => {},
    }),
  });
  // Регистрация владельцем уже существует; здесь мокается лишь тяжёлая работа
  // исходных analyze/passport задач. Новый handler работает без подмены.
  daemon.registry.tasks.analyze = vi.fn(async () => ({ ok: true }));
  daemon.registry.tasks.passport = vi.fn(async () => ({ ok: true, passport: {} }));
});

afterEach(async () => {
  await daemon.registry.close();
  await rm(stateDir, { recursive: true, force: true });
});

// Ждём именно task_done/task_error, а не state: журнал дописан до события.
async function run(type, payload) {
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const previous = daemon.queue.onEvent;
  daemon.queue.onEvent = (event) => {
    previous(event);
    if (event.type === 'task_done' || event.type === 'task_error') finish(event.task);
  };
  try {
    await daemon.queue.enqueue(type, payload);
    return await finished;
  } finally {
    daemon.queue.onEvent = previous;
  }
}

async function reference(payload, id = 'reference-task') {
  // То же место входа, которое DurableQueue вызывает перед runner.
  return daemon.queue.handler({ id, type: 'analyze_reference', payload }, { progress: vi.fn() });
}

describe('analyze_reference sourceTaskId gating before runner', () => {
  it.each([{}, { path: attackerPath }, { sourceTaskId: '' }, { sourceTaskId: 123 }])('rejects missing/invalid sourceTaskId: %j', async (payload) => {
    await expect(reference(payload)).rejects.toThrow(/sourceTaskId/);
    expect(analysisProbe).not.toHaveBeenCalled();
    expect(referenceAnalyzer).not.toHaveBeenCalled();
  });

  it('unknown ID cannot fall back to a client path', async () => {
    await expect(reference({ sourceTaskId: 'unknown', path: attackerPath })).rejects.toThrow(/не найден/);
    expect(referenceAnalyzer).not.toHaveBeenCalled();
    expect(analysisProbe).not.toHaveBeenCalled();
  });

  it.each(['error', 'running', 'queued', 'failed'])('rejects a registered source with state %s', async (state) => {
    const source = await run('analyze', { path: ownerPath });
    daemon.queue.tasks.get(source.id).state = state;
    await expect(reference({ sourceTaskId: source.id, path: attackerPath })).rejects.toThrow(/done/);
    expect(referenceAnalyzer).not.toHaveBeenCalled();
    expect(analysisProbe).not.toHaveBeenCalled();
  });

  it.each(['separate', 'analyze_stems', 'analyze_reference', 'unsupported'])('rejects a done source of type %s', async (type) => {
    const source = await run('analyze', { path: ownerPath });
    daemon.queue.tasks.get(source.id).type = type;
    await expect(reference({ sourceTaskId: source.id, path: attackerPath })).rejects.toThrow(/тип analyze, passport или render/);
    expect(referenceAnalyzer).not.toHaveBeenCalled();
    expect(analysisProbe).not.toHaveBeenCalled();
  });

  it.each(['analyze', 'passport'])('done %s uses only registered payload.path and task-specific outDir', async (type) => {
    const source = await run(type, { path: ownerPath });
    // get() публичен и не раскрывает payload; handler использует внутреннюю запись.
    expect(daemon.queue.get(source.id).payload).toBeUndefined();
    const result = await reference({ sourceTaskId: source.id, path: attackerPath, outDir: attackerPath, model: 'other-model' }, 'reference-001');
    expect(result).toMatchObject({ ok: true, passport: { durationS: 1 } });
    expect(referenceAnalyzer).toHaveBeenCalledWith(ownerPath, {
      outDir: path.join(stateDir, 'references', 'reference-001', 'stems'),
      progress: expect.any(Function), signal: undefined,
    });
    expect(analysisProbe).toHaveBeenCalledOnce();
  });

  it('done render uses result.wavPath, never its payload.path or request.path', async () => {
    const source = await run('render', { code: 'test-render', path: attackerPath });
    expect(source.state).toBe('done');
    const result = await reference({ sourceTaskId: source.id, path: attackerPath });
    expect(result.ok).toBe(true);
    expect(referenceAnalyzer.mock.calls[0][0]).toBe(source.result.wavPath);
    expect(source.result.wavPath).toBe(path.resolve(stateDir, 'renders', `${source.id}.wav`));
    expect(referenceAnalyzer.mock.calls[0][0]).not.toBe(attackerPath);
  });

  it.each(['analyze', 'passport', 'render'])('done %s without a registered file refuses request.path', async (type) => {
    const source = await run(type, type === 'render' ? { code: 'test-render' } : {});
    if (type === 'render') daemon.queue.tasks.get(source.id).result.wavPath = null;
    await expect(reference({ sourceTaskId: source.id, path: attackerPath })).rejects.toThrow(/нет зарегистрированного WAV/);
    expect(referenceAnalyzer).not.toHaveBeenCalled();
    expect(analysisProbe).not.toHaveBeenCalled();
  });

  it('registered paths and fixed separation directories survive queue execution; progress is published', async () => {
    const source = await run('analyze', { path: ownerPath });
    const events = [];
    const previous = daemon.queue.onEvent;
    daemon.queue.onEvent = (event) => { events.push(event); previous(event); };
    const first = await run('analyze_reference', { sourceTaskId: source.id, path: attackerPath, outDir: attackerPath });
    const second = await run('analyze_reference', { sourceTaskId: source.id });
    expect(first.state).toBe('done');
    expect(second.state).toBe('done');
    expect(referenceAnalyzer.mock.calls.map(([file]) => file)).toEqual([ownerPath, ownerPath]);
    expect(referenceAnalyzer.mock.calls.map(([, options]) => options.outDir)).toEqual([
      path.join(stateDir, 'references', first.id, 'stems'), path.join(stateDir, 'references', second.id, 'stems'),
    ]);
    expect(events).toContainEqual(expect.objectContaining({ id: first.id, type: 'progress', stage: 'analyze' }));
    // Клиентский путь не перезаписывает зарегистрированный путь источника.
    expect(daemon.queue.tasks.get(source.id).payload.path).toBe(ownerPath);
  });

  it('invalid source fails in the queue rather than becoming an empty success', async () => {
    const result = await run('analyze_reference', { path: attackerPath });
    expect(result.state).toBe('error');
    expect(result.error).toMatch(/sourceTaskId/);
    expect(referenceAnalyzer).not.toHaveBeenCalled();
  });
});
