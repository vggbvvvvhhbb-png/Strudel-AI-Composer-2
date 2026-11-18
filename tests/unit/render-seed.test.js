// Детерминированный PRNG realm-рендера (D-143/E-022): чистая функция,
// глобальный Math.random в тестах не подменяется.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSeededRandom, RENDER_SEED, RENDER_POLICY_VERSION, installRenderDeterminism } from '../../src/audio/render/seed.js';
import { createEngineAdapter } from '../../src/audio/engine/adapter.js';

describe('createSeededRandom', () => {
  it('одно зерно — одна последовательность (воспроизводимость realm)', () => {
    const a = createSeededRandom(RENDER_SEED);
    const b = createSeededRandom(RENDER_SEED);
    const seqA = Array.from({ length: 1000 }, () => a());
    const seqB = Array.from({ length: 1000 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('разные зёрна — разные последовательности', () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('значения в [0, 1), не вырождены', () => {
    const random = createSeededRandom(RENDER_SEED);
    const values = Array.from({ length: 10_000 }, () => random());
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(new Set(values).size).toBeGreaterThan(9900);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.48);
    expect(mean).toBeLessThan(0.52);
  });
});

// Контракт реальной reverb.mjs: createConvolver → generate → buffer setter.
// initial generate внутри createReverb; возврата Promise у generate нет.
function fakeAudioScope() {
  const values = new WeakMap();
  const completions = [];
  class ConvolverNode {
    get buffer() { return values.get(this) ?? null; }
    set buffer(value) {
      if (value?.invalid) throw new Error('invalid IR');
      values.set(this, value);
    }
  }
  class BaseAudioContext {
    createConvolver() { return new ConvolverNode(); }
    createReverb(initial = { id: 'initial' }, sync = false) {
      const node = this.createConvolver();
      node.generate = (value, immediate = false) => {
        if (value?.throws) throw new Error('generate failed');
        if (immediate) node.buffer = value;
        else completions.push(() => { node.buffer = value; });
      };
      node.generate(initial, sync);
      return node;
    }
  }
  const scope = { BaseAudioContext, ConvolverNode, Math: Object.create(Math) };
  return { scope, ctx: new BaseAudioContext(), completions };
}

async function assertStillWaiting(prepare, advance = 10) {
  const settled = vi.fn();
  const promise = prepare().then(settled);
  await vi.advanceTimersByTimeAsync(advance);
  expect(settled).not.toHaveBeenCalled();
  return { promise, settled };
}

describe('installRenderDeterminism', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('каждая свежая page получает тот же seed; установка идемпотентна и не трогает живой Math', () => {
    const liveRandom = Math.random;
    const a = fakeAudioScope();
    const b = fakeAudioScope();
    const policy = installRenderDeterminism(a.scope);
    installRenderDeterminism(b.scope);
    expect(policy).toMatchObject({ seed: RENDER_SEED, version: RENDER_POLICY_VERSION });
    const first = a.scope.Math.random();
    expect(installRenderDeterminism(a.scope)).toBe(policy);
    const second = a.scope.Math.random();
    expect([first, second]).toEqual([b.scope.Math.random(), b.scope.Math.random()]);
    expect(Math.random).toBe(liveRandom);
  });

  it('ждёт initial generate, начавшийся до возврата createReverb', async () => {
    vi.useFakeTimers();
    const { scope, ctx, completions } = fakeAudioScope();
    const { prepare } = installRenderDeterminism(scope);
    const node = ctx.createReverb();
    expect(node.buffer).toBeNull();
    const { promise } = await assertStillWaiting(prepare);
    completions[0]();
    await vi.advanceTimersByTimeAsync(10);
    await promise;
    expect(node.buffer.id).toBe('initial');
  });

  it('повторный generate с old buffer ждёт именно новое присваивание', async () => {
    vi.useFakeTimers();
    const { scope, ctx, completions } = fakeAudioScope();
    const { prepare } = installRenderDeterminism(scope);
    const old = { id: 'old' };
    const node = ctx.createReverb(old, true);
    await prepare();
    expect(node.generate({ id: 'new' })).toBeUndefined();
    expect(node.buffer).toBe(old);
    const { promise } = await assertStillWaiting(prepare);
    completions[0]();
    await vi.advanceTimersByTimeAsync(10);
    await promise;
    expect(node.buffer.id).toBe('new');
  });

  it('ждёт ВСЕ генерации одного и нескольких узлов, даже при другом порядке завершения', async () => {
    vi.useFakeTimers();
    const { scope, ctx, completions } = fakeAudioScope();
    const { prepare } = installRenderDeterminism(scope);
    const a = ctx.createReverb();
    a.generate({ id: 'a2' });
    ctx.createReverb({ id: 'b' });
    const { promise, settled } = await assertStillWaiting(prepare);
    completions[1]();
    completions[2]();
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).not.toHaveBeenCalled();
    completions[0]();
    await vi.advanceTimersByTimeAsync(10);
    await promise;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('синхронный IR не зависает, обычный createConvolver не добавляет pending', async () => {
    const { scope, ctx } = fakeAudioScope();
    const { prepare } = installRenderDeterminism(scope);
    const node = ctx.createReverb({ id: 'provided IR' }, true);
    node.generate({ id: 'replacement' }, true);
    ctx.createConvolver();
    await prepare();
    expect(node.buffer.id).toBe('replacement');
  });

  it('timeout честно отклоняет рендер, даже если у узла есть old buffer', async () => {
    vi.useFakeTimers();
    const { scope, ctx } = fakeAudioScope();
    const { prepare } = installRenderDeterminism(scope, { timeoutMs: 25 });
    const node = ctx.createReverb({ id: 'old' }, true);
    node.generate({ id: 'never completes' });
    const rejected = expect(prepare()).rejects.toThrow('25 мс (1 pending) — рендер недостоверен');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ошибка native setter / generate не превращается в готовый IR', async () => {
    const { scope, ctx, completions } = fakeAudioScope();
    const { prepare } = installRenderDeterminism(scope);
    const node = ctx.createReverb();
    node.generate({ invalid: true });
    completions[0]();
    expect(completions[1]).toThrow('invalid IR');
    await expect(prepare()).rejects.toThrow('invalid IR');

    const other = fakeAudioScope();
    const policy = installRenderDeterminism(other.scope);
    const otherNode = other.ctx.createReverb({}, true);
    expect(() => otherNode.generate({ throws: true })).toThrow('generate failed');
    await expect(policy.prepare()).rejects.toThrow('generate failed');
  });

  it.each([false, true])('реальный adapter не вызывает startRendering до всех IR (timeout=%s)', async (timeout) => {
    vi.useFakeTimers();
    const { scope, ctx, completions } = fakeAudioScope();
    const { prepare } = installRenderDeterminism(scope, { timeoutMs: 50 });
    const rendered = {};
    const startRendering = vi.fn(async () => rendered);
    class OfflineContext extends scope.BaseAudioContext {
      startRendering = startRendering;
    }
    vi.stubGlobal('OfflineAudioContext', OfflineContext);
    let current;
    const pattern = { queryArc: () => [{ whole: { begin: 0 }, duration: 1, hasOnset: () => true, value: {} }] };
    const strudel = {
      initStrudel: async () => ({ evaluate: async () => ({ pattern }) }),
      initAudio: async () => {},
      setAudioContext: (context) => { current = context; },
      superdough: async () => {
        const node = current.createReverb({ id: 'old' }, true);
        node.generate({ id: 'new' });
        current.createReverb({ id: 'other' });
      },
    };
    const adapter = createEngineAdapter(strudel);
    await adapter.init(ctx);
    const render = adapter.renderCodeOffline({ code: 'fake', prepare });
    if (timeout) {
      const rejected = expect(render).rejects.toThrow('рендер недостоверен');
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(startRendering).not.toHaveBeenCalled();
    } else {
      await vi.advanceTimersByTimeAsync(10);
      expect(startRendering).not.toHaveBeenCalled();
      completions[1]();
      await vi.advanceTimersByTimeAsync(10);
      expect(startRendering).not.toHaveBeenCalled();
      completions[0]();
      await vi.advanceTimersByTimeAsync(10);
      expect(await render).toBe(rendered);
      expect(startRendering).toHaveBeenCalledTimes(1);
    }
  });

  it('не продолжает рендер, если библиотечный API не поддерживается', () => {
    expect(() => installRenderDeterminism({ Math })).toThrow('API reverb / ConvolverNode.buffer недоступен');
  });
});