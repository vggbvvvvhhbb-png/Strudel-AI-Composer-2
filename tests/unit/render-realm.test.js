// Менеджер изолированного рендера (E-020/D-143): протокол, таймауты,
// очередь, уничтожение realm после каждого рендера. DOM не нужен —
// spawnRealm инъектируется фейком с управляемыми сообщениями.

import { describe, it, expect, vi } from 'vitest';
import { createRealmRenderer } from '../../src/audio/render/realm.js';

/** Фейк-realm: скрипт ответов на запрос рендера. */
function fakeRealmFactory(script) {
  const state = { spawned: 0, destroyed: 0, active: 0, posted: [], realms: [] };
  const spawn = () => {
    state.spawned += 1;
    state.active += 1;
    const listeners = new Set();
    const realm = {
      post(message) {
        state.posted.push(message);
        script(realm, message);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      destroy() {
        state.destroyed += 1;
        state.active -= 1;
      },
      emit(message) {
        for (const listener of [...listeners]) listener(message);
      },
    };
    state.realms.push(realm);
    // Готовность приходит асинхронно, как у настоящего iframe.
    queueMicrotask(() => realm.emit({ type: 'ready' }));
    return realm;
  };
  return { state, spawn };
}

const ARGS = { code: 'note("c3").s("sine")', fromCycle: 0, toCycle: 4, sampleRate: 48000, cps: 0.5 };

function channelBuffer(values) {
  return Float64Array.from(values).buffer;
}

describe('createRealmRenderer', () => {
  it('рендер проходит через свежий realm и возвращает каналы', async () => {
    const { state, spawn } = fakeRealmFactory((realm, message) => {
      realm.emit({
        type: 'result',
        id: message.id,
        sampleRate: 48000,
        channels: [channelBuffer([0, 0.5, -0.5]), channelBuffer([0, 0.25, -0.25])],
      });
    });
    const renderer = createRealmRenderer({ spawnRealm: spawn });
    const result = await renderer.render(ARGS);
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]).toBeInstanceOf(Float64Array);
    expect([...result.channels[0]]).toEqual([0, 0.5, -0.5]);
    expect(result.sampleRate).toBe(48000);
    expect(state.spawned).toBe(1);
    expect(state.destroyed).toBe(1);
    expect(state.active).toBe(0);
    expect(state.posted[0]).toMatchObject({ type: 'render', code: ARGS.code, fromCycle: 0, toCycle: 4 });
  });

  it('каждый рендер получает свой realm, вызовы сериализуются', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const { state, spawn } = fakeRealmFactory((realm, message) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      setTimeout(() => {
        concurrent -= 1;
        realm.emit({ type: 'result', id: message.id, sampleRate: 48000, channels: [channelBuffer([0.1])] });
      }, 5);
    });
    const renderer = createRealmRenderer({ spawnRealm: spawn });
    const [a, b] = await Promise.all([renderer.render(ARGS), renderer.render(ARGS)]);
    expect(a.channels[0][0]).toBe(0.1);
    expect(b.channels[0][0]).toBe(0.1);
    expect(state.spawned).toBe(2);
    expect(state.destroyed).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  it('ошибка realm отклоняет рендер и уничтожает realm', async () => {
    const { state, spawn } = fakeRealmFactory((realm, message) => {
      realm.emit({ type: 'error', id: message.id, message: 'sound bd not found' });
    });
    const renderer = createRealmRenderer({ spawnRealm: spawn });
    await expect(renderer.render(ARGS)).rejects.toThrow('sound bd not found');
    expect(state.destroyed).toBe(1);
    expect(state.active).toBe(0);
  });

  it('ошибка бутстрапа (без id) тоже отклоняет рендер', async () => {
    const spawn = () => {
      const listeners = new Set();
      const realm = {
        post: () => {},
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        destroy: vi.fn(),
      };
      queueMicrotask(() => {
        for (const listener of listeners) listener({ type: 'error', message: 'банки недоступны' });
      });
      return realm;
    };
    const renderer = createRealmRenderer({ spawnRealm: spawn });
    await expect(renderer.render(ARGS)).rejects.toThrow('банки недоступны');
  });

  it('таймаут готовности отклоняет рендер и уничтожает realm', async () => {
    const destroyed = vi.fn();
    const spawn = () => ({
      post: () => {},
      subscribe: () => () => {},
      destroy: destroyed,
    });
    const renderer = createRealmRenderer({ spawnRealm: spawn, readyTimeoutMs: 20 });
    await expect(renderer.render(ARGS)).rejects.toThrow('таймаут');
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it('таймаут рендера отклоняет запрос после готовности', async () => {
    const destroyed = vi.fn();
    const spawn = () => {
      const listeners = new Set();
      const realm = {
        post: () => {},
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        destroy: destroyed,
      };
      queueMicrotask(() => {
        for (const listener of listeners) listener({ type: 'ready' });
      });
      return realm;
    };
    const renderer = createRealmRenderer({ spawnRealm: spawn, renderTimeoutMs: 20 });
    await expect(renderer.render(ARGS)).rejects.toThrow('таймаут');
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it('каталог Timbre передаётся в realm сообщением (без похода в /api из iframe)', async () => {
    const { state, spawn } = fakeRealmFactory((realm, message) => {
      realm.emit({ type: 'result', id: message.id, sampleRate: 48000, channels: [channelBuffer([0.1])] });
    });
    const renderer = createRealmRenderer({ spawnRealm: spawn });
    const timbre = { sampleMap: { tp_x: { c3: 'x.ogg' } }, presets: [{ id: 'tp-x' }] };
    await renderer.render({ ...ARGS, code: 'note("c3").s("tp_x")', timbre });
    expect(state.posted[0].timbre).toEqual(timbre);
  });

  it('чужие сообщения (другой id) не завершают рендер', async () => {
    const { spawn } = fakeRealmFactory((realm, message) => {
      realm.emit({ type: 'result', id: 'чужой', channels: [channelBuffer([0.9])] });
      realm.emit({ type: 'result', id: message.id, sampleRate: 48000, channels: [channelBuffer([0.2])] });
    });
    const renderer = createRealmRenderer({ spawnRealm: spawn });
    const result = await renderer.render(ARGS);
    expect(result.channels[0][0]).toBe(0.2);
  });

  it('отказ одного рендера не ломает очередь следующих', async () => {
    let call = 0;
    const { spawn } = fakeRealmFactory((realm, message) => {
      call += 1;
      if (call === 1) {
        realm.emit({ type: 'error', id: message.id, message: 'первый упал' });
      } else {
        realm.emit({ type: 'result', id: message.id, sampleRate: 48000, channels: [channelBuffer([0.3])] });
      }
    });
    const renderer = createRealmRenderer({ spawnRealm: spawn });
    await expect(renderer.render(ARGS)).rejects.toThrow('первый упал');
    const second = await renderer.render(ARGS);
    expect(second.channels[0][0]).toBe(0.3);
  });
});