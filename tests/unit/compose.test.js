// Фаза 3 и 5: пайплайн compose, замечания к спеке, refine по спеке.
//
// Модель в тестах — заглушка: она отдаёт заранее заданные ответы.
// Так проверяется вся цепочка без обращения к сети.

import { describe, it, expect } from 'vitest';
import {
  buildTrack,
  detectSpecStyle,
  extractJson,
  fallbackSpec,
} from '../../server/music/compose/pipeline.js';
import { collectRemarks, applyRemark, energyProfile, REMARK_KINDS } from '../../server/music/compose/remarks.js';
import { refineSpec, refineOnce } from '../../server/music/compose/refine.js';
import { checkSpec } from '../../server/music/spec/check.js';
import { compile } from '../../server/music/compiler/index.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

/** Канонические входы создаются здесь, независимо от fallback. */
function goodSpec() {
  return {
    meta: { style: 'techno', bpm: 132, key: 'Fmin' },
    structure: { sections: [
      { name: 'intro', cycles: 8, energy: 0.25, harmony: 'Fm Db Bbm Cm' },
      { name: 'build', cycles: 8, energy: 0.6, harmony: 'Db Bbm Cm Fm', parameters: { cutoff: [300, 6000] } },
      { name: 'drop', cycles: 16, energy: 1, harmony: 'Bbm Fm Db Cm', parameters: { gain: [0.6, 1] } },
      { name: 'outro', cycles: 8, energy: 0.2, harmony: 'Fm Db Bbm Cm' },
    ] },
    parts: { roles: {
      hats: { activeIn: ['intro', 'build', 'drop', 'outro'], pattern: 'hh*8', sound: 's' },
      bass: { activeIn: ['intro', 'build', 'drop'], pattern: '0 ~ 2 4', sound: 'sawtooth' },
      kick: { activeIn: ['build', 'drop'], pattern: 'bd*4', sound: 's' },
      snare: { activeIn: ['drop'], pattern: '~ sd ~ sd', sound: 's' },
      arp: { activeIn: ['drop'], pattern: '0 2 4 6', sound: 'triangle' },
      texture: { activeIn: ['outro'], pattern: '0 ~ 2 ~', sound: 'sine' },
    } },
    reasoning: 'Плотный техно с дропом на 16 циклов.',
  };
}

function flatSpec() {
  return {
    meta: { style: 'techno', bpm: 132, key: 'Fmin' },
    structure: { sections: [
      { name: 'intro', cycles: 8, energy: 0.3, harmony: 'Fm Db Bbm Cm' },
      { name: 'drop', cycles: 8, energy: 0.3, harmony: 'Fm Db Bbm Cm' },
    ] },
    parts: { roles: { kick: { activeIn: ['intro', 'drop'], pattern: 'bd*4', sound: 's' } } },
  };
}

describe('фаза 3: определение стиля', () => {
  it('явный жанр побеждает слово настроения', () => {
    expect(detectSpecStyle('спокойный lo-fi с пианино')).toBe('lo-fi');
    expect(detectSpecStyle('жёсткий техно 132')).toBe('techno');
    expect(detectSpecStyle('drum and bass нейрофанк')).toBe('techno');
  });

  it('без явного жанра работает настроение', () => {
    expect(detectSpecStyle('что-то очень спокойное и медитативное')).toBe('ambient');
    expect(detectSpecStyle('эпичное и драматичное')).toBe('cinematic');
  });

  it('стиль всегда из списка SPEC_STYLES', () => {
    for (const text of ['что-то', 'lofi', 'хаус', 'рок', 'jazz', '']) {
      expect(['lo-fi', 'techno', 'house', 'ambient', 'dubstep', 'synthwave', 'trap', 'jazz', 'rock', 'cinematic']).toContain(
        detectSpecStyle(text),
      );
    }
  });
});

