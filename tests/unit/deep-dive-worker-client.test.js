// Клиент Python-воркера анализа.
//
// ЗАЧЕМ ЭТОТ ТЕСТ. Раньше клиент ходил в воркер через глобальный `fetch`.
// Это undici, а у него есть собственные таймауты: `headersTimeout` = 300 с и
// `bodyTimeout` = 300 с. Воркер отвечает на `/separate` ОДНИМ ответом —
// после конца Demucs, а это на 2 vCPU 6–9 минут. undici рвал соединение сам,
// задолго до нашего таймаута: разбор падал с «Сервис анализа недоступен:
// fetch failed», хотя Demucs отработал, а результат лежал на диске.
//
// Тест фиксирует два свойства клиента:
//   1. он НЕ использует глобальный fetch (у undici эти дефолты встроены);
//   2. длинный ответ доезжает целиком, а наш собственный таймаут по-прежнему
//      обрывает ожидание.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFile, workerHealth } from '../../server/deepdive/analysis/client.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

let server;
let baseUrl;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = req.url.split('?')[0];
    const delay = route.startsWith('/slow') ? 1500 : route === '/analyze' ? 400 : 0;
    setTimeout(() => {
      const payload = route === '/health'
        ? { ok: true, versions: { python: '3.11' }, models: { demucs_available: true } }
        : { measurements: { tempo: { bpm: 120 } }, structure: [] };
      const body = JSON.stringify(payload);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    }, delay);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('клиент воркера анализа', () => {
  it('не использует глобальный fetch: у undici headersTimeout 300 с', () => {
    const source = readFileSync(join(root, 'server/deepdive/analysis/client.js'), 'utf8');
    expect(source, 'клиент воркера не должен ходить через fetch(…)').not.toMatch(/\bfetch\s*\(/);
    expect(source, 'клиент воркера должен ходить через node:http/node:https').toMatch(/node:https?/);
  });

  it('доезжает ответ, который сервер отдаёт с задержкой', async () => {
    const result = await analyzeFile('/tmp/track.wav', { baseUrl });
    expect(result.measurements.tempo.bpm).toBe(120);
  });

  it('свой таймаут обрывает ожидание с понятным текстом', async () => {
    await expect(
      analyzeFile('/tmp/track.wav', { baseUrl: `${baseUrl}/slow`, timeoutMs: 300 }),
    ).rejects.toThrow(/не ответил за/);
  });

  it('недоступный воркер — понятная ошибка, а не стектрейс', async () => {
    // Порт, который никто не слушает.
    await expect(
      workerHealth({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 }),
    ).rejects.toThrow(/Сервис анализа недоступен/);
  });
});
