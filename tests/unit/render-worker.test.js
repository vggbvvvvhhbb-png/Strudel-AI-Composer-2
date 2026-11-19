// Lifecycle без браузера, сети, банков и live renders.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RENDER_SEED, RENDER_POLICY_VERSION } from '../../src/audio/render/seed.js';

const state = vi.hoisted(() => ({ servers: [] }));
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: () => '{}' }));
vi.mock('node:http', () => ({
  default: {
    createServer: vi.fn(() => {
      const server = {
        on: vi.fn(),
        listen: vi.fn((_port, _host, ready) => ready()),
        address: () => ({ port: 12345 }),
        close: vi.fn((done) => done?.()),
      };
      state.servers.push(server);
      return server;
    }),
  },
}));
vi.mock('../../server/samples/pool.js', () => ({ POOL_AUDIO_DIR: '/fake/pool' }));
vi.mock('../../server/samples/timbre.js', () => ({
  TIMBRE_DIR: '/fake/timbre',
  timbreAudioFile: () => null,
  loadTimbreCatalog: () => ({ presets: {} }),
}));

import { createRenderWorker } from '../../server/deepdive/render/render-worker.mjs';

function fakeBrowser(options = {}) {
  const pages = [];
  let active = 0;
  let maxActive = 0;
  const browser = {
    version: vi.fn(async () => 'fake-chromium'),
    close: vi.fn(async () => { if (options.closeError) throw new Error('browser close failed'); }),
    newPage: vi.fn(async () => {
      if (options.newPageError) throw new Error('newPage failed');
      const index = pages.length;
      active += 1;
      maxActive = Math.max(active, maxActive);
      let closed = false;
      const page = {
        on: vi.fn(),
        setDefaultTimeout: vi.fn(),
        goto: vi.fn(async () => { if (options.gotoError) throw new Error('goto failed'); }),
        waitForFunction: vi.fn(async () => { if (options.readyError) throw new Error('ready timeout'); }),
        evaluate: vi.fn(async (_fn, args) => {
          if (!args) return index === options.initErrorPage ? { ok: false, error: 'init failed' } : { ok: true };
          if (options.renderError) throw new Error('IR timeout');
          await Promise.resolve();
          return {
            ok: true, wavBase64: Buffer.from('identical fake WAV').toString('base64'),
            sampleRate: 48000, durationS: 2, renderMs: 1, events: [],
            report: { engineVersion: 'fake-engine' },
          };
        }),
        isClosed: () => closed,
        close: vi.fn(async () => {
          if (!closed) { active -= 1; closed = true; }
          if (options.pageCloseError) throw new Error('page close failed');
        }),
      };
      pages.push(page);
      return page;
    }),
  };
  const chromium = { launch: vi.fn(async () => {
    if (options.launchError) throw new Error('launch failed');
    return browser;
  }) };
  return { browser, chromium, pages, maxActive: () => maxActive };
}
const ARGS = { code: 'note("c3").s("sine").room(0.5)' };

beforeEach(() => { state.servers.length = 0; });

