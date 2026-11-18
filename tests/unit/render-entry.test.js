// Оба entrypoint используют общий prepare, установленный до init/evaluate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ trace: [], handler: null, prepare: vi.fn(), adapter: null }));
vi.mock('../../src/audio/render/seed.js', () => ({
  installRenderDeterminism: vi.fn(() => {
    state.trace.push('install');
    return { prepare: state.prepare };
  }),
}));
vi.mock('../../src/audio/engine/adapter.js', () => ({ createEngineAdapter: () => state.adapter }));
vi.mock('../../src/audio/engine/strudel-api.js', () => ({ strudelApi: { samples: async () => {} } }));
vi.mock('../../src/audio/render/offline.js', () => ({
  audioBufferToChannels: () => [new Float64Array([0.1, 0.2])],
}));
vi.mock('../../src/audio/metrics-report.js', () => ({ buildMetricsReport: () => ({ engineVersion: 'fake' }) }));
vi.mock('../../src/sample-banks.js', () => ({ SAMPLE_SETS: ['bank-a', 'bank-b'] }));
vi.mock('../../src/timbre/register.js', () => ({ ensureTimbreForCode: async () => ({ ok: true }) }));
vi.mock('../../src/pianoroll.js', () => ({ installJadeVisuals: () => {} }));

beforeEach(() => {
  vi.resetModules();
  state.trace.length = 0;
  state.handler = null;
  state.prepare.mockReset();
  state.prepare.mockImplementation(async () => { state.trace.push('prepare'); });
  state.adapter = {
    init: vi.fn(async () => { state.trace.push('init'); }),
    loadSamples: vi.fn(async () => ({ ok: true, failed: 0 })),
    patternFromCode: vi.fn(async () => {
      state.trace.push('evaluate');
      return { queryArc: () => [] };
    }),
    renderOffline: vi.fn(async (args) => {
      await args.prepare();
      state.trace.push('startRendering');
      return { sampleRate: 48000 };
    }),
    renderCodeOffline: vi.fn(async (args) => {
      await args.prepare();
      state.trace.push('startRendering');
      return { sampleRate: 48000 };
    }),
  };
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    resume() { return Promise.resolve(); }
  });
  const parent = { postMessage: vi.fn() };
  vi.stubGlobal('window', {
    strudel: {}, parent, location: { origin: 'http://isolated.test' },
    addEventListener: (_type, handler) => { state.handler = handler; },
  });
});
afterEach(() => vi.unstubAllGlobals());

const CODE = 'note("c3").s("sine").room(0.5)';

describe('render entries: shared determinism policy', () => {
  it('server page устанавливает policy до init/evaluate и передаёт prepare', async () => {
    await import('../../server/deepdive/render/browser-entry.js');
    await window.__renderTwin.init();
    const result = await window.__renderTwin.render({ code: CODE, wantWav: false, wantEvents: false });
    expect(result.ok).toBe(true);
    expect(state.trace).toEqual(['install', 'init', 'evaluate', 'prepare', 'startRendering']);
    expect(state.adapter.patternFromCode).toHaveBeenCalledTimes(1);
    expect(state.adapter.renderCodeOffline).not.toHaveBeenCalled();
    const pattern = (await state.adapter.patternFromCode.mock.results[0].value);
    expect(state.adapter.renderOffline.mock.calls[0][0]).toMatchObject({ pattern, prepare: state.prepare });
    expect(state.adapter.loadSamples).toHaveBeenCalledWith({ sources: ['bank-a', 'bank-b'] });
  });

  it('server page не продолжает рендер при ошибке prepare', async () => {
    await import('../../server/deepdive/render/browser-entry.js');
    await window.__renderTwin.init();
    state.prepare.mockRejectedValue(new Error('IR timeout — рендер недостоверен'));
    await expect(window.__renderTwin.render({ code: CODE })).rejects.toThrow('рендер недостоверен');
    expect(state.trace).not.toContain('startRendering');
  });

  it('iframe realm использует тот же prepare и передаёт его ошибку родителю', async () => {
    await import('../../src/render-realm.js');
    await state.handler({ source: window.parent, data: { type: 'render', id: 'one', code: CODE } });
    expect(state.trace).toEqual(['install', 'init', 'prepare', 'startRendering']);
    expect(state.adapter.renderCodeOffline.mock.calls[0][0].prepare).toBe(state.prepare);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'result', id: 'one', sampleRate: 48000 }),
      'http://isolated.test', expect.any(Array),
    );
    state.prepare.mockRejectedValue(new Error('IR timeout — рендер недостоверен'));
    await state.handler({ source: window.parent, data: { type: 'render', id: 'two', code: CODE } });
    expect(window.parent.postMessage).toHaveBeenLastCalledWith(
      { type: 'error', id: 'two', message: 'IR timeout — рендер недостоверен' },
      'http://isolated.test', [],
    );
  });
});
