// LLM-планировщик IR: описание → план → код.
//
// Проверяется ровно то, что обещает бриф:
//   • модель отвечает JSON по контракту, а не кодом;
//   • ответ принимается только после проверки Zod;
//   • невалидный ответ чинится ремонтным ретраем, а не падением;
//   • бюджет вызовов не превышается;
//   • при недоступной модели студия всё равно работает (правила);
//   • повторный запрос берётся из кэша и не тратит модель.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  planWithLLM, parseIrJson, repairHint, cacheKey, clearPlannerCache,
} from '../../server/ir/planner.js';
import { IR_JSON_SCHEMA, IR_SCHEMA_VERSION } from '../../server/ir/schema-json.js';
import { planIR } from '../../src/ir/intent.js';
import { safeValidateIR } from '../../src/ir/schema.js';
import { compileIR } from '../../src/ir/compiler.js';
import { symbolicReport } from '../../src/oracle/report.js';

beforeEach(() => clearPlannerCache());

describe('разбор ответа модели', () => {
  it('берёт JSON из markdown-обёртки', () => {
    expect(parseIrJson('```json\n{"v":1}\n```')).toEqual({ v: 1 });
    expect(parseIrJson('вот план: {"v":1} — держите')).toEqual({ v: 1 });
  });

  it('не выдумывает объект там, где его нет', () => {
    expect(parseIrJson('извините, я не могу')).toBeNull();
    expect(parseIrJson('')).toBeNull();
    expect(parseIrJson(null)).toBeNull();
  });

  it('подсказка починки перечисляет путь и сообщение Zod', () => {
    const bad = safeValidateIR({ v: 1 });
    expect(bad.ok).toBe(false);
    const hint = repairHint(bad.error);
    expect(hint).toMatch(/seed|bpm|sections|meta/);
  });
});