describe('render worker: fresh isolated page per render', () => {
  it('сохраняет worker.page, закрывает каждую page и выдаёт одинаковый реальный seed / policy', async () => {
    const fake = fakeBrowser();
    const worker = await createRenderWorker({ browser: fake, timeoutMs: 123 });
    expect(worker.page).toBe(fake.pages[0]);
    expect(worker.page.isClosed()).toBe(false);
    const a = await worker.render({ ...ARGS, poolSamples: [{ id: 'one', sound: 'pool_one' }] });
    expect(fake.pages[0].close).toHaveBeenCalledTimes(1);
    expect(fake.browser.close).not.toHaveBeenCalled();
    const b = await worker.render({ ...ARGS, poolSamples: [{ id: 'one', sound: 'pool_one' }] });
    expect(fake.chromium.launch).toHaveBeenCalledTimes(1);
    expect(fake.browser.newPage).toHaveBeenCalledTimes(2);
    expect(worker.page).toBe(fake.pages[1]);
    for (const page of fake.pages) {
      expect(page.isClosed()).toBe(true);
      expect(page.close).toHaveBeenCalledTimes(1);
      expect(page.goto).toHaveBeenCalledTimes(1);
      expect(page.setDefaultTimeout).toHaveBeenCalledWith(123);
      expect(page.evaluate).toHaveBeenCalledTimes(2); // init banks + render/warm
      expect(page.evaluate.mock.calls[1][1].poolSamples).toEqual([{ id: 'one', sound: 'pool_one' }]);
    }
    expect(a.wav).toEqual(b.wav);
    expect(a.fingerprint).toEqual(b.fingerprint);
    expect(a.fingerprint).toMatchObject({ seed: RENDER_SEED, render_policy: RENDER_POLICY_VERSION });
    expect(a.fingerprint.seed).not.toBe('deterministic-engine');
    await worker.close();
    await worker.close();
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(state.servers[0].close).toHaveBeenCalledTimes(1);
  });

  it('сериализует concurrent render и close дожидается их завершения', async () => {
    const fake = fakeBrowser();
    const worker = await createRenderWorker({ browser: fake });
    const a = worker.render(ARGS);
    const b = worker.render(ARGS);
    const close = worker.close();
    await expect(worker.render(ARGS)).rejects.toThrow('закрыт');
    await Promise.all([a, b, close]);
    expect(fake.maxActive()).toBe(1);
    expect(fake.pages).toHaveLength(2);
    expect(fake.pages.every((page) => page.isClosed())).toBe(true);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });

  it('close до первого render закрывает bootstrap page и оба ресурса', async () => {
    const fake = fakeBrowser();
    const worker = await createRenderWorker({ browser: fake });
    await worker.close();
    expect(fake.pages[0].close).toHaveBeenCalledTimes(1);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(state.servers[0].close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ launchError: true }, 'launch failed'],
    [{ newPageError: true }, 'newPage failed'],
    [{ gotoError: true }, 'goto failed'],
    [{ readyError: true }, 'ready timeout'],
    [{ initErrorPage: 0 }, 'init failed'],
  ])('ошибка bootstrap %j закрывает сервер/браузер/page', async (options, error) => {
    const fake = fakeBrowser(options);
    await expect(createRenderWorker({ browser: fake })).rejects.toThrow(error);
    expect(state.servers[0].close).toHaveBeenCalledTimes(1);
    expect(fake.browser.close).toHaveBeenCalledTimes(options.launchError ? 0 : 1);
    for (const page of fake.pages) expect(page.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ renderError: true }, 'IR timeout'],
    [{ pageCloseError: true }, 'page close failed'],
  ])('ошибка render %j закрывает page и не оставляет сирот', async (options, error) => {
    const fake = fakeBrowser(options);
    const worker = await createRenderWorker({ browser: fake });
    await expect(worker.render(ARGS)).rejects.toThrow(error);
    expect(fake.pages[0].close).toHaveBeenCalledTimes(1);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(state.servers[0].close).toHaveBeenCalledTimes(1);
    await worker.close();
    await expect(worker.render(ARGS)).rejects.toThrow('закрыт');
  });

  it('ошибка init следующей page также закрывает общий Chromium и сервер', async () => {
    const fake = fakeBrowser({ initErrorPage: 1 });
    const worker = await createRenderWorker({ browser: fake });
    await worker.render(ARGS);
    await expect(worker.render(ARGS)).rejects.toThrow('init failed');
    expect(fake.pages.map((p) => p.close.mock.calls.length)).toEqual([1, 1]);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(state.servers[0].close).toHaveBeenCalledTimes(1);
  });

  it('после render ошибки кэшированный worker восстанавливается с чистыми ресурсами', async () => {
    const options = { renderError: true };
    const fake = fakeBrowser(options);
    const worker = await createRenderWorker({ browser: fake });
    await expect(worker.render(ARGS)).rejects.toThrow('IR timeout');
    options.renderError = false;
    const result = await worker.render(ARGS);
    expect(result.fingerprint.seed).toBe(RENDER_SEED);
    expect(fake.chromium.launch).toHaveBeenCalledTimes(2);
    expect(state.servers).toHaveLength(2);
    expect(state.servers[0].close).toHaveBeenCalledTimes(1);
    expect(fake.pages.every((page) => page.isClosed())).toBe(true);
    await worker.close();
    expect(fake.browser.close).toHaveBeenCalledTimes(2);
    expect(state.servers[1].close).toHaveBeenCalledTimes(1);
  });

  it('ошибка повторного launch также закрывает новый HTTP server', async () => {
    const options = { renderError: true };
    const fake = fakeBrowser(options);
    const worker = await createRenderWorker({ browser: fake });
    await expect(worker.render(ARGS)).rejects.toThrow('IR timeout');
    options.launchError = true;
    await expect(worker.render(ARGS)).rejects.toThrow('launch failed');
    expect(state.servers).toHaveLength(2);
    expect(state.servers.every((server) => server.close.mock.calls.length === 1)).toBe(true);
    await worker.close();
  });

  it('ошибка browser.close не мешает закрыть HTTP server', async () => {
    const fake = fakeBrowser({ closeError: true });
    const worker = await createRenderWorker({ browser: fake });
    await expect(worker.close()).rejects.toThrow('browser close failed');
    expect(fake.pages[0].close).toHaveBeenCalledTimes(1);
    expect(state.servers[0].close).toHaveBeenCalledTimes(1);
  });
});
