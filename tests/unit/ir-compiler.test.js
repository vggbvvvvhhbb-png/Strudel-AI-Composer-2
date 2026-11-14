// Компилятор Composition IR → код Strudel: детерминизм, безопасность, исполнение.
import { describe, it, expect } from 'vitest';
import { planIR } from '../../src/ir/intent.js';
import { compileIR, engineKey, specKey } from '../../src/ir/compiler.js';
import {
  cloneIR,
  IR_MODES,
  IR_GROOVE_TEMPLATES,
  IR_SECTION_KINDS,
} from '../../src/ir/schema.js';
import { isKnownSound } from '../../src/ir/palette.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const ROMANS = ['I', 'V', 'vi', 'IV', 'ii', 'i', 'VII', 'III', 'bII', 'bVI', 'Imaj7', 'V7', 'iv'];
const COLORS = ['sus', 'add9', '7', 'borrowed', 'picardy', 'pedal'];
const SOUNDS = ['bd', 'sd', 'hh', 'cp', 'oh', 'sine', 'sawtooth', 'square', 'triangle', 'pink', 'brown', 'white'];
const TONICS = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'Bb', 'Eb', 'F#'];

/** Простой детерминированный генератор — без внешних зависимостей. */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick(list, rnd) {
  return list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
}

/** Случайный, но заведомо валидный по схеме IR. */
function randomIr(rnd) {
  const ir = planIR('база для фаззинга', { seed: 1 });
  ir.seed = Math.floor(rnd() * 2147483647);
  ir.meta.bpm = 40 + Math.floor(rnd() * 161);
  ir.meta.key = { tonic: pick(TONICS, rnd), mode: pick(IR_MODES, rnd) };
  ir.meta.genre = pick(['lofi', 'trip-hop', 'synthpop', 'dnb', 'ambient'], rnd);

  ir.sections = ir.sections.map((section, index) => {
    const bars = 1 + Math.floor(rnd() * 16);
    const harmony = [];
    for (let step = 0; step < bars; step += 1) {
      const item = { rn: pick(ROMANS, rnd), bars: 1 };
      if (rnd() > 0.6) item.color = pick(COLORS, rnd);
      harmony.push(item);
    }
    const layers = {};
    for (const [role, layer] of Object.entries(section.layers)) {
      layers[role] = {
        ...layer,
        density: rnd(),
        weight: rnd(),
        register: [24 + Math.floor(rnd() * 40), 60 + Math.floor(rnd() * 36)],
      };
    }
    return {
      ...section,
      id: `${section.id}-${index}`,
      kind: pick(IR_SECTION_KINDS, rnd),
      bars,
      energy: rnd(),
      tension: rnd(),
      harmony,
      layers,
    };
  });

  ir.groove = {
    template: pick(IR_GROOVE_TEMPLATES, rnd),
    amount: rnd(),
    swing: 0.5 + rnd() * 0.18,
    offsetMs: Math.round((rnd() * 40 - 20) * 100) / 100,
  };
  ir.palette = { kick: { ref: pick(SOUNDS, rnd) } };
  ir.motifs = {
    hook: {
      degrees: Array.from({ length: 6 }, () => Math.floor(rnd() * 7)),
      steps: [0, 2, 4, 6, 8, 10],
    },
  };
  return ir;
}

