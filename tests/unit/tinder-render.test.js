// Guard страницы суждения («Тиндер»): порядок рендера и длина фрагмента.
//
// ПОЧЕМУ ЭТО ТЕСТ-ИСХОДНИК, А НЕ ПОВЕДЕНИЯ. Рендер живёт в браузере, юнит-тестами
// он не покрыт, а цена ошибки — тишина: рецензент слушает пустоту и невнятно
// ставит метки, которые потом учат модель. Одна строка `Promise.all` в
// showCurrent ломала весь путь суждения, поэтому порядок зафиксирован
// проверкой исходника (тот же приём, что в samples.test.js).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../../src/tinder.js'), 'utf8');

describe('страница суждения', () => {
  it('стороны пары рендерятся последовательно, а не параллельно', () => {
    // Оффлайн-рендер переключает ГЛОБАЛЬНЫЙ аудиоконтекст движка. Два
    // рендера одновременно перехватывают контекст друг у друга: на выходе
    // один трек выходит тихим (громкость по −70 LUFS), а в консоли сыпется
    // «cannot connect to an AudioNode belonging to a different audio context».
    expect(source).not.toMatch(/Promise\.all\(\s*\[\s*renderCandidate/);
    expect(source).toMatch(
      /const a = await renderCandidate\(pair\.a\);[\s\S]{0,80}const b = await renderCandidate\(pair\.b\);/,
    );
  });

  it('фрагмент пары не длиннее 20 секунд', () => {
    const match = source.match(/const BARS = (\d+)/);
    expect(match).toBeTruthy();
    const bars = Number(match[1]);
    // 120 BPM → cps 0.5, значит 1 такт = 2 секунды.
    const seconds = bars / 0.5;
    expect(seconds).toBeLessThanOrEqual(20);
    expect(seconds).toBeGreaterThanOrEqual(8);
  });

  it('метка помечается degraded, если сэмплы не загрузились', () => {
    // Рендер без сэмплов даёт неполный трек: такая метка не должна учить модель.
    expect(source).toContain('degraded: !samplesOk');
    expect(source).toMatch(/await ensureSamples\(\)/);
  });

  it('очередь загружается без явного смещения — сервер продолжает сам', () => {
    // Смещение считает сервер: иначе каждый сеанс предлагал бы одни и те же
    // первые пары, и приёмка §7.2 (≥50 разных промтов) была бы недостижима.
    expect(source).toMatch(/\/api\/preference\/queue\?limit=\$\{QUEUE_SIZE\}/);
    expect(source).not.toMatch(/\/api\/preference\/queue\?limit=\$\{QUEUE_SIZE\}&offset=/);
  });
});
