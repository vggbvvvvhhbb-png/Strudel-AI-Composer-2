// Задача passport локального демона (D-115, D-097).
//
// Измерение звука считается на машине владельца тем же общим модулем, что
// и на сервере. Проверяем на синтезированном WAV: тон 220 Гц должен дать
// паспорт с длительностью, высотой и характером, а не пустой объект.

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createTaskRegistry } from '../../local/tasks.mjs';
import { encodeWav } from '../../src/core/wav.js';

describe('задача passport демона', () => {
  it('демон заявляет задачу passport', () => {
    const registry = createTaskRegistry({ stateDir: os.tmpdir() });
    expect(registry.types()).toContain('passport');
  });

  it('без пути к файлу — понятная ошибка, а не пустой паспорт', async () => {
    const registry = createTaskRegistry({ stateDir: os.tmpdir() });
    await expect(registry.tasks.passport({})).rejects.toThrow(/path/);
  });

  it('паспорт измеряет тон 220 Гц: длительность, высота, характер', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'local-passport-'));
    try {
      const sampleRate = 44100;
      const frames = sampleRate;
      const channel = new Float64Array(frames);
      for (let i = 0; i < frames; i += 1) {
        channel[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
      }
      const wavPath = path.join(dir, 'tone.wav');
      await writeFile(wavPath, Buffer.from(encodeWav([channel], sampleRate)));

      const registry = createTaskRegistry({ stateDir: dir });
      const result = await registry.tasks.passport({ path: wavPath, name: 'тон 220' });
      expect(result.ok).toBe(true);
      expect(result.passport.durationS).toBeCloseTo(1, 2);
      expect(result.passport.tonal.note).toBe('A');
      expect(result.passport.tonal.f0Hz).toBeGreaterThan(200);
      expect(result.passport.tonal.f0Hz).toBeLessThan(240);
      expect(result.passport.character).toContain('тональный');
      expect(result.passport.name).toBe('тон 220');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});