describe('Компиляция IR в код', () => {
  const ir = planIR('мрачный трип-хоп про дождь');
  const compiled = compileIR(ir);

  it('код задаёт темп и собирает партии через arrange', () => {
    expect(compiled.code).toContain('setCpm(');
    expect(compiled.code).toContain('const ms =');
    for (const role of compiled.roles) {
      expect(compiled.code, role.role).toContain(`$${role.label}: arrange(`);
    }
  });

  it('в коде нет случайности и опасных вызовов', () => {
    expect(compiled.code).not.toContain('Math.random');
    expect(compiled.code).not.toContain('Date.now');
    expect(compiled.code).not.toMatch(/\beval\s*\(/);
    expect(compiled.code).not.toContain('new Function');
  });

  it('одинаковый IR даёт побайтно одинаковый код и хеш', () => {
    const again = compileIR(cloneIR(ir));
    expect(again.code).toBe(compiled.code);
    expect(again.hash).toBe(compiled.hash);
  });

  it('два отдельно построенных одинаковых IR дают одинаковый хеш', () => {
    const first = compileIR(planIR('мрачный трип-хоп про дождь', { seed: 99 }));
    const second = compileIR(planIR('мрачный трип-хоп про дождь', { seed: 99 }));
    expect(second.hash).toBe(first.hash);
    expect(second.code).toBe(first.code);
  });

  it('разный зерно даёт другой код', () => {
    const other = compileIR(planIR('мрачный трип-хоп про дождь', { seed: 100 }));
    expect(other.hash).not.toBe(compiled.hash);
  });

  it('в коде нет NaN и undefined', () => {
    expect(compiled.code).not.toContain('NaN');
    expect(compiled.code).not.toContain('undefined');
  });
});

describe('Секции и спека в результате компиляции', () => {
  const ir = planIR('злой быстрый dnb');
  const compiled = compileIR(ir);

  it('секции результата повторяют секции IR и идут подряд', () => {
    expect(compiled.sections).toHaveLength(ir.sections.length);
    compiled.sections.forEach((section, index) => {
      expect(section.id).toBe(ir.sections[index].id);
      expect(section.bars).toBe(ir.sections[index].bars);
      expect(section.startBar).toBe(index === 0 ? 0 : compiled.sections[index - 1].endBar);
      expect(section.endBar).toBe(section.startBar + section.bars);
    });
    const total = compiled.sections.at(-1).endBar;
    expect(total).toBe(ir.sections.reduce((sum, section) => sum + section.bars, 0));
  });

  it('спека повторяет структуру IR', () => {
    expect(compiled.spec.structure.sections).toHaveLength(ir.sections.length);
    compiled.spec.structure.sections.forEach((section, index) => {
      expect(section.cycles).toBe(ir.sections[index].bars);
    });
    expect(compiled.spec.meta.key).toBe(specKey(ir.meta.key));
    expect(compiled.spec.meta.bpm).toBe(ir.meta.bpm);
  });

  it('строки лада для движка и для спеки различаются только форматом', () => {
    expect(engineKey(ir.meta.key)).toBe(`${ir.meta.key.tonic.toLowerCase()}:${ir.meta.key.mode}`);
    expect(specKey(ir.meta.key)).toBe(`${ir.meta.key.tonic}${ir.meta.key.mode}`);
  });
});

describe('Палитра и предупреждения', () => {
  it('неизвестный звук даёт предупреждение и откат к жанровой палитре', () => {
    const ir = planIR('мрачный трип-хоп про дождь');
    ir.palette = { kick: { ref: 'несуществующий-сэмпл' } };
    const compiled = compileIR(ir);
    expect(compiled.warnings.some((warning) => warning.includes('несуществующий-сэмпл'))).toBe(true);
    expect(compiled.code).toContain('s("bd")');
    expect(compiled.code).not.toContain('несуществующий-сэмпл');
  });

  it('известный звук перекрывает жанровую палитру без предупреждений', () => {
    const ir = planIR('мрачный трип-хоп про дождь');
    ir.palette = { kick: { ref: 'cp' } };
    const compiled = compileIR(ir);
    expect(compiled.warnings).toHaveLength(0);
    expect(compiled.code).toContain('s("cp")');
    expect(isKnownSound('cp')).toBe(true);
  });
});

describe('Фаззинг компилятора', () => {
  it('300 случайных валидных IR компилируются без исключений', () => {
    const rnd = makeRng(20241114);
    for (let index = 0; index < 300; index += 1) {
      const ir = randomIr(rnd);
      let compiled;
      expect(() => { compiled = compileIR(ir); }, `итерация ${index}`).not.toThrow();
      expect(compiled.code, `итерация ${index}`).not.toContain('NaN');
      expect(compiled.code, `итерация ${index}`).not.toContain('undefined');
      expect(compiled.code, `итерация ${index}`).toContain('setCpm(');
    }
  });
});

describe('Исполнение скомпилированного кода в движке', () => {
  it.each([
    ['мрачный трип-хоп про дождь', 8],
    ['злой быстрый dnb', 16],
    ['тревожный эмбиент, пустой космос', 20],
  ])('промпт «%s» исполняется и даёт события партий', async (prompt, firstKickBar) => {
    const compiled = compileIR(planIR(prompt));
    const run = await runStrudel(compiled.code, { cycles: 32 });
    expect(run.ok, run.error).toBe(true);
    expect(Object.keys(run.parts)).toEqual(expect.arrayContaining(['KICK', 'HATS', 'BASS', 'CHORDS', 'PAD']));
    for (const name of ['KICK', 'HATS', 'BASS', 'CHORDS', 'PAD']) {
      expect(run.parts[name].length, name).toBeGreaterThan(0);
      for (const event of run.parts[name]) {
        expect(Number.isFinite(event.whole.begin)).toBe(true);
        expect(event.whole.end).toBeGreaterThan(event.whole.begin);
      }
    }
    const kicks = run.parts.KICK.map((event) => event.whole.begin);
    expect(Math.min(...kicks)).toBeGreaterThanOrEqual(firstKickBar);
  });

  it('партии по ролям IR совпадают с партиями движка', async () => {
    const compiled = compileIR(planIR('эйфоричный фестиваль'));
    const run = await runStrudel(compiled.code, { cycles: 16 });
    expect(run.ok, run.error).toBe(true);
    const labels = compiled.roles.map((role) => role.label);
    for (const label of labels) expect(Object.keys(run.parts)).toContain(label);
  });

  it('снейр присутствует в треке: без него нет акцента на 2 и 4 долю', async () => {
    const compiled = compileIR(planIR('злой быстрый dnb'));
    // Арка club-64 начинается с 16-тактового интро, где снейра нет по
    // замыслу: смотреть надо глубже, до куплетной части.
    const run = await runStrudel(compiled.code, { cycles: 48 });
    expect(run.ok, run.error).toBe(true);
    // Матрица ролей теперь содержит снейр: трек без бэкбита звучит пусто.
    expect(Object.keys(run.parts)).toContain('SNARE');
    expect(compiled.roles.map((role) => role.role)).toContain('snare');
    const snares = run.parts.SNARE;
    expect(snares.length).toBeGreaterThan(0);
    // Снейр стоит на 2 и 4 долях (шаги 4 и 12 сетки 1/16).
    const steps = new Set(snares.map((event) => Math.round(event.whole.begin * 16) % 16));
    expect([...steps].every((step) => step === 4 || step === 12)).toBe(true);
  });
});
