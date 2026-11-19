// Уборка осиротевших профилей Playwright: правила отбора, порог возраста,
// освобождение места и отказ трогать чужое.
//
// Модуль чистый по файловой системе: на вход подаётся каталог, на выходе —
// что убрано, что пропущено и почему. Никакого реального браузера здесь.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isPlaywrightTempDir,
  measureDirBytes,
  sweepStaleBrowserProfiles,
  sweepStaleBrowserProfilesOnce,
  formatSweepReport,
  STALE_PROFILE_MS,
} from '../../lib/browser.mjs';

const HOUR = 60 * 60 * 1000;

function makeDir(root, name, ageMs = 0, bytes = 0) {
  const full = path.join(root, name);
  mkdirSync(full, { recursive: true });
  if (bytes > 0) writeFileSync(path.join(full, 'blob.bin'), Buffer.alloc(bytes, 7));
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(full, when, when);
  }
  return full;
}

describe('isPlaywrightTempDir — отбор каталогов по имени', () => {
  it('узнаёт профиль Chromium и артефакты запуска', () => {
    expect(isPlaywrightTempDir('playwright_chromiumdev_profile-abc123')).toBe(true);
    expect(isPlaywrightTempDir('playwright_firefoxdev_profile-abc123')).toBe(true);
    expect(isPlaywrightTempDir('playwright-artifacts-abc123')).toBe(true);
  });

  it('не трогает чужие каталоги, даже похожие', () => {
    expect(isPlaywrightTempDir('playwright')).toBe(false);
    expect(isPlaywrightTempDir('playwright_chromiumdev_profile')).toBe(false);
    expect(isPlaywrightTempDir('my_playwright_chromiumdev_profile-abc')).toBe(false);
    expect(isPlaywrightTempDir('chrome-profile')).toBe(false);
    expect(isPlaywrightTempDir('')).toBe(false);
    expect(isPlaywrightTempDir(undefined)).toBe(false);
  });
});

describe('measureDirBytes — размер каталога', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sweep-measure-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('суммирует файлы во вложенных каталогах', () => {
    writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(100));
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'nested', 'b.bin'), Buffer.alloc(250));
    expect(measureDirBytes(dir)).toBe(350);
  });

  it('пустой каталог — ноль байт, а не ошибка', () => {
    expect(measureDirBytes(dir)).toBe(0);
  });
});

describe('sweepStaleBrowserProfiles — уборка мусора Playwright', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sweep-root-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('убирает брошенный профиль и освобождает место', () => {
    const stale = makeDir(root, 'playwright_chromiumdev_profile-stale', 2 * HOUR, 2048);
    const result = sweepStaleBrowserProfiles({ tmpDir: root, now: Date.now() });

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].name).toBe('playwright_chromiumdev_profile-stale');
    expect(result.freedBytes).toBeGreaterThanOrEqual(2048);
    expect(existsSync(stale)).toBe(false);
  });

  it('живой профиль не трогает: возраст меньше порога', () => {
    const fresh = makeDir(root, 'playwright_chromiumdev_profile-live', 60 * 1000, 512);
    const result = sweepStaleBrowserProfiles({ tmpDir: root, now: Date.now() });

    expect(result.removed).toHaveLength(0);
    expect(existsSync(fresh)).toBe(true);
    expect(result.skipped.some((s) => /свежий/.test(s.reason))).toBe(true);
  });

  it('чужие каталоги остаются нетронутыми', () => {
    const other = makeDir(root, 'user-downloads', 5 * HOUR, 100);
    const other2 = makeDir(root, 'chrome-profile', 5 * HOUR, 100);
    const result = sweepStaleBrowserProfiles({ tmpDir: root, now: Date.now() });

    expect(result.removed).toHaveLength(0);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(other2)).toBe(true);
  });

  it('сухая уборка считает, но ничего не удаляет', () => {
    makeDir(root, 'playwright_chromiumdev_profile-stale', 2 * HOUR, 4096);
    const result = sweepStaleBrowserProfiles({ tmpDir: root, now: Date.now(), dryRun: true });

    expect(result.removed).toHaveLength(0);
    expect(result.skipped.some((s) => s.reason === 'would remove')).toBe(true);
    expect(existsSync(path.join(root, 'playwright_chromiumdev_profile-stale'))).toBe(true);
  });

  it('порог возраста настраивается', () => {
    makeDir(root, 'playwright_chromiumdev_profile-mid', 10 * 60 * 1000, 128);
    const result = sweepStaleBrowserProfiles({ tmpDir: root, now: Date.now(), minAgeMs: 5 * 60 * 1000 });
    expect(result.removed).toHaveLength(1);
  });

  it('несуществующий каталог — пустой результат, без исключения', () => {
    const result = sweepStaleBrowserProfiles({ tmpDir: path.join(root, 'нет-такого'), now: Date.now() });
    expect(result).toEqual({ removed: [], skipped: [], freedBytes: 0, scanned: 0 });
  });
});

describe('sweepStaleBrowserProfilesOnce — уборка один раз на процесс', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sweep-once-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('второй вызов не делает работу повторно', () => {
    makeDir(root, 'playwright_chromiumdev_profile-a', 2 * HOUR, 64);
    const first = sweepStaleBrowserProfilesOnce({ tmpDir: root, now: Date.now() });
    expect(first).not.toBeNull();
    expect(first.removed).toHaveLength(1);

    makeDir(root, 'playwright_chromiumdev_profile-b', 2 * HOUR, 64);
    const second = sweepStaleBrowserProfilesOnce({ tmpDir: root, now: Date.now() });
    expect(second).toBeNull();
    // Второй каталог остаётся: повторной уборки в этом процессе не было.
    expect(existsSync(path.join(root, 'playwright_chromiumdev_profile-b'))).toBe(true);
  });
});

describe('formatSweepReport — строка для лога', () => {
  it('печатает числа, а не обещания', () => {
    const line = formatSweepReport({ removed: [{ name: 'a', bytes: 1048576 }], skipped: [], freedBytes: 1048576, scanned: 1 });
    expect(line).toContain('1');
    expect(line).toContain('1.0 МБ');
  });

  it('состояние «уже выполнялась» не выдаёт себя за уборку', () => {
    expect(formatSweepReport(null)).toContain('уже выполнялась');
  });
});

describe('порог по умолчанию', () => {
  it('30 минут — живой прогон столько не живёт', () => {
    expect(STALE_PROFILE_MS).toBe(30 * 60 * 1000);
  });
});
