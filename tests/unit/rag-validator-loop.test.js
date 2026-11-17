// Фаза F: валидатор кода и петля self-correction (D-139).
// Каждый класс ошибок проверяется отдельно; петля — с mock-LLM.

import { describe, it, expect } from 'vitest';
import {
  validateGeneratedCode, parseKeyCode, extractSoundNames, feedbackFromErrors,
} from '../../server/rag/code-validator.js';
import { runCorrectionLoop } from '../../server/rag/loop.js';
import { LocalKnowledgeStore } from '../../server/rag/store-local.js';
import { loadTimbreCatalog } from '../../server/samples/timbre.js';
import { loadDataset } from '../../server/rag/dataset.js';

const catalog = loadTimbreCatalog();
const { entries } = loadDataset();
const store = new LocalKnowledgeStore(entries);

const VALID = 'setCpm(90/4)\nconst key = "c:minor"\n$MEL: note("c4 eb4 g4").s("piano").gain(0.7)';
const OUT_OF_SCALE = 'setCpm(90/4)\nconst key = "c:minor"\n$MEL: note("c4 e4 g4").s("piano")';

describe('валидатор: классы ошибок', () => {
  it('валидный код проходит, статистика событий есть', async () => {
    const r = await validateGeneratedCode(VALID, { catalog });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.parts).toBe(1);
    expect(r.stats.events).toBeGreaterThan(0);
  });

  it('syntax: незакрытая скобка', async () => {
    const r = await validateGeneratedCode('$MEL: note("c4"', { catalog });
    expect(r.ok).toBe(false);
    expect(r.errors[0].class).toBe('syntax');
  });

  it('runtime: несуществующая функция', async () => {
    const r = await validateGeneratedCode('$MEL: klingon("c4")', { catalog });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.class === 'runtime')).toBe(true);
  });

  it('empty-part: партия без событий', async () => {
    const r = await validateGeneratedCode('$MEL: silence', { catalog });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.class === 'empty-part' && e.part === 'MEL')).toBe(true);
  });

  it('scale: мажорная терция в миноре — ошибка с тактом и партией', async () => {
    const r = await validateGeneratedCode(OUT_OF_SCALE, { catalog });
    expect(r.ok).toBe(false);
    const scaleErr = r.errors.find((e) => e.class === 'scale');
    expect(scaleErr).toBeDefined();
    expect(scaleErr.part).toBe('MEL');
    expect(scaleErr.bar).toBeGreaterThanOrEqual(1);
    expect(scaleErr.message).toContain('e4');
    expect(scaleErr.message).toContain('c minor');
  });

  it('unknown-sound: выдуманный пресет и выдуманный сэмпл', async () => {
    const r = await validateGeneratedCode('$MEL: note("c4").s("tp_ghost_v1")\n$DRUMS: s("klingon")', { catalog });
    expect(r.ok).toBe(false);
    const msgs = r.errors.filter((e) => e.class === 'unknown-sound').map((e) => e.message);
    expect(msgs.some((m) => m.includes('tp_ghost_v1'))).toBe(true);
    expect(msgs.some((m) => m.includes('klingon'))).toBe(true);
  });

  it('реальный CC0-пресет проходит', async () => {
    const r = await validateGeneratedCode('$MEL: note("c4 eb4").s("tp_upright_soft_v1")', { catalog });
    expect(r.errors).toEqual([]);
  });

  it('без key проверка лада пропускается («нет данных»), остальное работает', async () => {
    const r = await validateGeneratedCode('$MEL: note("c4 e4").s("piano")', { catalog });
    expect(r.ok).toBe(true);
  });

  it('явный key переопределяет key из кода', async () => {
    const r = await validateGeneratedCode('$MEL: note("c4 e4 g4").s("piano")', { catalog, key: { tonic: 'c', mode: 'major' } });
    expect(r.ok).toBe(true);
  });
});

describe('разбор key и имён звуков', () => {
  it('parseKeyCode: диезы и алиасы ладов', () => {
    expect(parseKeyCode('const key = "f#:minor"')).toEqual({ tonic: 'gb', mode: 'minor' });
    expect(parseKeyCode('const key = "a:harmonicminor"')).toEqual({ tonic: 'a', mode: 'harmonic-minor' });
    expect(parseKeyCode('const key = "c:ionian"')).toEqual({ tonic: 'c', mode: 'major' });
    expect(parseKeyCode('без ключа')).toBeNull();
    expect(parseKeyCode('const key = "c:klingon"')).toBeNull();
  });

  it('extractSoundNames чистит mini-синтаксис', () => {
    expect(extractSoundNames('.s("bd*4, hh*8, cp(3,8)")').sort()).toEqual(['bd', 'cp', 'hh']);
    expect(extractSoundNames('.s("tp_upright_soft_v1")')).toEqual(['tp_upright_soft_v1']);
  });

  it('фидбек содержит классы и инструкции', () => {
    const fb = feedbackFromErrors([{ class: 'scale', message: 'нота e4 вне лада (такт 1)' }]);
    expect(fb).toContain('[scale]');
    expect(fb).toContain('такт 1');
    expect(fb).toContain('```strudel');
  });
});

describe('петля self-correction (mock-LLM)', () => {
  const wrap = (code) => `Обоснование: тоника и терция.\n\`\`\`strudel\n${code}\n\`\`\``;

  it('исправление со второй попытки: фидбек доходит до модели', async () => {
    const seen = [];
    const responses = [wrap(OUT_OF_SCALE), wrap(VALID)];
    const callModel = async (messages) => {
      seen.push(messages.map((m) => m.content).join('\n'));
      return responses.shift();
    };
    const r = await runCorrectionLoop({ request: 'минорная мелодия', store, callModel, catalog, maxAttempts: 3 });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(r.code).toContain('eb4');
    expect(r.rationale).toContain('Обоснование');
    expect(seen[1]).toContain('[scale]'); // фидбек первой ошибки во втором вызове
    expect(r.history.map((h) => h.ok)).toEqual([false, true]);
  });

  it('все попытки невалидны — честный отказ, не мусор', async () => {
    const callModel = async () => wrap(OUT_OF_SCALE);
    const r = await runCorrectionLoop({ request: 'мелодия', store, callModel, catalog, maxAttempts: 3 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.code).toBeUndefined();
    expect(r.reason).toContain('не удалось');
    expect(r.history).toHaveLength(3);
  });

  it('ответ без кода — класс no-code, петля продолжает', async () => {
    const responses = ['Я не могу написать код.', wrap(VALID)];
    const callModel = async () => responses.shift();
    const r = await runCorrectionLoop({ request: 'мелодия', store, callModel, catalog, maxAttempts: 2 });
    expect(r.ok).toBe(true);
    expect(r.history[0].errors[0].class).toBe('no-code');
  });

  it('LLM упала — честная причина, без выдуманного кода', async () => {
    const callModel = async () => { throw new Error('ECONNREFUSED'); };
    const r = await runCorrectionLoop({ request: 'мелодия', store, callModel, catalog });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('LLM недоступна');
  });

  it('шаги видны через onStep (поиск, генерация, валидация)', async () => {
    const steps = [];
    const callModel = async () => wrap(VALID);
    await runCorrectionLoop({ request: 'мелодия', store, callModel, catalog, onStep: (s) => steps.push(s.type) });
    expect(steps).toEqual(['search', 'generate', 'validate']);
  });

  it('maxAttempts=1: одна попытка, без фидбека', async () => {
    const callModel = async () => wrap(OUT_OF_SCALE);
    const r = await runCorrectionLoop({ request: 'мелодия', store, callModel, catalog, maxAttempts: 1 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
  });
});