// Каноническая спека → код → реальные события Strudel.
import { describe, it, expect } from 'vitest';
import { compile, compileTrackSpec } from '../../server/music/compiler/index.js';
import { checkSpec, progressionForSection } from '../../server/music/spec/check.js';
import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';
import { fallbackSpec } from '../../server/music/compose/pipeline.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';
import { parseKey } from '../../server/music/notes.js';
import { staticValidate } from '../../src/core/validator.js';
import { parseParts, getBpm, getKey } from '../../src/core/code-model.js';

const SPEC = {
  meta: { style: 'techno', bpm: 128, key: 'Cmin' },
  structure: { sections: [
    { name: 'intro', cycles: 8, energy: 0.3, harmony: 'Cm Ab Fm Gm' },
    { name: 'build', cycles: 16, energy: 0.65, harmony: 'Fm Cm Ab Gm', parameters: { cutoff: [300, 7000] } },
    { name: 'drop', cycles: 16, energy: 1, harmony: 'Cm Ab Fm Gm', parameters: { gain: [0.6, 1] } },
    { name: 'outro', cycles: 8, energy: 0.2, harmony: 'Ab Fm Gm Cm' },
  ] },
  parts: { roles: {
    kick: { activeIn: ['intro', 'build', 'drop', 'outro'], pattern: 'bd*4', sound: 's' },
    hats: { activeIn: ['build', 'drop'], pattern: 'hh*8', sound: 's' },
    snare: { activeIn: ['drop'], pattern: '~ sd ~ sd', sound: 's' },
    bass: { activeIn: ['intro', 'build', 'drop'], pattern: '0 ~ 2 4', sound: 'sawtooth' },
    arp: { activeIn: ['drop'], pattern: '0 2 4 6', sound: 'triangle' },
  } },
};
const copy = () => structuredClone(SPEC);

/**
 * Сколько раз ряд значений меняет направление. Монотонный рамп — ноль.
 * Именно эта величина отличала рабочий `time.slow(N)` от сломанного
 * `sine.slow(N)`, который за секцию проходил полный период синуса (D-160).
 */
function directionChanges(values) {
  let turns = 0;
  for (let i = 2; i < values.length; i += 1) {
    const prev = values[i - 1] - values[i - 2];
    const cur = values[i] - values[i - 1];
    if (prev !== 0 && cur !== 0 && Math.sign(prev) !== Math.sign(cur)) turns += 1;
  }
  return turns;
}

