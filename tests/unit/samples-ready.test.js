// Готовность сэмплов: трек считается цельным, только если загружены ВСЕ
// наборы.
//
// Зачем отдельный тест: движок живёт в браузере и юнит-тестами не покрыт,
// а правило «неполный трек → метка degraded → в обучение не идёт» держится
// на одном решении. Если оно разъедется, портится обучение целиком.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allSamplesReady } from '../../src/samples-ready.js';

const here = dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(join(here, '../../src/strudel-engine.js'), 'utf8');

describe('готовность сэмплов', () => {
  it('оба набора на месте — трек цельный', () => {
    expect(allSamplesReady([
      { status: 'fulfilled', value: {} },
      { status: 'fulfilled', value: {} },
    ])).toBe(true);
  });

  it('один набор упал — трек неполный', () => {
    expect(allSamplesReady([
      { status: 'fulfilled', value: {} },
      { status: 'rejected', reason: new Error('сеть') },
    ])).toBe(false);
  });

  it('пустой результат — не готов', () => {
    expect(allSamplesReady([])).toBe(false);
    expect(allSamplesReady(null)).toBe(false);
  });

  it('движок отвечает булевым и не резолвится в undefined', () => {
    // В окне повторной попытки ensureSamples отвечает false, а не undefined:
    // undefined вызывающий код принимал за «сэмплов нет» и портил метки.
    const body = engineSource.slice(
      engineSource.indexOf('export function ensureSamples'),
      engineSource.indexOf('async function waitForSamples'),
    );
    expect(body).toContain('Promise.resolve(false)');
    expect(body).not.toMatch(/Promise\.resolve\(\s*\)/);
    expect(body).toContain('return ok;');
    expect(body).toContain('allSamplesReady(results)');
  });
});
