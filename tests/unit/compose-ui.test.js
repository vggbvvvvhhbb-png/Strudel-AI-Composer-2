// Проверка событий интерфейса без браузера; геометрия и Web Audio здесь не проверяются.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fallbackSpec } from '../../server/music/compose/pipeline.js';
import { compile } from '../../server/music/compiler/index.js';
import { resolveProfile, PROFILES } from '../../server/music/references.js';

const api = vi.hoisted(() => ({ composeTrack: vi.fn(), composeVariants: vi.fn(), composeMutate: vi.fn() }));
vi.mock('../../src/api/client.js', () => api);
import { initCompose } from '../../src/compose.js';

// Только используемый модулем DOM-контракт. Обработчики и отрисовка настоящие.
class Element {
  children = [];
  listeners = {};
  style = { setProperty() {} };
  classList = { add() {} };
  value = '';
  textContent = '';
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  async click() { await this.listeners.click?.(); }
}
const text = (element) => [element.textContent, ...element.children.map(text)].join(' ');
let elements, applyCode, log;
beforeEach(() => {
  vi.clearAllMocks();
  elements = new Map();
  for (const id of ['prompt-input', 'compose-mode', 'btn-compose', 'btn-compose-mutate',
    'btn-compose-variants', 'compose-trace', 'compose-timeline', 'compose-timeline-blocks',
    'compose-energy', 'compose-sections', 'compose-variants']) elements.set(id, new Element());
  elements.get('prompt-input').value = 'техно';
  elements.get('compose-mode').value = 'structured';
  vi.stubGlobal('document', {
    getElementById: (id) => elements.get(id),
    createElement: () => new Element(), createElementNS: () => new Element(),
  });
  applyCode = vi.fn().mockResolvedValue(undefined);
  log = vi.fn();
  initCompose({ applyCode, log });
});
afterEach(() => vi.unstubAllGlobals());

async function compose(spec = fallbackSpec('techno', 1), finalSpec = spec, knowledgeEvents = []) {
  const initial = compile(spec), final = compile(finalSpec);
  api.composeTrack.mockImplementation(async ({ onEvent }) => {
    for (const event of knowledgeEvents) onEvent(event);
    onEvent({ type: 'spec', spec, attempts: 1 });
    onEvent({ type: 'compiled', ...initial });
    onEvent({ type: 'refined', spec: finalSpec, before: 60, after: 70, improved: true });
    onEvent({ type: 'done', mode: 'structured', spec: finalSpec, ...final });
    return { spec: finalSpec, ...final, score: { total: 70 } };
  });
  // Слушатель клика не возвращает Promise, ждём наблюдаемый результат потока.
  await elements.get('btn-compose').click();
  await vi.waitFor(() => expect(applyCode).toHaveBeenCalledWith(final.code));
  return final;
}

describe('каноническая композиция в интерфейсе', () => {
  it('готовый код применяется, окончательный план и таймлайн заменяют первоначальные', async () => {
    const spec = fallbackSpec('techno', 1);
    const final = structuredClone(spec);
    final.structure.sections.reverse();
    final.structure.sections[0].cycles += 1;
    const compiled = await compose(spec, final);
    expect(applyCode).toHaveBeenCalledTimes(1);
    const sections = elements.get('compose-sections').children;
    expect(sections).toHaveLength(final.structure.sections.length);
    expect(text(sections[0])).toContain(`${final.structure.sections[0].cycles} такт`);
    expect(text(sections[0])).toContain(final.structure.sections[0].name);
    const blocks = elements.get('compose-timeline-blocks').children;
    expect(blocks.map((block) => block.title)).toEqual(compiled.sections.map((s) =>
      `${s.kind} — ${s.bars} такт, энергия ${Math.round(s.energy * 100)}%`));
    expect(log.mock.calls.some(([, level]) => level === 'error')).toBe(false);
  });

  it('мутация использует окончательную спеку и применяет возвращённый код', async () => {
    const spec = fallbackSpec('techno', 1), final = fallbackSpec('house', 2);
    await compose(spec, final);
    const mutated = fallbackSpec('ambient', 3), compiled = compile(mutated);
    api.composeMutate.mockResolvedValue({ spec: mutated, ...compiled, mutation: 'energy' });
    await elements.get('btn-compose-mutate').click();
    await vi.waitFor(() => expect(applyCode).toHaveBeenLastCalledWith(compiled.code));
    expect(api.composeMutate.mock.calls[0][0].spec).toEqual(final);
    expect(log.mock.calls.some(([, level]) => level === 'error')).toBe(false);
  });

  it('загрузка выбранного варианта вызывает зарегистрированный обработчик', async () => {
    await compose();
    const spec = fallbackSpec('house', 2), compiled = compile(spec);
    api.composeVariants.mockResolvedValue({ variants: [{ spec, ...compiled, rank: 1, angle: 'form' }] });
    await elements.get('btn-compose-variants').click();
    await vi.waitFor(() => expect(elements.get('compose-variants').children).toHaveLength(1));
    const button = elements.get('compose-variants').children[0].children.at(-1);
    await button.click();
    expect(applyCode).toHaveBeenLastCalledWith(compiled.code);
    expect(text(elements.get('compose-sections'))).toContain(spec.structure.sections[0].name);
  });

  it('показывает гайд, лексическую деградацию и ошибки коррекции', async () => {
    const spec = fallbackSpec('techno', 1);
    await compose(spec, spec, [
      { type: 'knowledge', guide: { genre: 'techno', id: 'edu-guide-techno' }, reason: 'Поиск лексический, семантика недоступна' },
      { type: 'genre-validation', attempt: 1, ok: false, errors: [{ message: 'meta.bpm вне 120..150' }] },
      { type: 'genre-validation', attempt: 2, ok: true, errors: [] },
    ]);
    const trace = text(elements.get('compose-trace'));
    expect(trace).toContain('edu-guide-techno');
    expect(trace).toContain('семантика недоступна');
    expect(trace).toContain('meta.bpm вне 120..150');
    expect(trace).toContain('BPM и обязательные роли соблюдены');
    expect(applyCode).toHaveBeenCalledOnce();
  });

  it('при жанровом отказе код не применяется и ошибка остаётся видимой', async () => {
    api.composeTrack.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'genre-validation', attempt: 3, ok: false, errors: [{ message: 'нет bass' }] });
      onEvent({ type: 'error', message: 'Жанровый гайд не выполнен после 3 попыток' });
      throw new Error('Жанровый гайд не выполнен после 3 попыток');
    });
    await elements.get('btn-compose').click();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('после 3 попыток'), 'error'));
    expect(applyCode).not.toHaveBeenCalled();
    expect(text(elements.get('compose-trace'))).toContain('нет bass');
    expect(text(elements.get('compose-trace'))).toContain('после 3 попыток');
  });

  it('канонический lo-fi получает профиль lofi, а не generic', () => {
    expect(resolveProfile('lo-fi')).toBe(PROFILES.lofi);
    expect(resolveProfile('lofi')).toBe(PROFILES.lofi);
  });
});
