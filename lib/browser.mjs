// Общий слой доступа к браузеру: путь к Chrome/Edge и уборка осиротевших
// профилей Playwright.
//
// ЗАЧЕМ. Playwright создаёт профиль пользователя в os.tmpdir()
// (`playwright_chromiumdev_profile-XXXXXX`) и удаляет его ТОЛЬКО при штатном
// browser.close(). Процесс, убитый без finally (SIGKILL, прерванный vitest,
// снятая задача), оставляет профиль на диске. За 5 дней накопилось 134
// каталога (~2.4 ГБ), диск C: заполнился, ворота падали на ENOSPC (E-041).
//
// ЧТО ЗДЕСЬ. Один источник правды по путям к браузеру (было девять копий
// pickBrowserPath в семи файлах) и уборка протухших профилей.
//
// БЕЗОПАСНОСТЬ УБОРКИ. Трогаются ТОЛЬКО каталоги, которые создал Playwright
// (строгий шаблон имени), ТОЛЬКО старше порога возраста (живые профили не
// трогаем) и ТОЛЬКО в системном каталоге временных файлов. Всё остальное в
// tmpdir не трогается никогда.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Пути к браузеру: переменная окружения владельца имеет приоритет. */
export const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/**
 * Первый существующий браузер из списка. Бросает понятную ошибку, если
 * браузера нет — «страница не открылась» хуже, чем «не найден Chrome».
 */
export function pickBrowserPath() {
  for (const candidate of CHROME_PATHS) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Не найден ни Chrome, ни Edge в стандартных путях. Задайте CHROME_PATH или поставьте браузер в образ.',
  );
}

// Имена каталогов, которые оставляет Playwright:
//   playwright_chromiumdev_profile-XXXXXX — профиль пользователя,
//   playwright-artifacts-XXXXXX            — артефакты запуска.
const PROFILE_MARK = 'dev_profile-';
const ARTIFACTS_PREFIX = 'playwright-artifacts-';

/** Профиль считается протухшим после 30 минут: живой прогон столько не живёт. */
export const STALE_PROFILE_MS = 30 * 60 * 1000;

/** Каталог создан Playwright? Имя должно совпасть строго, без догадок. */
export function isPlaywrightTempDir(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.startsWith(ARTIFACTS_PREFIX)) return true;
  return name.startsWith('playwright_') && name.includes(PROFILE_MARK);
}

/**
 * Размер каталога в байтах. Обход ограничен по числу файлов, чтобы
 * «измерить» мусорный профиль не стоил дороже самой уборки.
 */
export function measureDirBytes(dir, { maxFiles = 20000 } = {}) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= maxFiles) return bytes;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      files += 1;
      try {
        bytes += statSync(full).size;
      } catch {
        // Файл исчез между чтением каталога и stat — это нормально.
      }
    }
  }
  return bytes;
}

/**
 * Уборка протухших профилей Playwright.
 *
 * @param {object}   [options]
 * @param {string}   [options.tmpDir]   где искать (по умолчанию os.tmpdir())
 * @param {number}   [options.minAgeMs] возраст, после которого каталог считается брошенным
 * @param {number}   [options.now]      текущее время (для тестов)
 * @param {boolean}  [options.dryRun]   только посчитать, ничего не удалять
 * @returns {{removed: Array, skipped: Array, freedBytes: number, scanned: number}}
 */
export function sweepStaleBrowserProfiles({
  tmpDir = os.tmpdir(),
  minAgeMs = STALE_PROFILE_MS,
  now = Date.now(),
  dryRun = false,
} = {}) {
  const removed = [];
  const skipped = [];
  let freedBytes = 0;
  let scanned = 0;

  let entries = [];
  try {
    entries = readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return { removed, skipped, freedBytes, scanned };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isPlaywrightTempDir(entry.name)) continue;
    scanned += 1;
    const full = path.join(tmpDir, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch (error) {
      skipped.push({ name: entry.name, reason: 'stat: ' + (error?.code || 'ошибка') });
      continue;
    }
    const age = now - mtimeMs;
    if (age < minAgeMs) {
      skipped.push({ name: entry.name, reason: 'свежий (' + Math.round(age / 1000) + ' с)' });
      continue;
    }
    const bytes = measureDirBytes(full);
    if (dryRun) {
      skipped.push({ name: entry.name, reason: 'would remove', bytes });
      continue;
    }
    try {
      rmSync(full, { recursive: true, force: true });
      removed.push({ name: entry.name, bytes });
      freedBytes += bytes;
    } catch (error) {
      skipped.push({ name: entry.name, reason: 'rm: ' + (error?.code || 'ошибка') });
    }
  }

  return { removed, skipped, freedBytes, scanned };
}

let sweptOnce = false;

/**
 * Уборка один раз на процесс: десятки точек входа не должны мерить одно и
 * то же по кругу. Возвращает результат первой уборки или null, если она уже
 * была.
 */
export function sweepStaleBrowserProfilesOnce(options = {}) {
  if (sweptOnce) return null;
  sweptOnce = true;
  return sweepStaleBrowserProfiles(options);
}

/** Короткая строка для лога: сколько каталогов убрано и сколько освободили. */
export function formatSweepReport(result) {
  if (!result) return 'уборка профилей: уже выполнялась';
  const mb = (result.freedBytes / (1024 * 1024)).toFixed(1);
  return (
    'уборка профилей Playwright: убрано ' + result.removed.length +
    ' из ' + result.scanned + ', освобождено ' + mb + ' МБ'
  );
}
