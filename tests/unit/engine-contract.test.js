// Контракт аудио-движка.
//
// Эти тесты падают при смене версии @strudel/web: пакет запинен точно,
// поэтому любое обновление — осознанный шаг, который обязан ломать сборку,
// пока не подтверждено тестами.
//
// Проверяем ровно то, на что опирается мини-студия:
//   • версии совпадают с установленными и с ENGINE_VERSION;
//   • публичный API, которым мы вставляем мастер-цепочку и считаем позицию;
//   • методы паттерна (дакинг, компрессор, орбиты).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_VERSION, ENGINE_VERSION_STRING } from '../../src/audio/engine-version.js';
import { loadStrudel } from '../../server/music/strudel-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));

describe('пины версий аудио-пакетов', () => {
  it('в package.json аудио-пакеты запинены точно', () => {
    const pkg = readJson('package.json');
    expect(pkg.dependencies['@strudel/web']).toBe(ENGINE_VERSION.strudelWeb);
    expect(pkg.dependencies['@strudel/web']).not.toMatch(/[\^~><*]/);
  });

  it('установленная версия @strudel/web совпадает с запиненной', () => {
    const installed = readJson('node_modules/@strudel/web/package.json');
    expect(installed.version).toBe(ENGINE_VERSION.strudelWeb);
  });

  it('версии superdough и @strudel/core совпадают с зафиксированными', () => {
    expect(readJson('node_modules/superdough/package.json').version).toBe(ENGINE_VERSION.superdough);
    expect(readJson('node_modules/@strudel/core/package.json').version).toBe(ENGINE_VERSION.strudelCore);
  });

  it('строка версии пригодна для отчётов', () => {
    expect(ENGINE_VERSION_STRING).toContain('@strudel/web'.replace('@strudel/web', 'strudel-web@'));
    expect(ENGINE_VERSION_STRING).toContain(ENGINE_VERSION.strudelWeb);
  });
});

describe('публичный API @strudel/web', () => {
  it('экспортирует ручки, нужные мини-студии', async () => {
    const api = await loadStrudel();
    const required = [
      // Инициализация и воспроизведение
      'initStrudel',
      'evaluate',
      'hush',
      // Аудиоконтекст: свой контекст → своя шина → свой мастер
      'getAudioContext',
      'setAudioContext',
      'getAudioContextCurrentTime',
      // Точка вставки мастер-цепочки: контроллер superdough с хвостом destinationGain
      'getSuperdoughAudioController',
      'webaudioOutput',
      'connectToDestination',
      // Офлайн-рендер и низкоуровневый триггер событий
      'renderPatternAudio',
      'superdough',
      'initAudio',
      'initAudioOnFirstClick',
      'samples',
    ];
    for (const name of required) {
      expect(typeof api[name], `экспорт ${name} отсутствует`).toBe('function');
    }
  });

  it('экспортирует методы паттерна для эффектов студии', async () => {
    const api = await loadStrudel();
    const proto = api.Pattern?.prototype;
    expect(proto).toBeTruthy();
    const required = [
      // Дакинг (H2)
      'duck', 'duckorbit', 'duckattack', 'duckdepth', 'duckons',
      // Компрессор и его параметры (H6)
      'compressor', 'compressorRatio', 'compressorAttack', 'compressorRelease', 'compressorKnee',
      // Орбиты, громкость, панорама, фильтры
      'orbit', 'gain', 'postgain', 'pan', 'room', 'delay', 'lpf', 'hpf',
    ];
    for (const name of required) {
      expect(typeof proto[name], `метод паттерна ${name} отсутствует`).toBe('function');
    }
  });

  it('дакинг и компрессор записывают свои параметры в событие', async () => {
    const api = await loadStrudel();
    const duck = api.s('bd').duckorbit(2).duckattack(0.2).duckdepth(1).queryArc(0, 1);
    expect(duck[0].value.duckorbit).toBe(2);
    expect(duck[0].value.duckattack).toBe(0.2);
    expect(duck[0].value.duckdepth).toBe(1);

    const comp = api.s('bd').compressor(-20).queryArc(0, 1);
    expect(comp[0].value.compressor).toBe(-20);
  });
});
