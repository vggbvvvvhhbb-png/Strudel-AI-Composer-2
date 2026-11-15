// Лицензии сэмпл-банков: реестр и его проверка.
//
// Проверяем то, что должно быть правдой всегда:
//   * каждый банк, который грузит приложение, есть в реестре лицензий;
//   * в записи есть лицензия, первоисточник, дата проверки и вердикт;
//   * банк без подтверждённой лицензии НЕ считается разрешённым;
//   * правовой статус виден наружу (отчёт для API).

import { describe, it, expect } from 'vitest';
import {
  auditLicenses,
  loadRegistry,
  licenseReport,
  attributionFor,
  VERDICT_OK,
  VERDICT_DECISION,
} from '../../server/music/licenses.js';
import { SAMPLE_SETS } from '../../src/sample-banks.js';

describe('реестр лицензий сэмплов', () => {
  it('все банки из кода есть в реестре лицензий', () => {
    const registry = loadRegistry();
    for (const key of SAMPLE_SETS) {
      expect(registry.licenses?.[key], `банк ${key} не зафиксирован`).toBeTruthy();
    }
  });

  it('в каждой записи есть лицензия, источник, дата и вердикт', () => {
    const audit = auditLicenses();
    expect(audit.incomplete).toEqual([]);
    expect(audit.missing).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('вердикт — одно из двух состояний, никаких выдуманных', () => {
    const audit = auditLicenses();
    for (const row of audit.banks) {
      expect([VERDICT_OK, VERDICT_DECISION]).toContain(row.verdict);
    }
  });

  it('банк без подтверждённой лицензии не считается разрешённым', () => {
    const audit = auditLicenses();
    const unresolved = audit.banks.filter((row) => !row.confirmed);
    // Сейчас не подтверждён ни один банк: лицензия dirt-samples отсутствует,
    // а у shabda:piano она пер-семпловая. Это измерение, а не ошибка.
    expect(unresolved.length).toBeGreaterThan(0);
    expect(audit.releaseBlocked).toBe(true);
    expect(audit.totals.unresolvedNames).toBeGreaterThan(0);
  });

  it('подтверждённый банк проходит, неподтверждённый — нет', () => {
    const fake = {
      banks: { 'bank:a': { names: ['x', 'y'] }, 'bank:b': { names: ['z'] } },
      licenses: {
        'bank:a': { license: 'MIT', source: 'https://example.test/a', checkedAt: '2026-11-15', verdict: VERDICT_OK },
        'bank:b': { license: 'не подтверждена', source: 'https://example.test/b', checkedAt: '2026-11-15', verdict: VERDICT_DECISION },
      },
    };
    const audit = auditLicenses(fake);
    expect(audit.ok).toBe(true);
    expect(audit.totals.confirmed).toBe(1);
    expect(audit.totals.unresolved).toBe(1);
    expect(audit.totals.names).toBe(3);
    expect(audit.totals.unresolvedNames).toBe(1);
    expect(audit.releaseBlocked).toBe(true);
  });

  it('банк без записи в реестре — это провал, а не «всё хорошо»', () => {
    const fake = {
      banks: { 'bank:a': { names: ['x'] } },
      licenses: {},
    };
    const audit = auditLicenses(fake);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual(['bank:a']);
    expect(audit.releaseBlocked).toBe(true);
  });

  it('неполная запись (нет источника) — тоже провал', () => {
    const fake = {
      banks: { 'bank:a': { names: ['x'] } },
      licenses: { 'bank:a': { license: 'MIT', checkedAt: '2026-11-15', verdict: VERDICT_OK } },
    };
    const audit = auditLicenses(fake);
    expect(audit.ok).toBe(false);
    expect(audit.incomplete.length).toBe(1);
  });

  it('отчёт для наружу содержит статус каждого банка и атрибуцию', () => {
    const report = licenseReport();
    expect(report.banks.length).toBe(SAMPLE_SETS.length);
    for (const bank of report.banks) {
      expect(typeof bank.attribution).toBe('string');
      expect(bank.attribution.length).toBeGreaterThan(0);
    }
    expect(typeof report.releaseBlocked).toBe('boolean');
  });

  it('атрибуция не выдумывает разрешение, которого нет', () => {
    const text = attributionFor({ license: 'не подтверждена', source: 'https://example.test' });
    expect(text).toContain('не подтверждена');
    expect(text).not.toMatch(/MIT|Apache|BSD/);
  });
});
