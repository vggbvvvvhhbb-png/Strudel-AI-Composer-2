// Гейт фактов: белые списки правил проверяются НА ЖИВОМ ДВИЖКЕ.
//
// ЗАЧЕМ. Правила линтера опираются на списки измеренных имён и ладов. Если
// движок обновится (или список разойдётся с реальностью), правила начнут
// врать — и будут врать молча, потому что код валиден. Этот тест — страховка.
//
// Тест НЕ доверяет docs/STRUDEL-FACTS.md: он перепроверяет всё сам, через
// настоящий queryArc. Документ — отчёт о замере, тест — сам замер.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadStrudel, runStrudel } from '../../server/music/strudel-runtime.mjs';
import { MEASURED_MODES, MEASURED_NAMES } from '../../src/core/rules.js';

const root = resolve(process.cwd());

/** События одной партии по настоящему Strudel. */
async function events(code, cycles = 1) {
  const run = await runStrudel(`$T: ${code}`, { cycles });
  if (!run.ok) return { ok: false, error: run.error, events: [], notes: [] };
  const haps = run.parts.T || [];
  return {
    ok: true,
    error: null,
    events: haps.length,
    notes: haps.filter((h) => h.value?.note).map((h) => h.value.note),
    chords: haps.filter((h) => h.value?.chord).map((h) => h.value.chord),
  };
}

describe('измеренные лады живы', () => {
  it.each([...MEASURED_MODES])('лад %s даёт события и высоты', async (mode) => {
    const res = await events(`n("0 2 4 5 7").scale("c:${mode}")`);
    expect(res.ok, `${mode}: ${res.error}`).toBe(true);
    expect(res.events, `${mode}: событий нет`).toBeGreaterThan(0);
    expect(res.notes.length, `${mode}: высот нет`).toBeGreaterThan(0);
  });

  it('лады с пробелом или подчёркиванием НЕ рабочие (на этом стоит правило R1)', async () => {
    const broken = await events('n("0 2 4 5 7").scale("a:harmonic_minor")');
    expect(broken.events).toBe(0);
    const withSpace = await events('n("0 2 4 5 7").scale("a harmonic minor")');
    // С пробелом движок не падает, но и ноты не те — это хуже ошибки.
    expect(withSpace.notes).not.toContain('A3');
  });
});

describe('измеренные имена живые', () => {
  it('каждое имя из списка — экспорт или метод паттерна', async () => {
    const api = await loadStrudel();
    const exports = new Set(Object.keys(api));
    const methods = new Set(Object.getOwnPropertyNames(api.Pattern.prototype));
    const unknown = [...MEASURED_NAMES].filter((name) => !exports.has(name) && !methods.has(name));
    expect(unknown, `имена, которых нет в движке: ${unknown.join(', ')}`).toEqual([]);
  });

  it('duckOrBit не существует — правило R3 не выдумано', async () => {
    const res = await events('s("bd*4").duckOrBit(2)');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/duckOrBit/);
  });

  it('duckorbit работает', async () => {
    const res = await events('s("bd*4").duckorbit(2).duckattack(0.2).duckdepth(1)');
    expect(res.ok).toBe(true);
    expect(res.events).toBeGreaterThan(0);
  });
});

describe('измеренные аккорды живые', () => {
  it('chord без .voicing() не даёт высот', async () => {
    const res = await events('chord("Am")');
    expect(res.ok).toBe(true);
    expect(res.notes.length).toBe(0);
  });

  it('chord с .voicing() даёт высоты', async () => {
    const res = await events('chord("Am").voicing()');
    expect(res.ok).toBe(true);
    expect(res.notes.length).toBeGreaterThan(0);
  });

  it('chord со списком нот теряет высоты (на этом стоит правило R2)', async () => {
    const res = await events('chord("<a3 c4 e4> <f3 a3 c4>")');
    expect(res.ok).toBe(true);
    expect(res.notes.length).toBe(0);
    expect(res.chords.length).toBeGreaterThan(0);
  });

  it('note со списком нот в скобках даёт высоты', async () => {
    const res = await events('note("<[a3,c4,e4] [f3,a3,c4]>")');
    expect(res.ok).toBe(true);
    expect(res.notes.length).toBeGreaterThan(0);
  });
});

describe('реестр фактов соответствует движку', () => {
  it('версия в docs/STRUDEL-FACTS.md совпадает с установленной', () => {
    const doc = readFileSync(resolve(root, 'docs/STRUDEL-FACTS.md'), 'utf8');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@strudel/web']).toBe('1.3.0');
    expect(doc).toContain('@strudel/web` версии **1.3.0**');
  });

  it('машинный слепок фактов существует и той же версии', () => {
    const facts = JSON.parse(readFileSync(resolve(root, 'docs/evidence/strudel/facts.json'), 'utf8'));
    expect(facts.version).toBe('1.3.0');
    expect(facts.api.exports).toBeGreaterThan(900);
    expect(facts.api.patternMethods).toBeGreaterThan(1000);
    expect(Array.isArray(facts.sounds) && facts.sounds.length).toBeTruthy();
  });
});
