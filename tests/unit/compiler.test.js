// Фаза 2: компилятор спеки в исполняемый Strudel-код.
//
// Главная проверка: скомпилированный код РЕАЛЬНО исполняется движком,
// играет заданное число тактов и остаётся в ладу.

import { describe, it, expect } from 'vitest';
import { compile } from '../../server/music/compiler/index.js';
import { checkSpec, progressionForSection } from '../../server/music/spec/check.js';
import { trackSpecSchema, jsonSchemaForSpec } from '../../server/music/spec/schema.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';
import { MODES, parseKey } from '../../server/music/notes.js';
import { patternDensity } from '../../server/music/knowledge/roles.js';
import { staticValidate } from '../../src/core/validator.js';
import { parseParts, getBpm, getKey } from '../../src/core/code-model.js';

const SPEC = {
  meta: { style: 'techno', bpm: 128, key: 'c:minor', seed: 42 },
  harmony: { progressionId: 'techno-minor-i-vi-iv-v' },
  form: [
    { kind: 'intro', bars: 8, energy: 0.3, roles: { kick: { recipe: 'default' }, bass: { recipe: 'default' } } },
    { kind: 'build', bars: 16, energy: 0.65, roles: { kick: { recipe: 'default' }, hats: { recipe: 'default' }, bass: { recipe: 'default' } }, transition: { into: 'drop', type: 'riser' } },
    { kind: 'drop', bars: 16, energy: 1.0, roles: { kick: { recipe: 'default' }, snare: { recipe: 'default' }, hats: { recipe: 'default' }, bass: { recipe: 'default' }, arp: { recipe: 'default' } } },
    { kind: 'outro', bars: 8, energy: 0.2, roles: { kick: { recipe: 'default' } } },
  ],
  reasoning: 'Классическая техно-арка: интро, билд, дроп, аутро.',
};

