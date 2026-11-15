// Веб-инструменты агента: деградация и безопасность.
//
// Главное свойство, которое здесь проверяется: НЕТ КЛЮЧА — ИНСТРУМЕНТ НЕ
// ПАДАЕТ, А ГОВОРИТ, ЧТО ИНТЕРНЕТ НЕДОСТУПЕН. Режим ресёрча в этом случае
// отвечает по локальной библиотеке, и агент обязан сказать об этом вслух.
//
// Второе: ключи не показываются. В статусе сервисов — только ИМЯ переменной.

import { describe, expect, it } from 'vitest';

import { checkFetchUrl, internetAvailable, webFetch, webSearch, webServicesStatus } from '../../server/agent/web.js';

describe('статус веб-сервисов', () => {
  it('без ключа интернет недоступен, и это видно по ИМЕНИ переменной', () => {
    const status = webServicesStatus({});
    expect(status.internet).toBe(false);
    expect(status.missing).toContain('EXA_API_KEY');
    expect(status.search.configured).toBe(false);
    // Значения ключей не возвращаются — только имена переменных.
    expect(JSON.stringify(status)).not.toMatch(/sk-|api[_-]?key"\s*:\s*"[^"]+/i);
  });

  it('с ключом интернет доступен', () => {
    const status = webServicesStatus({ EXA_API_KEY: 'секрет-значение' });
    expect(status.internet).toBe(true);
    expect(status.missing).toEqual([]);
    expect(JSON.stringify(status)).not.toContain('секрет-значение');
  });

  it('пробел в значении ключа — это не ключ', () => {
    expect(internetAvailable({ EXA_API_KEY: '   ' })).toBe(false);
  });
});

describe('поиск без ключа', () => {
  it('честно деградирует и называет причину', async () => {
    const result = await webSearch({ query: 'phonk drift' }, { env: {} });
    expect(result.ok).toBe(false);
    expect(result.available).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/Интернет недоступен/);
    expect(result.reason).toMatch(/EXA_API_KEY/);
  });

  it('пустой запрос — не деградация, а ошибка аргумента', async () => {
    const result = await webSearch({ query: '  ' }, { env: {} });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/пустой запрос/);
  });
});

describe('поиск с ключом', () => {
  it('возвращает результаты провайдера', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        results: [
          { title: 'Phonk drift', url: 'https://example.com/phonk', text: 'Описание стиля…', publishedDate: '2026-01-01' },
        ],
      }),
    });
    const result = await webSearch({ query: 'phonk drift' }, { env: { EXA_API_KEY: 'k' }, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe('https://example.com/phonk');
  });

  it('ошибка провайдера — деградация, а не исключение', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const result = await webSearch({ query: 'phonk' }, { env: { EXA_API_KEY: 'k' }, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/503/);
  });
});

describe('безопасность чтения страниц', () => {
  it('локальные адреса и метаданные закрыты', () => {
    expect(checkFetchUrl('http://localhost:3000/api').ok).toBe(false);
    expect(checkFetchUrl('http://127.0.0.1/admin').ok).toBe(false);
    expect(checkFetchUrl('http://10.0.0.5/').ok).toBe(false);
    expect(checkFetchUrl('http://192.168.1.1/').ok).toBe(false);
    expect(checkFetchUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
    expect(checkFetchUrl('file:///etc/passwd').ok).toBe(false);
    expect(checkFetchUrl('не-урл').ok).toBe(false);
  });

  it('публичные адреса проходят', () => {
    expect(checkFetchUrl('https://example.com/article').ok).toBe(true);
    expect(checkFetchUrl('http://example.com/article').ok).toBe(true);
  });

  it('с ключом, но с приватным адресом — отказ', async () => {
    const result = await webFetch({ url: 'http://127.0.0.1:3000/api/health' }, {
      env: { EXA_API_KEY: 'k' },
      fetchImpl: async () => {
        throw new Error('fetch не должен вызываться');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/внутренней сети/);
  });

  it('читает страницу и отдаёт текст', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('<html><body><p>Phonk — это стиль</p><script>bad()</script></body></html>'),
    });
    const result = await webFetch({ url: 'https://example.com/phonk' }, { env: { EXA_API_KEY: 'k' }, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/Phonk/);
    expect(result.text).not.toMatch(/bad\(\)/);
  });
});