describe('фаза 3: разбор ответа модели', () => {
  it('читает чистый JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('вырезает JSON из markdown-обёртки', () => {
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('вырезает JSON из текста вокруг', () => {
    expect(extractJson('Вот план: {"a":3} готово')).toEqual({ a: 3 });
  });

  it('не выдумывает JSON, если его нет', () => {
    expect(extractJson('не json вовсе')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});

describe('фаза 3: пайплайн', () => {
  it('валидная спека с первого раза — компилируется и исполняется', async () => {
    const events = [];
    const built = await buildTrack({
      prompt: 'жёсткий техно',
      style: 'techno',
      completeChat: async () => JSON.stringify(goodSpec()),
      seed: 42,
      onEvent: (event) => events.push({ event }),
    });

    expect(built.usedFallback).toBe(false);
    expect(built.attempts).toBe(1);
    expect(events.map((e) => e.event)).toContain('spec');
    expect(events.map((e) => e.event)).toContain('compiled');

    // Код исполняется настоящим движком.
    const run = await runStrudel(built.compiled.code, { cycles: 32 });
    expect(run.ok).toBe(true);
    expect(run.order.length).toBeGreaterThan(3);
  });

  it('невалидная спека чинится одной итерацией', async () => {
    let call = 0;
    const built = await buildTrack({
      prompt: 'жёсткий техно',
      style: 'techno',
      completeChat: async () => {
        call += 1;
        if (call === 1) {
          // bpm вне диапазона, ключ не разбирается, форма — одна секция.
          return JSON.stringify({
            meta: { style: 'techno', bpm: 500, key: 'мусор' },
            harmony: { degrees: [0, 5, 2, 6] },
            form: [{ kind: 'intro', bars: 8, energy: 0.5, roles: { kick: { recipe: 'default' } } }],
          });
        }
        return JSON.stringify(goodSpec());
      },
      seed: 42,
    });

    expect(built.usedFallback).toBe(false);
    expect(built.attempts).toBe(2);
    expect(checkSpec(built.spec).ok).toBe(true);
  });

  it('если модель не помогла — работает запасной план из библиотеки', async () => {
    const built = await buildTrack({
      prompt: 'жёсткий техно',
      style: 'techno',
      completeChat: async () => 'это вообще не JSON',
      seed: 7,
    });

    expect(built.usedFallback).toBe(true);
    expect(checkSpec(built.spec).ok).toBe(true);
    const run = await runStrudel(built.compiled.code, { cycles: 32 });
    expect(run.ok).toBe(true);
  });

  it('запасная спека валидна для каждого стиля', () => {
    for (const style of ['lo-fi', 'techno', 'house', 'ambient', 'dubstep', 'synthwave', 'trap', 'jazz', 'rock', 'cinematic']) {
      const check = checkSpec(fallbackSpec(style, 3));
      expect(check.ok, `${style}: ${check.errors.join('; ')}`).toBe(true);
    }
  });

  it('компиляция детерминирована: та же спека — тот же код', () => {
    const spec = goodSpec();
    expect(compile(spec).code).toBe(compile(spec).code);
  });
});

describe('фаза 5: замечания к спеке', () => {
  it('энергия плоская — замечание есть', () => {
    const profile = energyProfile(flatSpec().structure.sections);
    expect(profile.flat).toBe(true);
    const remarks = collectRemarks(flatSpec());
    expect(remarks.some((r) => r.kind === REMARK_KINDS.FLAT_ENERGY)).toBe(true);
  });

  it('хорошая спека не даёт замечаний по энергии и переходам', () => {
    const remarks = collectRemarks(goodSpec());
    expect(remarks.some((r) => r.kind === REMARK_KINDS.FLAT_ENERGY)).toBe(false);
    expect(remarks.some((r) => r.kind === REMARK_KINDS.MISSING_TRANSITION)).toBe(false);
  });

  it('находит партию, которая не меняется', () => {
    const remarks = collectRemarks(flatSpec());
    expect(remarks.some((r) => r.kind === REMARK_KINDS.REPEATED_PART)).toBe(true);
  });

  it('каждое замечание говорит, что не так и что сделать', () => {
    for (const remark of collectRemarks(flatSpec())) {
      expect(remark.hint.length).toBeGreaterThan(20);
      expect(remark.hint).toMatch(/\.|«/); // есть конкретика
      expect(remark.action?.type).toBeTruthy();
    }
  });

  it('правка плоской энергии меняет энергии секций', () => {
    const spec = flatSpec();
    const remark = collectRemarks(spec).find((r) => r.kind === REMARK_KINDS.FLAT_ENERGY);
    const patched = applyRemark(spec, remark);
    const energies = patched.structure.sections.map((s) => s.energy);
    expect(Math.max(...energies) - Math.min(...energies)).toBeGreaterThan(0.4);
    expect(checkSpec(patched).ok).toBe(true);
  });

  it('правка партии меняет активность, не опустошая тихую секцию', () => {
    const spec = flatSpec();
    spec.parts.roles.pad = { activeIn: ['intro', 'drop'], pattern: '0 ~ 2 ~', sound: 'sine' };
    const remark = collectRemarks(spec).find((r) => r.kind === REMARK_KINDS.REPEATED_PART);
    const patched = applyRemark(spec, remark);
    expect(patched.parts.roles.kick.activeIn).toEqual(['drop']);
    expect(patched.parts.roles.pad.activeIn).toContain('intro');
    expect(spec.parts.roles.kick.activeIn).toEqual(['intro', 'drop']);
    expect(checkSpec(patched).ok).toBe(true);
  });

  it('правка добавления перехода оставляет спеку валидной', () => {
    const spec = flatSpec();
    const remark = collectRemarks(spec).find((r) => r.kind === REMARK_KINDS.MISSING_TRANSITION);
    const patched = applyRemark(spec, remark);
    expect(patched.structure.sections[1].parameters.gain).toEqual([0.6, 1]);
    expect(spec.structure.sections[1].parameters).toBeUndefined();
    expect(checkSpec(patched).ok).toBe(true);
  });
});

describe('фаза 5: refine по спеке', () => {
  it('останавливается, если прирост меньше двух баллов', async () => {
    const result = await refineSpec({
      spec: flatSpec(),
      scoreFn: async () => ({ total: 50, issues: [] }),
      maxIterations: 3,
    });
    expect(result.improved).toBe(false);
    expect(result.steps[0].applied).toBe(false);
  });

  it('применяет замечания и перекомпилирует, пока есть прирост', async () => {
    // Оценка растёт с числом секций: пока форма меняется — прирост есть.
    const scoreFn = async (code) => ({ total: code.split('\n').length, issues: [] });
    const result = await refineSpec({
      spec: flatSpec(),
      scoreFn,
      maxIterations: 3,
    });
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.after.total).toBeGreaterThanOrEqual(result.before.total);
    // Итоговая спека валидна и компилируется в исполняемый код.
    expect(checkSpec(result.spec).ok).toBe(true);
    const run = await runStrudel(result.code, { cycles: 16 });
    expect(run.ok).toBe(true);
  });

  it('не применяет правку, которая ломает валидность', () => {
    const { spec } = refineOnce(flatSpec(), [
      { id: 'x', kind: 'custom', label: 'x', hint: 'x', action: { type: 'unknown' } },
    ]);
    expect(spec).toBeNull();
  });
});