describe('планировщик', () => {
  it('принимает валидный IR и компилирует его в код', async () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 7 });
    const complete = async () => JSON.stringify(ir);
    const result = await planWithLLM({ prompt: 'мрачный трип-хоп про дождь', seed: 7, complete });

    expect(result.source).toBe('llm');
    expect(result.calls).toBe(1);
    expect(result.repaired).toBe(false);
    expect(safeValidateIR(result.ir).ok).toBe(true);

    const code = compileIR(result.ir).code;
    expect(code).toMatch(/\$/);
    expect(symbolicReport(result.ir).sections.length).toBeGreaterThan(0);
  });

  it('чинит невалидный ответ ремонтным ретраем', async () => {
    const ir = planIR('эйфоричный фестиваль', { seed: 3 });
    let call = 0;
    const complete = async () => {
      call += 1;
      return call === 1 ? JSON.stringify({ v: 1, seed: 1 }) : JSON.stringify(ir);
    };
    const result = await planWithLLM({ prompt: 'эйфоричный фестиваль', seed: 3, complete });

    expect(result.calls).toBe(2);
    expect(result.repaired).toBe(true);
    expect(result.source).toBe('llm');
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('ремонтный ретрай несёт модели текст ошибки и её прошлый ответ', async () => {
    const ir = planIR('злой быстрый dnb', { seed: 9 });
    const seen = [];
    let call = 0;
    const complete = async (args) => {
      seen.push(args);
      call += 1;
      return call === 1 ? JSON.stringify({ v: 1, seed: 1 }) : JSON.stringify(ir);
    };
    await planWithLLM({ prompt: 'злой быстрый dnb', seed: 9, complete });

    expect(seen).toHaveLength(2);
    const retry = seen[1].messages;
    // Модель видит свой прошлый ответ...
    expect(retry.some((message) => message.role === 'assistant')).toBe(true);
    // ...и список конкретных ошибок.
    const feedback = retry.at(-1).content;
    expect(feedback).toMatch(/не принят/);
    expect(feedback).toMatch(/seed|sections|meta/);
  });

  it('починка по роли закрывает главный класс ошибок живой модели', async () => {
    // Живой ответ модели: в enum-поле plan стоит описание, а роль выдумана.
    const messy = {
      v: 1,
      seed: 42,
      meta: {
        title: 'Дождь', bpm: 78, meter: '4/4',
        key: { tonic: 'D', mode: 'minor' },
        mood: { valence: -0.6, arousal: -0.2, modifiers: [] },
      },
      palette: {},
      motifs: {},
      sections: [{
        id: 'intro', kind: 'intro', bars: 8, energy: 0.3, tension: 0.4,
        harmony: [{ rn: 'i', bars: 8 }],
        layers: {
          pad: { plan: 'разреженный тёмный педальный слой', density: 0.5, register: [48, 72], weight: 0.7 },
          guitar: { plan: 'lead', density: 0.5, register: [60, 84], weight: 1 },
        },
      }],
      groove: { template: 'drunken', amount: 0.5 },
      mix: { sidechain: [], pan: {}, orbit: {} },
    };
    const complete = async () => JSON.stringify(messy);
    const result = await planWithLLM({ prompt: 'мрачный трип-хоп про дождь', seed: 42, complete });

    // План принят с первого раза — без ремонтного ретрая.
    expect(result.source).toBe('llm');
    expect(result.calls).toBe(1);
    expect(result.ir.sections[0].layers.pad.plan).toBe('pad');
    expect(result.ir.sections[0].layers.guitar).toBeUndefined();
    expect(result.repairs.join(' ')).toMatch(/plan/);
  });

  it('не превышает бюджет вызовов и уходит в правила', async () => {
    let call = 0;
    const complete = async () => {
      call += 1;
      return '{"v":1}';
    };
    const result = await planWithLLM({ prompt: 'злой быстрый dnb', seed: 5, maxCalls: 2, complete });

    expect(call).toBe(2);
    expect(result.calls).toBe(2);
    expect(result.source).toBe('rules');
    expect(result.reason).toBeTruthy();
    // Запасной план — полноценный IR, а не пустышка.
    expect(safeValidateIR(result.ir).ok).toBe(true);
    expect(compileIR(result.ir).code).toMatch(/\$/);
  });

  it('при недоступной модели не падает, а берёт правила', async () => {
    const complete = async () => {
      throw new Error('провайдер недоступен');
    };
    const result = await planWithLLM({ prompt: 'уютный лоуфай для учёбы', seed: 2, complete });
    expect(result.source).toBe('rules');
    expect(result.reason).toMatch(/недоступен/);
    expect(safeValidateIR(result.ir).ok).toBe(true);
  });

  it('повторный запрос берётся из кэша', async () => {
    const ir = planIR('светлый синтипоп для вечеринки', { seed: 11 });
    let call = 0;
    const complete = async () => {
      call += 1;
      return JSON.stringify(ir);
    };
    const first = await planWithLLM({ prompt: 'светлый синтипоп для вечеринки', seed: 11, complete });
    const second = await planWithLLM({ prompt: 'светлый синтипоп для вечеринки', seed: 11, complete });

    expect(call).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.ir).toEqual(first.ir);
  });

  it('ключ кэша меняется при смене версии учебника или зерна', () => {
    const base = { prompt: 'x', seed: 1, skillsVersion: 'a', genre: null };
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, seed: 2 }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, skillsVersion: 'b' }));
  });

  it('в промт уходит учебник, а не только запрос', async () => {
    let seen = null;
    const ir = planIR('тревожный эмбиент, пустой космос', { seed: 1 });
    const complete = async (args) => {
      seen = args;
      return JSON.stringify(ir);
    };
    await planWithLLM({ prompt: 'тревожный эмбиент, пустой космос', seed: 1, complete });

    const system = seen.messages.find((message) => message.role === 'system').content;
    expect(system).toContain('Ты — планировщик композиции');
    expect(system).toContain('COMPOSITION_IR_JSON');
    // Учебник: карта эмбиента и правила пайплайна.
    expect(system).toContain('composer-workflow');
    expect(system).toContain('genre-ambient');
    // Контракт схемы — рядом с учебником.
    expect(system).toContain('sections');
    // Модели отдан структурированный вывод.
    expect(seen.responseFormat.type).toBe('json_schema');
    expect(seen.responseFormat.json_schema.schema).toBe(IR_JSON_SCHEMA);
  });
});

describe('контракт JSON-схемы', () => {
  it('объявляет обязательные поля IR', () => {
    expect(IR_JSON_SCHEMA.required).toEqual(expect.arrayContaining(['v', 'seed', 'meta', 'sections', 'groove']));
    expect(IR_JSON_SCHEMA.properties.meta.required).toEqual(expect.arrayContaining(['title', 'bpm', 'meter', 'key', 'mood']));
    expect(IR_JSON_SCHEMA.properties.sections.items.required)
      .toEqual(expect.arrayContaining(['id', 'kind', 'bars', 'energy', 'tension', 'harmony', 'layers']));
  });

  it('версия схемы присутствует — кэш обязан её учитывать', () => {
    expect(IR_SCHEMA_VERSION).toMatch(/-\d+\.\d+\.\d+$/);
  });

  it('план правил удовлетворяет контракту: все обязательные поля на месте', () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 1 });
    for (const key of IR_JSON_SCHEMA.required) {
      expect(ir, key).toHaveProperty(key);
    }
    for (const key of IR_JSON_SCHEMA.properties.meta.required) {
      expect(ir.meta, key).toHaveProperty(key);
    }
    for (const section of ir.sections) {
      for (const key of IR_JSON_SCHEMA.properties.sections.items.required) {
        expect(section, key).toHaveProperty(key);
      }
    }
  });
});
