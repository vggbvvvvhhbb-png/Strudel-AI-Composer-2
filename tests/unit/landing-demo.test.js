// Регресс для обложки: кнопка должна быть оформлена, демо — настоящее.
//
// ЗАЧЕМ ТЕСТ. Два дефекта прошлых сессий были молчаливыми:
//   1) обложка не грузила components.css → `.btn.primary` не существовал в
//      бандле, главная кнопка выглядела серой (дефект нашёл промт-гайд);
//   2) обещание «услышите за 5 секунд» нечем было подтвердить: звука на
//      обложке не было вовсе.
// Тест закрывает оба: кнопка обязана быть в CSS-графе обложки, а демо —
// существовать, быть короче 5 секунд и иметь честные числа, совпадающие с
// подписью под кнопкой (обещание и файл не должны расходиться).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { decodeWav } from '../../src/core/wav.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');

const LANDING_JS = join(ROOT, 'src', 'landing.js');
const LANDING_HTML = join(ROOT, 'index.html');
const DEMO_WAV = join(ROOT, 'public', 'demo', 'preview.wav');
const DEMO_JSON = join(ROOT, 'public', 'demo', 'preview.json');
const DEMO_SRC = join(ROOT, 'demo', 'preview.js');

/** Рекурсивно собирает граф импортов указанного расширения. */
function importGraph(entry, ext) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const re = new RegExp(`(?:import[^'"]*from\\s*|import\\s*)['"]([^'"]+\\${ext})['"]`, 'g');
    for (const m of source.matchAll(re)) {
      stack.push(resolve(dirname(file), m[1]));
    }
  }
  return [...seen];
}

describe('обложка: кнопка', () => {
  it('в CSS-графе обложки есть правило .btn.primary', () => {
    const cssFiles = importGraph(LANDING_JS, '.css');
    expect(cssFiles.length, 'обложка должна импортировать хотя бы один CSS').toBeGreaterThan(0);
    const merged = cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(merged, '.btn.primary не найден в CSS обложки — кнопка будет серой').toMatch(/\.btn\.primary\s*\{/);
  });

  it('обложка не тянет звуковой движок (обложка лёгкая)', () => {
    const jsFiles = importGraph(LANDING_JS, '.js');
    const offenders = jsFiles.filter((f) => /strudel-engine|@strudel[\\/]web/.test(f));
    expect(offenders, `обложка не должна импортировать движок: ${offenders.join(', ')}`).toEqual([]);
  });

  it('в разметке есть главная кнопка с классом btn primary', () => {
    const html = readFileSync(LANDING_HTML, 'utf8');
    expect(html).toMatch(/id="hero-submit"[^>]*class="[^"]*btn[^"]*primary/);
  });
});

describe('обложка: предрассчитанное демо', () => {
  it('исходник демо и его сборка лежат в репозитории', () => {
    expect(existsSync(DEMO_SRC), 'нет demo/preview.js').toBe(true);
    expect(existsSync(DEMO_WAV), 'нет public/demo/preview.wav').toBe(true);
    expect(existsSync(DEMO_JSON), 'нет public/demo/preview.json').toBe(true);
  });

  it('демо короче 5 секунд — обещание «через 5 секунд» должно быть правдой', () => {
    const wav = readFileSync(DEMO_WAV);
    const decoded = decodeWav(new Uint8Array(wav));
    const durationS = decoded.frames / decoded.sampleRate;
    expect(durationS, `демо длится ${durationS.toFixed(2)} с`).toBeLessThanOrEqual(5);
    expect(durationS).toBeGreaterThan(1);
  });

  it('метрики в preview.json совпадают с самим файлом', () => {
    const meta = JSON.parse(readFileSync(DEMO_JSON, 'utf8'));
    const wav = readFileSync(DEMO_WAV);
    expect(meta.bytes).toBe(wav.length);
    expect(meta.bytes).toBe(statSync(DEMO_WAV).size);
    const decoded = decodeWav(new Uint8Array(wav));
    expect(meta.sampleRate).toBe(decoded.sampleRate);
    expect(meta.channels).toBe(decoded.channels.length);
    expect(Math.abs(meta.durationS - decoded.frames / decoded.sampleRate)).toBeLessThan(0.01);
    // Громкость тизера: не орём и не шепчем.
    expect(meta.lufsI, 'LUFS вне рабочего диапазона тизера').toBeGreaterThan(-30);
    expect(meta.lufsI).toBeLessThan(-12);
    expect(meta.truePeakDbtp, 'true peak должен быть ниже −1 dBTP').toBeLessThanOrEqual(-1);
  });

  it('подпись под кнопкой совпадает с измеренными числами', () => {
    const meta = JSON.parse(readFileSync(DEMO_JSON, 'utf8'));
    const html = readFileSync(LANDING_HTML, 'utf8');
    const note = /<p class="hero-demo-note">([\s\S]*?)<\/p>/.exec(html);
    expect(note, 'нет подписи под демо').toBeTruthy();
    const text = note[1].replace(/\s+/g, ' ');
    // Русская запись: «4,0 с, −18,2 LUFS».
    const seconds = /([\d.,]+)\s*с/.exec(text);
    const lufs = /−\s*([\d.,]+)\s*LUFS/.exec(text);
    expect(seconds, `в подписи нет длительности: ${text}`).toBeTruthy();
    expect(lufs, `в подписи нет громкости: ${text}`).toBeTruthy();
    const toNumber = (raw) => Number(raw.replace(',', '.'));
    expect(Math.abs(toNumber(seconds[1]) - meta.durationS)).toBeLessThan(0.05);
    expect(Math.abs(toNumber(lufs[1]) - Math.abs(meta.lufsI))).toBeLessThan(0.05);
  });

  it('кнопка демо на странице есть и ведёт на существующий файл', () => {
    const html = readFileSync(LANDING_HTML, 'utf8');
    expect(html).toMatch(/id="hero-demo"/);
    const js = readFileSync(LANDING_JS, 'utf8');
    const url = /DEMO_URL\s*=\s*'([^']+)'/.exec(js);
    expect(url, 'в landing.js нет DEMO_URL').toBeTruthy();
    const file = resolve(ROOT, 'public', url[1]);
    expect(existsSync(file), `файл демо не найден: ${file}`).toBe(true);
  });
});
