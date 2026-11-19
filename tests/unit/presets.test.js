import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/presets/index.js';
import { staticValidate } from '../../src/core/validator.js';
import { parseParts, getBpm, getKey, captureMixer, applyMixerState } from '../../src/core/code-model.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

describe('встроенные пресеты', () => {
  it('все 6 пресетов валидны: BPM, key, ≥3 партии, статические проверки', () => {
    expect(PRESETS.length).toBe(6);
    for (const p of PRESETS) {
      expect(staticValidate(p.code).ok, p.name).toBe(true);
      expect(getBpm(p.code)).toBe(p.bpm);
      expect(getKey(p.code)).toBe(p.key);
      expect(parseParts(p.code).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('каждая партия пресета реально звучит: есть высоты или сэмпл', async () => {
    // Регресс: chord("...") без .voicing() даёт события, но БЕЗ высот —
    // партия молчала. Замер 19.11.2026: у всех шести пресетов аккордовая
    // партия была без высот, у ambient/techno/dnb (.voicing() поверх списка
    // нот) она не давала даже событий.
    for (const p of PRESETS) {
      const run = await runStrudel(p.code, { cycles: 4 });
      expect(run.ok, `${p.name}: ${run.error}`).toBe(true);
      for (const part of run.order) {
        const haps = run.parts[part];
        expect(haps.length, `${p.name}/${part}: партия без событий`).toBeGreaterThan(0);
        const sounds = haps.some((h) => h.value && (h.value.note || h.value.s));
        expect(sounds, `${p.name}/${part}: события без высот и без сэмпла`).toBe(true);
        const unvoiced = haps.some((h) => h.value && h.value.chord);
        expect(unvoiced, `${p.name}/${part}: chord() без .voicing() — партия без высот`).toBe(false);
      }
    }
  });

  it('в n("…") нет буквенных нот — только note() (регрессия: parse error)', () => {
    for (const p of PRESETS) {
      const bad = /\bn\(\s*"[^"]*[a-g][0-9]/.test(p.code);
      expect(bad, `${p.name}: буквенные ноты должны быть в note()`).toBe(false);
    }
  });

  it('имена пресетов без мусорных символов (защита от двойного кодирования)', () => {
    // Разрешены латиница, кириллица, пробелы и типографика — ничего больше.
    const allowed = /^[A-Za-z0-9Ѐ-ӿ\s«»–—.,!()&+\-/−]+$/u;    for (const p of PRESETS) {
      expect(allowed.test(p.name), `${p.id}: «${p.name}»`).toBe(true);
    }
  });

  it('capture/apply состояния микшера — обратимая операция', () => {
    const lofi = PRESETS.find((p) => p.id === 'lofi');
    const snap = captureMixer(lofi.code).map((c, i) => (i === 0 ? { ...c, gain: 0.2, muted: true } : c));
    const edited = applyMixerState(lofi.code, snap);
    expect(captureMixer(edited)).toEqual(snap);
    // партия без снимка не изменилась
    expect(edited).toContain('$HATS:');
  });
});
