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
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const DOCKERIGNORE = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
const CI_WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

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
  const pattern = /^COPY\s+(?:--from=\S+\s+)?(?:src|scripts|skills|server|local|public|contracts|lib)\s+(\S+)/gm;
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

/**
 * Файлы, отслеживаемые git, по пути относительно корня репозитория.
 * Именно этот набор попадает в checkout CI — то есть в контекст сборки
 * образа. Пустой массив означает, что путь не в git: Dockerfile, который
 * копирует такой каталог, упадёт в CI с "COPY failed: no such file".
 */
function trackedFiles(pathspec) {
  const out = execFileSync('git', ['ls-files', '--', pathspec], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split(/\r?\n/).filter(Boolean);
}

/** Реестр ассетов каталога Timbre Palette: id → паспорт с правами. */
function timbreAssets() {
  const raw = readFileSync(join(ROOT, 'server', 'music', 'data', 'timbre', 'assets.json'), 'utf8');
  return JSON.parse(raw).assets ?? {};
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

  it('аудио каталога Timbre Palette попадает в образ', () => {
    // Дефект этапа 2: каталог пресетов вне git, а Dockerfile копировал
    // только server/src/scripts/skills/local. На сервере /api/timbre/presets
    // отдавал 10 пресетов, но same-origin раздача звука (server/routes/samples.js)
    // искала файлы в <root>/data/timbre/audio/<alias>/<file> и не находила
    // их: пресет был, звука не было. Каталог копируется явной строкой COPY.
    expect(DOCKERFILE).toMatch(/^COPY\s+data\/timbre\/audio\s+\.\/data\/timbre\/audio/m);
  });

  it('аудио каталога Timbre Palette не исключён из контекста сборки', () => {
    // Обратная сторона: если data/timbre/audio попадёт в .dockerignore,
    // COPY выше отдаст пустоту — и баг вернётся молча, уже на сервере.
    // Исключать можно только содержимое каталога (originals), но не его
    // самого и не его предков — иначе в контексте не останется файлов.
    const ignored = ignoredDirs();
    const forbidden = ['data', 'data/timbre', 'data/timbre/audio'];
    expect(forbidden.filter((dir) => ignored.has(dir))).toEqual([]);
  });

  it('банк-исходник Timbre Palette не тащится в образ', () => {
    // data/timbre/audio/originals — оригиналы WAV (74.7 МБ), импортный слой.
    // В рантайме сервер читает только OGG-пресеты, поэтому исходники
    // исключаются из контекста: образ не растёт на 75 МБ зря.
    const ignored = ignoredDirs();
    expect(ignored.has('data/timbre/audio/originals')).toBe(true);
  });

  it('CI поднимает образ с HOST=0.0.0.0 — иначе порт извне не достать', () => {
    // Дефект, который держал CI красным много прогонов подряд: сервер
    // по умолчанию слушает 127.0.0.1 (server/config.js), docker-compose
    // задаёт HOST=0.0.0.0, а `docker run` в CI — нет. Опубликованный порт
    // оставался недостижим, и health-check не проходил никогда.
    const runLine = CI_WORKFLOW.split(/\r?\n/).find((line) => line.includes('docker run'));
    expect(runLine).toBeTruthy();
    expect(runLine).toMatch(/HOST=0\.0\.0\.0/);
  });

  it('OGG-пресеты каталога отслеживаются git — иначе CI не соберёт образ', () => {
    // D-130. Дефект, который уронил PR #3: каталог data/timbre/audio был
    // вне git (.gitignore:55), а Dockerfile копирует его в образ. CI
    // собирает образ из чистого checkout, где каталога нет, и падает:
    // "COPY failed: stat .../data/timbre/audio: no such file or directory".
    // Локально дефект не виден: на машине владельца каталог лежит
    // неотслеживаемым, а Docker-демон не запущен.
    const tracked = trackedFiles('data/timbre/audio');
    expect(tracked.length).toBeGreaterThan(0);
    const presets = tracked.filter((path) => path.endsWith('.ogg'));
    expect(presets.length).toBe(41);
  });

  it('каждый пресет реестра присутствует в git — иначе в образе нет звука', () => {
    // Реестр (server/music/data/timbre/assets.json) перечисляет файлы
    // относительно data/timbre/audio. Пресет в реестре, но не в git —
    // это тот же самый баг D-129 по-другому: /api/timbre/presets отдаст
    // пресет, а звука в образе не будет.
    const assets = Object.values(timbreAssets()).filter((asset) => asset && asset.file);
    expect(assets.length).toBe(41);
    const tracked = new Set(trackedFiles('data/timbre/audio'));
    const missing = assets
      .map((asset) => `data/timbre/audio/${asset.file}`)
      .filter((path) => !tracked.has(path));
    expect(missing).toEqual([]);
  });

  it('банк-исходник каталога не отслеживается git — 74.7 МБ в репозитории лишние', () => {
    // data/timbre/audio/originals — оригиналы WAV, импортный слой.
    // В рантайме сервер читает только OGG-пресеты, поэтому исходники
    // остаются на машине владельца и в образ не едут.
    const tracked = trackedFiles('data/timbre/audio');
    expect(tracked.filter((path) => path.includes('originals'))).toEqual([]);
  });

  it('все пресеты каталога лицензионно чисты — CC0 с правом на распространение', () => {
    // Файлы пресетов уезжают в публичный репозиторий, поэтому право
    // на распространение проверяется не «на словах», а по реестру:
    // commercial_use и redistribution должны быть у каждого ассета.
    const assets = Object.values(timbreAssets()).filter((asset) => asset && asset.file);
    const dirty = assets
      .filter((asset) => asset.license !== 'CC0-1.0'
        || asset.rights_status !== 'approved'
        || asset.commercial_use !== true
        || asset.redistribution !== true)
      .map((asset) => asset.id);
    expect(dirty).toEqual([]);
  });
});
