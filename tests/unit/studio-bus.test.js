// Фаза 1: командная шина — чистота редьюсера, атомарность групп, undo бит-в-бит.
import { describe, it, expect } from 'vitest';
import { createCommand, createStore, reduce, CommandSchema } from '../../src/studio/bus.js';
import { projectFromSpec, canonicalJson } from '../../src/studio/model.js';
import { compileProject } from '../../src/studio/compile.js';
import { SPEC } from '../fixtures/studio-spec.js';

const model = () => projectFromSpec(SPEC, { id: 'demo' });

describe('редьюсер', () => {
  it('не мутирует исходную модель', () => {
    const before = model();
    const snapshot = canonicalJson(before);
    const next = reduce(before, createCommand('setBpm', { bpm: 140 }));
    expect(canonicalJson(before)).toBe(snapshot);
    expect(next.spec.meta.bpm).toBe(140);
  });

  it('результат всегда проходит схему модели', () => {
    const next = reduce(model(), createCommand('setBpm', { bpm: 140 }));
    expect(() => projectFromSpec(next.spec)).not.toThrow();
    expect(next.mix.parts).toBeTruthy();
  });

  it('невалидный payload отклоняется', () => {
    expect(() => reduce(model(), createCommand('setBpm', { bpm: 500 }))).toThrow();
    expect(() => reduce(model(), createCommand('setBpm', { bpm: 120, hack: 1 }))).toThrow();
  });

  it('неизвестный тип команды отклоняется', () => {
    expect(() => reduce(model(), { id: 'c1', groupId: 'g1', source: 'user', type: 'dropDatabase', payload: {} })).toThrow();
  });

  it('команда без обязательных полей не проходит схему', () => {
    expect(() => CommandSchema.parse({ id: 'c1', groupId: 'g1', type: 'setBpm', payload: {} })).toThrow();
  });

  it('секции добавляются, дублируются и удаляются', () => {
    let current = model();
    current = reduce(current, createCommand('addSection', { name: 'fill', cycles: 2, energy: 0.5, harmony: 'Cm' }));
    expect(current.spec.structure.sections).toHaveLength(5);
    current = reduce(current, createCommand('duplicateSection', { name: 'fill' }));
    expect(current.spec.structure.sections.filter((s) => s.name === 'fill')).toHaveLength(2);
    current = reduce(current, createCommand('removeSection', { name: 'fill' }));
    expect(current.spec.structure.sections.filter((s) => s.name === 'fill')).toHaveLength(1);
  });

  it('удаление секции убирает её из activeIn партий', () => {
    let current = reduce(model(), createCommand('removeSection', { name: 'drop' }));
    expect(current.spec.parts.roles.kick.activeIn).not.toContain('drop');
  });

  it('автоматизация добавляется и заменяется по id', () => {
    let current = reduce(model(), createCommand('setAutomation', {
      target: { kind: 'section', id: 'drop' },
      param: 'gain',
      curve: { type: 'ramp', from: -6, to: 0, bars: 8 },
    }));
    expect(current.automation).toHaveLength(1);
    current = reduce(current, createCommand('setAutomation', {
      target: { kind: 'section', id: 'drop' },
      param: 'gain',
      curve: { type: 'ramp', from: -3, to: 0, bars: 8 },
    }));
    expect(current.automation).toHaveLength(1);
  });

  it('applyAutoMix применяет набор изменений', () => {
    const next = reduce(model(), createCommand('applyAutoMix', {
      changes: [{ id: 'bass', patch: { gainDb: -4 } }],
    }));
    expect(next.mix.parts.bass.gainDb).toBe(-4);
  });
});

describe('хранилище: история, группы, undo', () => {
  it('одиночная команда откатывается и возвращается', () => {
    const store = createStore(model());
    const before = canonicalJson(store.model);
    store.dispatch(createCommand('setBpm', { bpm: 100 }));
    expect(store.model.spec.meta.bpm).toBe(100);
    expect(store.undo()).toBe(true);
    expect(canonicalJson(store.model)).toBe(before);
    expect(store.redo()).toBe(true);
    expect(store.model.spec.meta.bpm).toBe(100);
  });

  it('undo возвращает канонический JSON бит-в-бит и тот же хеш кода', () => {
    const store = createStore(model());
    const beforeJson = canonicalJson(store.model);
    const beforeHash = compileProject(store.model).hash;
    store.dispatch(createCommand('setBpm', { bpm: 92 }));
    store.dispatch(createCommand('setMix', { id: 'bass', patch: { gainDb: -5 } }));
    store.undo();
    store.undo();
    expect(canonicalJson(store.model)).toBe(beforeJson);
    expect(compileProject(store.model).hash).toBe(beforeHash);
  });

  it('группа откатывается одной кнопкой', () => {
    const store = createStore(model());
    const before = canonicalJson(store.model);
    store.beginGroup('auto-1');
    store.dispatch(createCommand('setBpm', { bpm: 110 }, { groupId: 'auto-1' }));
    store.dispatch(createCommand('setMaster', { patch: { targetLufs: -16 } }, { groupId: 'auto-1' }));
    store.dispatch(createCommand('setMix', { id: 'kick', patch: { gainDb: -2 } }, { groupId: 'auto-1' }));
    store.commitGroup('autoMix');
    expect(store.history).toHaveLength(1);
    expect(store.model.spec.meta.bpm).toBe(110);
    store.undo();
    expect(canonicalJson(store.model)).toBe(before);
  });

  it('история ограничена 200 записями', () => {
    const store = createStore(model());
    for (let i = 0; i < 230; i += 1) {
      store.dispatch(createCommand('setBpm', { bpm: 90 + (i % 50) }));
    }
    expect(store.history.length).toBeLessThanOrEqual(200);
  });

  it('команда не из валидного источника всё равно валидируется', () => {
    const store = createStore(model());
    expect(() => store.dispatch({ id: 'x', groupId: 'g', source: 'hacker', type: 'setBpm', payload: { bpm: 100 } })).toThrow();
  });

  it('замена проекта очищает историю', () => {
    const store = createStore(model());
    store.dispatch(createCommand('setBpm', { bpm: 100 }));
    store.replace(model());
    expect(store.canUndo).toBe(false);
  });
});