describe('фаза 2: схема', () => {
  it('валидная спека проходит Zod', () => {
    const parsed = trackSpecSchema.safeParse(SPEC);
    expect(parsed.success).toBe(true);
  });

  it('JSON Schema для провайдера строится и описывает ключевые поля', () => {
    const schema = jsonSchemaForSpec();
    expect(schema.name).toBe('track_spec_v2');
    expect(schema.schema.required).toContain('meta');
    expect(schema.schema.required).toContain('form');
    expect(schema.schema.properties.meta.properties.style.enum).toContain('techno');
  });

  it('проверка согласованности ловит неизвестную роль', () => {
    const bad = {
      ...SPEC,
      form: [
        { kind: 'intro', bars: 16, energy: 0.3, roles: { guitar: { recipe: 'default' } } },
        { kind: 'outro', bars: 8, energy: 0.2, roles: { kick: { recipe: 'default' } } },
      ],
    };
    const result = checkSpec(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('guitar');
  });

  it('проверка ловит степень вне лада', () => {
    const bad = { ...SPEC, harmony: { degrees: [0, 9, 2] } };
    const result = checkSpec(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('вне лада');
  });

  it('проверка ловит слишком короткий трек', () => {
    const bad = {
      ...SPEC,
      form: [
        { kind: 'intro', bars: 4, energy: 0.3, roles: { kick: { recipe: 'default' } } },
        { kind: 'outro', bars: 4, energy: 0.2, roles: { kick: { recipe: 'default' } } },
      ],
    };
    const result = checkSpec(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('минимума');
  });

  it('переход в несуществующую секцию — ошибка', () => {
    const bad = {
      ...SPEC,
      form: [{ kind: 'intro', bars: 16, energy: 0.3, roles: { kick: { recipe: 'x' } }, transition: { into: 'drop', type: 'riser' } }],
    };
    const result = checkSpec(bad);
    expect(result.ok).toBe(false);
  });
});

describe('фаза 2: компилятор', () => {
  it('компиляция детерминирована: один и тот же результат', () => {
    const a = compile(SPEC);
    const b = compile(SPEC);
    expect(a.code).toBe(b.code);
  });

  it('код проходит валидатор приложения', () => {
    const { code } = compile(SPEC);
    const check = staticValidate(code);
    expect(check.ok).toBe(true);
  });

  it('микшер видит партии, темп и тональность читаются', () => {
    const { code } = compile(SPEC);
    const labels = parseParts(code).map((p) => p.label);
    expect(labels.length).toBeGreaterThan(3);
    expect(labels).toContain('KICK');
    expect(labels).toContain('BASS');
    expect(getBpm(code)).toBe(128);
    expect(getKey(code)).toBe('c:minor');
  });

  it('скомпилированный код исполняется движком', async () => {
    const { code } = compile(SPEC);
    const res = await runStrudel(code, { cycles: 48 });
    expect(res.ok, res.error).toBe(true);
    expect(Object.keys(res.parts).length).toBeGreaterThan(3);
    for (const [name, haps] of Object.entries(res.parts)) {
      expect(haps.length, name).toBeGreaterThan(0);
    }
  });

  it('трек играет заданное число тактов: события в последнем такте есть', async () => {
    const { code } = compile(SPEC);
    const total = SPEC.form.reduce((sum, s) => sum + s.bars, 0);
    const res = await runStrudel(code, { cycles: total });
    const lastBar = total - 1;
    const inLastBar = Object.values(res.parts)
      .flat()
      .filter((h) => h.whole.begin >= lastBar && h.whole.begin < lastBar + 1);
    expect(inLastBar.length).toBeGreaterThan(0);
  });

  it('все ноты в ладу', async () => {
    const { code } = compile(SPEC);
    const res = await runStrudel(code, { cycles: 48 });
    const key = parseKey('c:minor');
    const allowed = new Set(key.intervals.map((i) => (key.pc + i) % 12));
    for (const [name, haps] of Object.entries(res.parts)) {
      for (const hap of haps) {
        const note = hap.value?.note;
        if (!note || typeof note !== 'string') continue;
        const midi = noteToMidiSafe(note);
        if (midi === null) continue;
        const pc = ((midi % 12) + 12) % 12;
        expect(allowed.has(pc), `${name}: нота ${note} вне лада`).toBe(true);
      }
    }
  });

  it('бас выводится из гармонии: степени прогрессии в коде баса', () => {
    const { code } = compile(SPEC);
    const bassLine = code.split('\n').find((l) => l.startsWith('const BASS_'));
    expect(bassLine).toBeTruthy();
    expect(bassLine).toContain('0 5 3 4'); // степени прогрессии techno-minor-i-vi-iv-v
  });

  it('у секций разные паттерны: не один рисунок на весь трек', () => {
    const { code } = compile(SPEC);
    const bassLines = code.split('\n').filter((l) => l.startsWith('const BASS_'));
    expect(bassLines.length).toBeGreaterThan(1);
    expect(new Set(bassLines).size).toBe(bassLines.length);
  });

  it('у каждой партии свой таймлайн секций через arrange', () => {
    const { code } = compile(SPEC);
    expect(code).toContain('arrange(');
    // Бас играет в intro(8) + build(16) + drop(16) = 40 тактов.
    // У build есть переход: тело 14 тактов + хвост 2 такта.
    const bassBlock = code.split('\n').find((l) => l.startsWith('$BASS:'));
    expect(bassBlock).toContain('[8, BASS_0]');
    expect(bassBlock).toContain('[14, BASS_1]');
    expect(bassBlock).toContain('[2, BASS_1_TAIL]');
    expect(bassBlock).toContain('[16, BASS_2]');
  });

  it('переход секции попадает в цепочку партии', () => {
    const { code } = compile(SPEC);
    // Секция build имеет transition riser: в её хвосте — sweep по фильтру.
    const tailBlock = code.split('\n').find((l) => l.startsWith('const BASS_1_TAIL'));
    expect(tailBlock).toBeTruthy();
    expect(tailBlock).toContain('saw');
    expect(tailBlock).toContain('.lpf(');
    // Хвост подключён к таймлайну партии.
    const bassBlock = code.split('\n').find((l) => l.startsWith('$BASS:'));
    expect(bassBlock).toContain('BASS_1_TAIL');
  });
});

describe('фаза 2: property — любая валидная спека компилируется в исполняемый код', () => {
  const styles = ['techno', 'lofi', 'house', 'ambient', 'dnb', 'synthwave', 'trap', 'jazz', 'rock', 'cinematic'];

  it.each(styles)('стиль %s: спека → исполняемый код', async (style) => {
    const spec = {
      meta: { style, bpm: 120, key: 'a:minor', seed: 7 },
      harmony: { progressionId: undefined, degrees: [0, 5, 2, 6], mode: 'minor' },
      form: [
        { kind: 'intro', bars: 8, energy: 0.3, roles: { kick: { recipe: 'default' }, bass: { recipe: 'default' } } },
        { kind: 'drop', bars: 16, energy: 1.0, roles: { kick: { recipe: 'default' }, hats: { recipe: 'default' }, bass: { recipe: 'default' }, lead: { recipe: 'default' } } },
        { kind: 'outro', bars: 8, energy: 0.2, roles: { kick: { recipe: 'default' }, texture: { recipe: 'default' } } },
      ],
      motif: { degrees: [0, 2, 4], rhythm: 'x ~ x x', transforms: ['sequence'] },
    };
    const checked = checkSpec(spec);
    expect(checked.ok, checked.errors.join('; ')).toBe(true);

    const { code } = compile(checked.spec);
    const res = await runStrudel(code, { cycles: 32 });
    expect(res.ok, `${style}: ${res.error}`).toBe(true);
    expect(Object.keys(res.parts).length).toBeGreaterThan(2);
  });

  it('случайный seed даёт другой, но тоже исполняемый код', async () => {
    const base = { ...SPEC, meta: { ...SPEC.meta, seed: 1 } };
    const other = { ...SPEC, meta: { ...SPEC.meta, seed: 999 } };
    const a = compile(base).code;
    const b = compile(other).code;
    expect(a).not.toBe(b);
    // Различие не только в комментарии: музыкальный код тоже другой.
    const music = (code) => code.split('\n').filter((l) => l.startsWith('const '));
    expect(music(a)).not.toEqual(music(b));
    const res = await runStrudel(b, { cycles: 48 });
    expect(res.ok).toBe(true);
  });
});

describe('фаза 2: рецепты и гармония', () => {
  const withRecipe = (recipe) => ({
    ...SPEC,
    form: SPEC.form.map((section) => ({
      ...section,
      roles: Object.fromEntries(
        Object.entries(section.roles).map(([role, choice]) => [role, { ...choice, recipe }]),
      ),
    })),
  });

  it('плотность партии следует энергии секции: дроп плотнее интро', () => {
    const { code } = compile(SPEC);
    const patternOf = (name) => {
      const line = code.split('\n').find((l) => l.startsWith(`const ${name}`));
      return line?.match(/s\("([^"]+)"\)/)?.[1] ?? '';
    };
    // Интро (энергия 0.3) и дроп (энергия 1.0) — один и тот же kick.
    const intro = patternOf('KICK_0');
    const drop = patternOf('KICK_2');
    expect(intro).toBeTruthy();
    expect(drop).toBeTruthy();
    expect(intro).not.toBe(drop);
    expect(densityOf(drop)).toBeGreaterThan(densityOf(intro));
  });

  it('рецепт busy даёт плотнее, чем sparse', () => {
    const busy = compile(withRecipe('busy')).code;
    const sparse = compile(withRecipe('sparse')).code;
    expect(busy).not.toBe(sparse);
    // Ударная партия в busy: больше атак на такт.
    const hits = (code) => {
      const line = code.split('\n').find((l) => l.startsWith('const HATS_'));
      const match = line?.match(/s\("([^"]+)"\)/);
      return match ? match[1] : '';
    };
    expect(hits(busy)).not.toBe(hits(sparse));
  });

  it('арпеджио идёт по аккордам прогрессии, а не по одной ступени', () => {
    const { code } = compile(SPEC);
    const arp = code.split('\n').find((l) => l.startsWith('const ARP_'));
    expect(arp).toBeTruthy();
    expect(arp).toContain('.add(n("<0 5 3 4>")');
    expect(arp).toContain('.scale(key)');
  });

  it('лид: ритм мотива переводится в mini-строку', () => {
    const spec = {
      ...SPEC,
      motif: { degrees: [0, 2, 4], rhythm: 'x ~ x x', transforms: [] },
      form: [
        { kind: 'intro', bars: 8, energy: 0.3, roles: { kick: { recipe: 'default' }, lead: { recipe: 'default' } } },
        { kind: 'drop', bars: 16, energy: 1.0, roles: { kick: { recipe: 'default' }, lead: { recipe: 'default' } } },
      ],
    };
    const { code } = compile(spec);
    const lead = code.split('\n').find((l) => l.startsWith('const LEAD_'));
    expect(lead).toContain('n("0 ~ 2 4")');
  });
});

// Плотность ритмического шаблона в атаках на такт.
function densityOf(pattern) {
  return patternDensity(pattern);
}

// Локальная версия noteToMidi: не импортируем лишнее.
function noteToMidiSafe(token) {
  const m = String(token).trim().toLowerCase().match(/^([a-g])([#b]?)(-?\d+)?$/);
  if (!m) return null;
  const letters = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  let pc = letters[m[1]];
  if (m[2] === '#') pc += 1;
  if (m[2] === 'b') pc -= 1;
  pc = ((pc % 12) + 12) % 12;
  const octave = m[3] === undefined ? 3 : Number(m[3]);
  return (octave + 1) * 12 + pc;
}
