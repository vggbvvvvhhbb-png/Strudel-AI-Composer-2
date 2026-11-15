// Образ должен содержать всё, что сервер импортирует.
//
// Дефект, который стоил деплоя: фаза B добавила `server/routes/local.js`
// с импортом `local/client.mjs`, а Dockerfile копировал в рантайм только
// `server`, `src`, `scripts` и `skills`. Сервер падал на старте с
// ERR_MODULE_NOT_FOUND, контейнер уходил в бесконечный рестарт — и это
// видно только на сервере, локальные тесты проходят.
//
// Тест ловит класс дефектов, а не один случай: любой импорт сервера
// за пределами копируемых каталогов должен быть либо скопирован, либо
// исключён из образа осознанно.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const DOCKERIGNORE = readFileSync(join(ROOT, '.dockerignore'), 'utf8');

/** Все .js/.mjs файлы каталога (рекурсивно). */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Импорты, которые уходят из каталога server наружу: '../../<dir>/...'
 * и '../../../<dir>/...'. Возвращает имена каталогов верхнего уровня.
 */
function externalDirs() {
  const dirs = new Set();
  // Префикс целиком в одной группе: с '+' внутри группа captures только
  // последнее повторение, и '../../local' превратился бы в '../local'.
  const pattern = /from\s+'((?:\.\.\/)+)([^/'\\]+)\//g;
  for (const file of sourceFiles(join(ROOT, 'server'))) {
    const text = readFileSync(file, 'utf8');
    let match = pattern.exec(text);
    while (match) {
      const target = resolve(dirname(file), match[1] + match[2]);
      const top = relative(ROOT, target).split(/[\\/]/)[0];
      if (top && !top.startsWith('..')) dirs.add(top);
      match = pattern.exec(text);
    }
  }
  return dirs;
}

/** Каталоги, которые Dockerfile копирует в рантайм-слой. */
function copiedDirs() {
  const dirs = new Set();
  const pattern = /^COPY\s+(?:--from=\S+\s+)?(?:src|scripts|skills|server|local|public|contracts)\s+(\S+)/gm;
  let match = pattern.exec(DOCKERFILE);
  while (match) {
    dirs.add(match[1].replace(/^\.\//, '').replace(/\/?$/, ''));
    match = pattern.exec(DOCKERFILE);
  }
  return dirs;
}

/** Каталоги, исключённые из контекста сборки (.dockerignore). */
function ignoredDirs() {
  const dirs = new Set();
  for (const line of DOCKERIGNORE.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#') || value.startsWith('!')) continue;
    dirs.add(value.replace(/^\.\//, '').replace(/\/$/, ''));
  }
  return dirs;
}

describe('образ приложения', () => {
  it('сервер не импортирует ничего за пределами копируемых каталогов', () => {
    const copied = copiedDirs();
    const missing = [...externalDirs()].filter((dir) => !copied.has(dir));
    expect(missing).toEqual([]);
  });

  it('скопированный каталог не исключён из контекста сборки', () => {
    const ignored = ignoredDirs();
    const conflict = [...copiedDirs()].filter((dir) => ignored.has(dir));
    expect(conflict).toEqual([]);
  });

  it('клиент локального демона попадает в образ', () => {
    // Конкретная причина падения: /app/local/client.mjs
    expect(DOCKERFILE).toMatch(/^COPY\s+local\s+\.\/local/m);
  });
});
