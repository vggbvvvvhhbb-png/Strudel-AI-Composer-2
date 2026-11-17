// Маршруты каталога Timbre Palette (D-126): ленивый каталог и атрибуция.
//
// Проверяем контракт: каталог отдаёт публичные метаданные и статус прав;
// атрибуция считается тем же серверным модулем, что и гейт; некорректный
// запрос — 400. Пустой каталог — честный пустой ответ, не ошибка.
// Раздача аудио: пропуск — запись в реестре, обход пути отвергается,
// байты отдаются как есть (проверка на временном каталоге, чтобы тест
// не зависел от локального аудио владельца и работал на CI).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import router from '../../server/routes/samples.js';
import { timbreAudioFile } from '../../server/samples/timbre.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('маршруты каталога Timbre', () => {
  it('GET /api/timbre/catalog — статус прав и метаданные пресетов', async () => {
    const res = await fetch(`${base}/api/timbre/catalog`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.totals.sources).toBeGreaterThanOrEqual(2);
    expect(typeof body.releaseBlocked).toBe('boolean');
  });

  it('POST /api/timbre/attribution — код без пресетов даёт пустую атрибуцию', async () => {
    const res = await fetch(`${base}/api/timbre/attribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codes: ['s("bd")', 'note("c3").s("piano")'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attributions).toEqual([[], []]);
  });

  it('POST без массива codes — 400', async () => {
    const res = await fetch(`${base}/api/timbre/attribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 's("bd")' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST больше 64 кодов — 400', async () => {
    const res = await fetch(`${base}/api/timbre/attribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codes: Array.from({ length: 65 }, () => 's("bd")') }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /timbre-audio — незарегистрированный alias даёт 404', async () => {
    const res = await fetch(`${base}/timbre-audio/tp_ghost_v9/c4.ogg`);
    expect(res.status).toBe(404);
  });

  it('GET /timbre-audio — обход пути отвергается', async () => {
    const res = await fetch(`${base}/timbre-audio/tp_upright_piano_v1/..%2f..%2fsecret.ogg`);
    expect(res.status).toBe(404);
  });

  it('GET /api/timbre/resolve — кандидаты с обоснованием', async () => {
    const res = await fetch(`${base}/api/timbre/resolve?role=chords&profile=warm&low=57&high=72&style=lo-fi`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.length).toBeGreaterThan(0);
    for (const candidate of body.candidates) {
      expect(typeof candidate.id).toBe('string');
      expect(typeof candidate.score).toBe('number');
      expect(Array.isArray(candidate.reasons)).toBe(true);
    }
  });

  it('GET /api/timbre/resolve — limit ограничивает выдачу', async () => {
    const res = await fetch(`${base}/api/timbre/resolve?role=chords&limit=2`);
    const body = await res.json();
    expect(body.candidates.length).toBeLessThanOrEqual(2);
  });

  it('GET /api/timbre/resolve — неизвестная роль даёт честный пустой список', async () => {
    const res = await fetch(`${base}/api/timbre/resolve?role=theremin_solo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toEqual([]);
  });
});

describe('раздача аудио каталога: пропуск — запись в реестре', () => {
  const OGG_BYTES = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x01, 0x02, 0x03, 0x04]);
  let audioDir;
  const catalog = {
    sources: {},
    assets: { 'a1': { file: 'tp_test_v1/c4.ogg' } },
    presets: { 'p1': { strudelAlias: 'tp_test_v1' } },
    zones: [],
  };

  beforeAll(async () => {
    audioDir = await mkdtemp(path.join(tmpdir(), 'strudel-timbre-audio-'));
    await mkdir(path.join(audioDir, 'tp_test_v1'), { recursive: true });
    await writeFile(path.join(audioDir, 'tp_test_v1', 'c4.ogg'), OGG_BYTES);
    await writeFile(path.join(audioDir, 'secret.ogg'), OGG_BYTES);
  });

  afterAll(async () => {
    await rm(audioDir, { recursive: true, force: true });
  });

  it('зарегистрированный файл отдаётся побайтово', async () => {
    const file = timbreAudioFile('tp_test_v1', 'c4.ogg', { catalog, audioDir });
    expect(file).toBeTruthy();
    expect((await readFile(file)).equals(OGG_BYTES)).toBe(true);
  });

  it('незарегистрированный файл каталога не читается', () => {
    expect(timbreAudioFile('tp_test_v1', 'c5.ogg', { catalog, audioDir })).toBeNull();
  });

  it('незарегистрированный alias не читается', () => {
    expect(timbreAudioFile('tp_other_v1', 'c4.ogg', { catalog, audioDir })).toBeNull();
  });

  it('обход пути и чужие расширения отвергаются', () => {
    expect(timbreAudioFile('tp_test_v1', '../secret.ogg', { catalog, audioDir })).toBeNull();
    expect(timbreAudioFile('tp_test_v1', '..%2fsecret.ogg', { catalog, audioDir })).toBeNull();
    expect(timbreAudioFile('tp_test_v1', 'c4.wav', { catalog, audioDir })).toBeNull();
    expect(timbreAudioFile('../..', 'c4.ogg', { catalog, audioDir })).toBeNull();
  });

  it('пропавший с диска файл — честный null', () => {
    expect(timbreAudioFile('tp_test_v1', 'c9.ogg', { catalog, audioDir })).toBeNull();
  });
});