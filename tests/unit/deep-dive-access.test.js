// Доступ к разбору — по токену.
//
// Проверяем то, ради чего модуль написан:
//   * токен выдаётся и сравнивается только постоянным временем;
//   * знание идентификатора задачи НЕ даёт доступа к отчёту;
//   * токен переживает перезапуск сервера (лежит в job.json);
//   * в ссылке токен живёт во фрагменте — сервер его не видит.

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  generateAccessToken,
  tokensEqual,
  isAuthorized,
  readToken,
  permalinkFor,
  TOKEN_HEADER,
} from '../../server/deepdive/access.js';
import { createJobStore } from '../../server/deepdive/jobs.js';

describe('доступ к разбору', () => {
  describe('токен', () => {
    it('выдаётся как hex-строка фиксированной длины', () => {
      const token = generateAccessToken();
      expect(token).toMatch(/^[0-9a-f]{48}$/);
    });

    it('каждый раз новый', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => generateAccessToken()));
      expect(tokens.size).toBe(50);
    });
  });

  describe('сравнение', () => {
    it('одинаковые токены равны', () => {
      expect(tokensEqual('abc123', 'abc123')).toBe(true);
    });

    it('разные — не равны', () => {
      expect(tokensEqual('abc123', 'abc124')).toBe(false);
    });

    it('разной длины — не равны, без исключения', () => {
      expect(tokensEqual('abc', 'abcd')).toBe(false);
    });

    it('пустой токен не проходит', () => {
      expect(tokensEqual('', '')).toBe(false);
    });

    it('не-строки не проходят', () => {
      expect(tokensEqual(null, null)).toBe(false);
      expect(tokensEqual(undefined, 'abc')).toBe(false);
      expect(tokensEqual('abc', 42)).toBe(false);
    });
  });

  describe('проверка доступа', () => {
    it('правильный токен даёт доступ', () => {
      const job = { accessToken: 'secret' };
      expect(isAuthorized(job, 'secret')).toBe(true);
    });

    it('чужой токен не даёт доступа', () => {
      const job = { accessToken: 'secret' };
      expect(isAuthorized(job, 'other')).toBe(false);
      expect(isAuthorized(job, null)).toBe(false);
      expect(isAuthorized(job, undefined)).toBe(false);
    });

    it('задача без токена недоступна даже «с пустым токеном»', () => {
      expect(isAuthorized({}, '')).toBe(false);
      expect(isAuthorized(null, 'secret')).toBe(false);
    });
  });

  describe('чтение токена из запроса', () => {
    it('берётся из заголовка', () => {
      const req = { get: (name) => (name === TOKEN_HEADER ? 'from-header' : null) };
      expect(readToken(req)).toBe('from-header');
    });

    it('берётся из query — им пользуются ссылки на файлы', () => {
      const req = { get: () => null, query: { token: 'from-query' } };
      expect(readToken(req)).toBe('from-query');
    });

    it('заголовок важнее query', () => {
      const req = { get: () => 'header', query: { token: 'query' } };
      expect(readToken(req)).toBe('header');
    });

    it('нет токена — null', () => {
      expect(readToken({ get: () => null, query: {} })).toBeNull();
      expect(readToken({})).toBeNull();
    });
  });

  describe('ссылка', () => {
    it('токен стоит во фрагменте, а не в query', () => {
      const link = permalinkFor('job-1', 'tok');
      expect(link).toBe('/razbor/job-1#t=tok');
      // Фрагмент не уходит серверу — значит, токен не попадёт в логи.
      expect(link.split('#')[1]).toBe('t=tok');
    });

    it('без токена ссылки нет', () => {
      expect(permalinkFor('job-1', null)).toBeNull();
      expect(permalinkFor('job-1', '')).toBeNull();
      expect(permalinkFor(null, 'tok')).toBeNull();
    });
  });

  describe('хранилище задач', () => {
    it('токен переживает перезапуск: он в job.json на диске', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'strudel-access-'));
      try {
        const store = createJobStore({ root });
        const token = generateAccessToken();
        store.create({ id: 'job-1', accessToken: token });
        await store.save(store.peek('job-1'));

        // Новый экземпляр магазина — как после перезапуска сервера.
        const restarted = createJobStore({ root });
        const job = await restarted.get('job-1');
        expect(job?.accessToken).toBe(token);
        expect(isAuthorized(job, token)).toBe(true);
        expect(isAuthorized(job, 'wrong')).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