describe('каноническая схема и смысловые границы', () => {
  it('валидный план проходит единую Zod-схему без изменения полей', () => {
    expect(TrackSpecSchema.parse(SPEC)).toEqual(SPEC);
  });
  it('перечисления берутся из канонической схемы', () => {
    expect(TrackSpecSchema.shape.meta.shape.style.options).toContain('lo-fi');
    expect(TrackSpecSchema.shape.meta.shape.style.options).not.toContain('dnb');
  });
  it('неизвестная роль отклоняется', () => {
    const bad = copy(); bad.parts.roles.guitar = bad.parts.roles.bass;
    const result = checkSpec(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('guitar');
  });
  it('объектная гармония не преобразуется в строку', () => {
    const bad = copy(); bad.structure.sections[0].harmony = { degrees: [0, 9, 2] };
    expect(checkSpec(bad).ok).toBe(false);
    expect(() => compileTrackSpec(bad)).toThrow();
  });
  it.each([15, 97])('длительность %i вне диапазона отклоняется', (total) => {
    const bad = copy();
    bad.structure.sections = [{ ...bad.structure.sections[0], cycles: total }];
    Object.values(bad.parts.roles).forEach((part) => { part.activeIn = ['intro']; });
    expect(checkSpec(bad).ok).toBe(false);
    expect(() => compileTrackSpec(bad)).toThrow(/Invalid TrackSpec/);
  });
  it.each([16, 96])('длительность %i на границе разрешена', (total) => {
    const spec = copy(); spec.structure.sections.forEach((s) => { s.cycles = total / 4; });
    expect(checkSpec(spec).ok).toBe(true);
  });
  it('ссылка activeIn на отсутствующую секцию отклоняется', () => {
    const bad = copy(); bad.parts.roles.bass.activeIn.push('bridge');
    expect(checkSpec(bad).ok).toBe(false);
  });
  it('старые обязательные поля не заменяют новый контракт', () => {
    expect(checkSpec({ meta: SPEC.meta, form: [], harmony: {} }).ok).toBe(false);
  });
  it('гармония секции возвращается строкой', () => {
    expect(progressionForSection(SPEC, 1)).toBe('Fm Cm Ab Gm');
  });
});

describe('детерминированная компиляция и интеграция с приложением', () => {
  it('строковый интерфейс синхронный и детерминированный; поля обёртки сохранены', () => {
    const code = compileTrackSpec(SPEC);
    expect(typeof code).toBe('string');
    expect(compileTrackSpec(copy())).toBe(code);
    const compiled = compile(SPEC);
    expect(Object.keys(compiled).sort()).toEqual(['code', 'parts', 'sections', 'trace', 'warnings']);
    expect(compiled.code).toBe(code);
  });
  it('код проходит валидатор приложения', () => {
    expect(staticValidate(compileTrackSpec(SPEC)).ok).toBe(true);
  });
  it('микшер видит партии, темп и тональность', () => {
    const code = compileTrackSpec(SPEC);
    expect(parseParts(code).map((p) => p.label)).toEqual(expect.arrayContaining(['KICK', 'BASS', 'ARP', 'HATS']));
    expect(getBpm(code)).toBe(128);
    expect(getKey(code)).toBe('c:minor');
  });
  it('код исполняется и все партии дают события', async () => {
    const run = await runStrudel(compileTrackSpec(SPEC), { cycles: 48 });
    expect(run.ok, run.error).toBe(true);
    expect(Object.keys(run.parts)).toHaveLength(5);
    Object.values(run.parts).forEach((haps) => expect(haps.length).toBeGreaterThan(0));
  });
  it('порядок, длительности и события последнего цикла сохраняются', async () => {
    const compiled = compile(SPEC);
    expect(compiled.sections.map((s) => [s.kind, s.startBar, s.endBar])).toEqual([
      ['intro', 0, 8], ['build', 8, 24], ['drop', 24, 40], ['outro', 40, 48],
    ]);
    const run = await runStrudel(compiled.code, { cycles: 48 });
    expect(run.ok, run.error).toBe(true);
    expect(run.parts.KICK.filter((h) => h.whole.begin >= 47 && h.whole.begin < 48)).toHaveLength(4);
    expect(run.parts.BASS.filter((h) => h.whole.begin >= 40)).toHaveLength(0);
  });
  it('тональные события реально лежат в ладу, проверка не пустая', async () => {
    const run = await runStrudel(compileTrackSpec(SPEC), { cycles: 48 });
    expect(run.ok, run.error).toBe(true);
    const key = parseKey('c:minor');
    const allowed = new Set(key.intervals.map((i) => (key.pc + i) % 12));
    const notes = Object.values(run.parts).flat().map((h) => h.value?.note).filter((n) => n !== undefined);
    expect(notes.length).toBeGreaterThan(20);
    for (const note of notes) {
      const midi = typeof note === 'number' ? note : noteToMidi(note);
      expect(Number.isFinite(midi), String(note)).toBe(true);
      expect(allowed.has((midi % 12 + 12) % 12), String(note)).toBe(true);
    }
  });
  it('бас и арпеджио следуют строке гармонии', () => {
    const code = compileTrackSpec(SPEC);
    for (const name of ['BASS_0', 'ARP_2']) {
      expect(code.split('\n').find((l) => l.startsWith(`const ${name} =`))).toContain('.add(n("<0 5 3 4>")');
    }
  });
  it('смена гармонии меняет музыкальный код секции', () => {
    const spec = copy(); spec.structure.sections[0].harmony = 'Fm Gm Cm Ab';
    const music = (s) => compileTrackSpec(s).split('\n').find((l) => l.startsWith('const BASS_0'));
    expect(music(spec)).not.toBe(music(SPEC));
  });
  it('таймлайн каждой партии содержит точные длительности и тишину', () => {
    const bass = compileTrackSpec(SPEC).split('\n').find((l) => l.startsWith('$BASS:'));
    expect(bass).toContain('arrange([8, BASS_0], [16, BASS_1], [16, BASS_2], [8, silence])');
  });
  it('переход задаётся канонической автоматизацией и меняет значения событий', async () => {
    const run = await runStrudel(compileTrackSpec(SPEC), { cycles: 48 });
    expect(run.ok, run.error).toBe(true);
    const build = run.parts.BASS.filter((h) => h.whole.begin >= 8 && h.whole.begin < 24);
    expect(new Set(build.map((h) => h.value.cutoff)).size).toBeGreaterThan(1);
    const drop = run.parts.KICK.filter((h) => h.whole.begin >= 24 && h.whole.begin < 40);
    expect(new Set(drop.map((h) => h.value.gain)).size).toBeGreaterThan(1);
  });
  it('срез фильтра секции идёт в одну сторону, а не колеблется (D-160)', async () => {
    const run = await runStrudel(compileTrackSpec(SPEC), { cycles: 48 });
    expect(run.ok, run.error).toBe(true);
    const build = run.parts.BASS.filter((h) => h.whole.begin >= 8 && h.whole.begin < 24);
    const cutoffs = build.map((h) => h.value.cutoff).filter((v) => typeof v === 'number');
    expect(cutoffs.length).toBeGreaterThan(8);
    expect(directionChanges(cutoffs), 'срез фильтра должен расти монотонно').toBe(0);
    expect(cutoffs[0]).toBeLessThan(cutoffs[cutoffs.length - 1]);
  });
  it('громкость секции нарастает монотонно, а не пульсирует (D-160)', async () => {
    const run = await runStrudel(compileTrackSpec(SPEC), { cycles: 48 });
    expect(run.ok, run.error).toBe(true);
    const drop = run.parts.KICK.filter((h) => h.whole.begin >= 24 && h.whole.begin < 40);
    const gains = drop.map((h) => h.value.gain).filter((v) => typeof v === 'number');
    expect(gains.length).toBeGreaterThan(8);
    expect(directionChanges(gains), 'громкость секции должна расти монотонно').toBe(0);
  });
});

describe('исполнение канонических рисунков и стилей', () => {
  it.each(TrackSpecSchema.shape.meta.shape.style.options)('%s: запасной план исполняется', async (style) => {
    const spec = fallbackSpec(style, 7);
    expect(spec.meta.style).toBe(style);
    expect(checkSpec(spec).ok).toBe(true);
    const run = await runStrudel(compileTrackSpec(spec), { cycles: 32 });
    expect(run.ok, run.error).toBe(true);
    expect(Object.keys(run.parts).length).toBeGreaterThan(2);
  });
  it.each([['C', 'c:major'], ['F#', 'f#:major'], ['Bb', 'bb:major'], ['Am', 'a:minor']])('тональность %s разбирается', async (key, scale) => {
    const spec = copy(); spec.meta.key = key;
    const code = compileTrackSpec(spec);
    expect(getKey(code)).toBe(scale);
    const run = await runStrudel(code, { cycles: 8 });
    expect(run.ok, run.error).toBe(true);
  });
  it('плотность следует явному pattern, а не удалённому recipe', async () => {
    const busy = copy(); busy.parts.roles.hats.pattern = 'hh*16';
    const sparse = copy(); sparse.parts.roles.hats.pattern = 'hh*4';
    const a = await runStrudel(compileTrackSpec(busy), { cycles: 48 });
    const b = await runStrudel(compileTrackSpec(sparse), { cycles: 48 });
    expect(a.ok && b.ok).toBe(true);
    expect(a.parts.HATS.length).toBe(b.parts.HATS.length * 4);
  });
  it('мелодический рисунок сохраняет степени и паузы', () => {
    const spec = copy(); spec.parts.roles.lead = { activeIn: ['drop'], pattern: '0 ~ 2 4', sound: 'sine' };
    expect(compileTrackSpec(spec)).toContain('const LEAD_2 = n("0 ~ 2 4")');
  });
  it('разрешённые эффекты исполняются', async () => {
    const spec = copy(); spec.parts.roles.bass.effects = [{ name: 'room', params: [0.5] }];
    const run = await runStrudel(compileTrackSpec(spec), { cycles: 8 });
    expect(run.ok, run.error).toBe(true);
    expect(run.parts.BASS[0].value.room).toBe(0.5);
  });
  it('неподдерживаемые эффекты и код вместо mini отклоняются', () => {
    const spec = copy(); spec.parts.roles.kick.effects = [{ name: 'unknown', params: [1] }];
    expect(() => compileTrackSpec(spec)).toThrow(/effects/);
    delete spec.parts.roles.kick.effects; spec.parts.roles.kick.pattern = 's("bd")';
    expect(() => compileTrackSpec(spec)).toThrow(/mini/);
  });
});

function noteToMidi(note) {
  const m = String(note).toLowerCase().match(/^([a-g])([#b]?)(-?\d+)$/);
  if (!m) return NaN;
  return (Number(m[3]) + 1) * 12 + { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1]]
    + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
