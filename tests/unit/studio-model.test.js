// Фаза 1: модель проекта, канонический JSON, компиляция модели.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalJson, projectFromSpec, totalBars, sectionTimeline,
  validateProjectModel, safeValidateProjectModel, hashToSeed, PROJECT_VERSION,
} from '../../src/studio/model.js';
import { compileProject } from '../../src/studio/compile.js';
import { sha256Hex } from '../../src/studio/sha256.js';
import { SPEC, copySpec } from '../fixtures/studio-spec.js';

describe('ProjectModel', () => {
  it('строится из спеки v2 и проходит схему', () => {
    const model = projectFromSpec(SPEC, { id: 'demo' });
    expect(model.version).toBe(PROJECT_VERSION);
    expect(model.spec.meta.bpm).toBe(128);
    expect(totalBars(model)).toBe(48);
    expect(Object.keys(model.mix.parts).sort()).toEqual(['arp', 'bass', 'hats', 'kick', 'snare']);
  });

  it('дефолтная микс-карта заполнена значениями по умолчанию', () => {
    const model = projectFromSpec(SPEC);
    expect(model.mix.parts.kick.gainDb).toBe(0);
    expect(model.mix.parts.kick.pan).toBe(0);
    expect(model.master.targetLufs).toBe(-14);
    expect(model.master.ceilingDbtp).toBe(-1);
  });

  it('seed детерминирован и выводится из id', () => {
    const a = projectFromSpec(SPEC, { id: 'x' });
    const b = projectFromSpec(SPEC, { id: 'x' });
    expect(a.seed).toBe(b.seed);
    expect(a.seed).toBe(hashToSeed('x'));
  });

  it('неизвестная роль в миксе отклоняется', () => {
    const model = projectFromSpec(SPEC);
    model.mix.parts.guitar = { ...model.mix.parts.kick };
    const result = safeValidateProjectModel(model);
    expect(result.ok).toBe(false);
    expect(result.error.issues[0].message).toMatch(/неизвестная роль/);
  });

  it('валидация даёт внятную ошибку', () => {
    const model = projectFromSpec(SPEC);
    model.master.targetLufs = 3;
    expect(() => validateProjectModel(model)).toThrow();
  });

  it('канонический JSON не зависит от порядка ключей', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('таймлайн секций даёт границы тактов', () => {
    const model = projectFromSpec(SPEC);
    const timeline = sectionTimeline(model);
    expect(timeline[0].startBar).toBe(0);
    expect(timeline[0].endBar).toBe(8);
    expect(timeline[3].endBar).toBe(48);
  });
});

describe('sha256 без Web Crypto', () => {
  it('совпадает с node:crypto', () => {
    for (const text of ['', 'a', 'abc', 'тест', 'x'.repeat(1000)]) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });
});

describe('компиляция модели', () => {
  it('детерминирована: один и тот же проект — один и тот же код и хеш', () => {
    const model = projectFromSpec(SPEC, { id: 'demo' });
    const a = compileProject(model);
    const b = compileProject(model);
    expect(a.code).toBe(b.code);
    expect(a.hash).toBe(b.hash);
  });

  it('даёт план с тактами, секциями и партиями', () => {
    const model = projectFromSpec(SPEC);
    const { plan } = compileProject(model);
    expect(plan.bars).toBe(48);
    expect(plan.bpm).toBe(128);
    expect(plan.sections).toHaveLength(4);
    expect(plan.parts.map((p) => p.role)).toContain('kick');
    expect(plan.engineVersion).toContain('strudel-web@');
  });

  it('микс-цепочка попадает в код партии', () => {
    const model = projectFromSpec(SPEC);
    model.mix.parts.bass.pan = -0.25;
    model.mix.parts.kick.gainDb = -3;
    const { code } = compileProject(model);
    expect(code).toMatch(/\.pan\(-0\.25\)/);
    expect(code).toMatch(/\.gain\(0\.7079\)/); // −3 дБ
  });

  it('секционная gain-автоматизация не затирается миксом', () => {
    const model = projectFromSpec(SPEC);
    model.mix.parts.kick.gainDb = -6;
    const { code } = compileProject(model);
    // В дропе секция несёт свою автоматизацию [0.6, 1] — микс в неё вписан,
    // а не добавлен вторым .gain() поверх (последний вызов победил бы).
    expect(code).toMatch(/\.range\(0\.3007, 0\.5012\)/);
    expect(code).not.toMatch(/\.range\(0\.6, 1\)\)\.gain\(/);
  });

  it('рецепт партии выбирает шаблон из библиотеки знаний', () => {
    const model = projectFromSpec(SPEC);
    model.spec.parts.roles.hats.variants = [{ id: 'hats-recipe', kind: 'recipe', value: 'busy' }];
    const { code } = compileProject(model);
    expect(code).not.toMatch(/hh\*8/);
    expect(code).toMatch(/hh\*16/);
  });

  it('заметки попадают в код как комментарии', () => {
    const model = projectFromSpec(SPEC);
    model.spec.parts.roles.bass.variants = [{ id: 'bass-notes', kind: 'notes', value: 'не залезать на кик' }];
    const { code } = compileProject(model);
    expect(code).toMatch(/\/\/ bass: не залезать на кик/);
  });

  it('компиляция 64 тактов × 8 партий укладывается в 30 мс', () => {
    const spec = structuredClone(SPEC);
    spec.structure.sections = spec.structure.sections.map((section) => ({ ...section, cycles: 16 }));
    const model = projectFromSpec(spec);
    // Восемь партий: добавляем роли из библиотеки.
    const roles = ['kick', 'snare', 'hats', 'perc', 'bass', 'sub', 'arp', 'pad'];
    model.spec.parts.roles = Object.fromEntries(roles.map((role) => [role, {
      activeIn: ['intro', 'build', 'drop', 'outro'],
      pattern: role === 'kick' ? 'bd*4' : role === 'hats' ? 'hh*8' : '0 ~ 2 4',
      sound: role === 'kick' ? 's' : role === 'hats' ? 's' : 'sawtooth',
    }]));
    const started = Date.now();
    const { code, plan } = compileProject(model);
    const elapsed = Date.now() - started;
    expect(plan.bars).toBe(64);
    expect(code).toContain('$KICK:');
    expect(elapsed).toBeLessThan(30);
  });
});
