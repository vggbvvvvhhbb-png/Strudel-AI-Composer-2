// Намерение → Composition IR: разбор жанра, настроения и детерминизм плана.
import { describe, it, expect } from 'vitest';
import { planIR, detectGenre, hashSeed, GENRES } from '../../src/ir/intent.js';
import { parseMood, compileEmotion } from '../../src/ir/emotion.js';
import { validateIR, safeValidateIR } from '../../src/ir/schema.js';

describe('Определение жанра по тексту', () => {
  it.each([
    ['мрачный трип-хоп про дождь', 'trip-hop'],
    ['злой быстрый dnb', 'dnb'],
    ['уютный лоуфай для учёбы', 'lofi'],
    ['эйфоричный фестиваль', 'synthpop'],
    ['тревожный эмбиент, пустой космос', 'ambient'],
  ])('запрос «%s» даёт жанр %s', (text, genre) => {
    expect(planIR(text).meta.genre).toBe(genre);
  });

  it('detectGenre помечает явный жанр как explicit', () => {
    expect(detectGenre('злой быстрый dnb')).toEqual({ genre: 'dnb', explicit: true });
    expect(detectGenre('уютный лоуфай для учёбы')).toEqual({ genre: 'lofi', explicit: true });
  });

  it('detectGenre для незнакомого текста откатывается к lofi без explicit', () => {
    expect(detectGenre('непонятная музыка без жанровых слов')).toEqual({ genre: 'lofi', explicit: false });
    expect(detectGenre('')).toEqual({ genre: 'lofi', explicit: false });
  });

  it('у жанров есть собственные диапазоны темпа', () => {
    for (const [name, params] of Object.entries(GENRES)) {
      expect(params.bpm[0], name).toBeLessThan(params.bpm[1]);
      expect(params.defaultBpm, name).toBeGreaterThanOrEqual(params.bpm[0]);
      expect(params.defaultBpm, name).toBeLessThanOrEqual(params.bpm[1]);
    }
  });
});

describe('planIR строит валидный Composition IR', () => {
  const prompts = [
    'мрачный трип-хоп про дождь',
    'злой быстрый dnb',
    'уютный лоуфай для учёбы',
    'эйфоричный фестиваль',
    'тревожный эмбиент, пустой космос',
  ];

  it.each(prompts)('IR для «%s» проходит validateIR', (text) => {
    const ir = planIR(text);
    expect(() => validateIR(ir)).not.toThrow();
    const result = safeValidateIR(ir);
    expect(result.ok, result.error ? result.error.message : '').toBe(true);
  });

  it('IR версии 1 с целым зерном и секциями в пределах схемы', () => {
    const ir = planIR('мрачный трип-хоп про дождь');
    expect(ir.v).toBe(1);
    expect(Number.isInteger(ir.seed)).toBe(true);
    expect(ir.sections.length).toBeGreaterThan(0);
    expect(ir.sections.every((section) => section.harmony.length > 0)).toBe(true);
    expect(ir.meta.bpm).toBeGreaterThanOrEqual(40);
    expect(ir.meta.bpm).toBeLessThanOrEqual(200);
  });

  it('hashSeed стабилен для одного и того же текста', () => {
    expect(hashSeed('мрачный трип-хоп')).toBe(hashSeed('мрачный трип-хоп'));
    expect(hashSeed('мрачный трип-хоп')).not.toBe(hashSeed('другой текст'));
  });
});

describe('Детерминизм плана', () => {
  it('одинаковый текст и зерно дают одинаковый IR', () => {
    const first = planIR('мрачный трип-хоп про дождь', { seed: 7 });
    const second = planIR('мрачный трип-хоп про дождь', { seed: 7 });
    expect(second).toEqual(first);
  });

  it('другое зерно меняет мотив, но не структуру трека', () => {
    const first = planIR('тёмный трип-хоп', { seed: 1 });
    const second = planIR('тёмный трип-хоп', { seed: 2 });
    expect(second.motifs).not.toEqual(first.motifs);
    const shape = (ir) => ir.sections.map((section) => [section.id, section.kind, section.bars, section.energy]);
    expect(shape(second)).toEqual(shape(first));
    expect(second.meta.bpm).toBe(first.meta.bpm);
    expect(second.meta.key).toEqual(first.meta.key);
  });

  it('жёстко заданный жанр и темп попадают в IR', () => {
    const ir = planIR('что-то неопределённое', { genre: 'dnb', bpm: 175 });
    expect(ir.meta.genre).toBe('dnb');
    // Явно заданный темп — команда, а не пожелание: жанровый дефолт его
    // не перебивает (раньше он затирался, и просьба «175 BPM» терялась).
    expect(ir.meta.bpm).toBe(175);
  });

  it('явный темп учитывается, если в тексте есть настроение', () => {
    const ir = planIR('злой dnb', { bpm: 175 });
    expect(ir.meta.mood.label).toBe('anger');
    expect(ir.meta.bpm).toBe(175);
  });
});

describe('Разбор настроения', () => {
  it('при конфликте побеждает последнее совпавшее слово', () => {
    expect(parseMood('весёлый мрачный').label).toBe('dark');
    expect(parseMood('мрачный весёлый').label).toBe('joy');
  });

  it('без ключевых слов настроение нейтрально, ярлык пуст', () => {
    const mood = parseMood('просто музыка без настроения');
    expect(mood.label).toBeNull();
    expect(mood.valence).toBe(0);
    expect(mood.arousal).toBe(0);
  });

  it('настроение читается по ключевым словам и даёт вектор', () => {
    const mood = parseMood('тревожный саспенс');
    expect(mood.label).toBe('anxiety');
    expect(mood.valence).toBeLessThan(0);
    expect(mood.arousal).toBeGreaterThan(0);
  });
});

describe('compileEmotion', () => {
  it('темп остаётся внутри жанрового диапазона', () => {
    const result = compileEmotion({ valence: 0.9, arousal: 0.9, label: 'euphoria' }, { bpmRange: [70, 92] });
    expect(result.bpm).toBeGreaterThanOrEqual(70);
    expect(result.bpm).toBeLessThanOrEqual(92);
  });

  it('рост arousal не понижает темп при том же настроении', () => {
    const low = compileEmotion({ valence: -0.7, arousal: -0.2, label: 'dark' }, { bpmRange: [70, 95] });
    const high = compileEmotion({ valence: -0.7, arousal: 0.9, label: 'dark' }, { bpmRange: [70, 95] });
    expect(high.bpm).toBeGreaterThanOrEqual(low.bpm);
    expect(low.bpm).toBeGreaterThanOrEqual(70);
    expect(high.bpm).toBeLessThanOrEqual(95);
  });

  it('без ярлыка темп растёт вместе с arousal', () => {
    const low = compileEmotion({ valence: 0, arousal: -0.5, label: null });
    const high = compileEmotion({ valence: 0, arousal: 0.5, label: null });
    expect(high.bpm).toBeGreaterThan(low.bpm);
    expect(low.density).toBeLessThan(high.density);
  });

  it('результат содержит лад, плотность и прогрессию', () => {
    const result = compileEmotion(parseMood('мрачный'), {});
    expect(typeof result.mode).toBe('string');
    expect(result.density).toBeGreaterThan(0);
    expect(result.progression.length).toBeGreaterThan(0);
  });
});
