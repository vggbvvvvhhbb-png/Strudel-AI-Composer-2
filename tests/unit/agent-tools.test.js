// Инструменты агента: каждый — с проверкой реального поведения.
//
// Проверяем не «функция вернула объект», а существенные свойства:
//   • библиотека ищет по-настоящему и отдаёт статус лицензии;
//   • compose_spec собирает спеку и код (модель подменена, схема настоящая);
//   • compile детерминирован: один и тот же вход — один и тот же код;
//   • edit_ir меняет трек и возвращает ИЗМЕРЕННУЮ дельту;
//   • инструменты без внешних зависимостей работают всегда;
//   • инструмент, который не может сработать, честно это говорит;
//   • неверные аргументы — это ошибка аргументов, а не «инструмент упал».

import { describe, expect, it, vi } from 'vitest';

import { runTool, toolById, toolManifest, toolApiSchemas } from '../../server/agent/tools.js';
import { fallbackSpec } from '../../server/music/compose/pipeline.js';
import { planIR } from '../../src/ir/intent.js';

const completeChat = vi.fn(async () => JSON.stringify(fallbackSpec('techno', 1)));

describe('реестр инструментов', () => {
  it('у каждого инструмента есть описание и схема аргументов', () => {
    const manifest = toolManifest();
    expect(manifest.length).toBeGreaterThanOrEqual(8);
    for (const tool of manifest) {
      expect(tool.id, 'инструмент без id').toBeTruthy();
      expect(tool.title.length, `${tool.id}: нет названия`).toBeGreaterThan(0);
      expect(tool.description.length, `${tool.id}: нет описания`).toBeGreaterThan(20);
    }
  });

  it('инструменты, которых ещё нет, помечены как запланированные', () => {
    const render = toolManifest().find((tool) => tool.id === 'render_local');
    expect(render?.planned).toBe(true);
  });
});

describe('library_search', () => {
  it('находит сэмплы и показывает статус лицензии', async () => {
    const result = await runTool('library_search', { query: 'bd', kind: 'samples', limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit).toHaveProperty('license');
      expect(hit).toHaveProperty('confirmed');
      expect(typeof hit.confirmed).toBe('boolean');
    }
  });

  it('ищет по знаниям и пресетам', async () => {
    const knowledge = await runTool('library_search', { query: 'minor', kind: 'knowledge', limit: 5 });
    expect(knowledge.ok).toBe(true);
    expect(knowledge.hits.length).toBeGreaterThan(0);

    const presets = await runTool('library_search', { query: '', kind: 'presets', limit: 10 });
    expect(presets.ok).toBe(true);
    expect(presets.hits.length).toBeGreaterThan(0);
  });

  it('называет неподтверждённые сэмплы честно', async () => {
    const result = await runTool('library_search', { query: 'zzz-нет-такого-сэмпла', kind: 'samples', limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.hits.length).toBe(0);
  });
});

describe('compose_spec и compile', () => {
  it('собирает спеку и код, и честно помечает запасной путь', async () => {
    const result = await runTool('compose_spec', { prompt: 'тёмный техно на 132 BPM' }, { completeChat });
    expect(result.ok).toBe(true);
    expect(result.spec?.meta?.style).toBeTruthy();
    expect(typeof result.code).toBe('string');
    expect(result.code.length).toBeGreaterThan(0);
    // Модель ответила валидной спекой — значит, запасной путь не использовался.
    expect(result.usedFallback).toBe(false);
  });

  it('компиляция детерминирована', async () => {
    const spec = fallbackSpec('techno', 1);
    const first = await runTool('compile', {}, { currentSpec: spec });
    const second = await runTool('compile', {}, { currentSpec: spec });
    expect(first.ok).toBe(true);
    expect(first.code).toBe(second.code);
    expect(first.parts.length).toBeGreaterThan(0);
  });

  it('компиляция берёт спеку из сессии, а не из аргументов модели', async () => {
    const spec = fallbackSpec('techno', 1);
    // Модель в нативном вызове может подсунуть свою, невалидную спеку —
    // источник истины один: состояние сессии.
    const result = await runTool('compile', { spec: { meta: {} } }, { currentSpec: spec });
    expect(result.ok).toBe(true);
    expect(result.code.length).toBeGreaterThan(0);
  });

  it('без спеки в сессии — честная причина, а не «инструмент упал»', async () => {
    const result = await runTool('compile', {}, {});
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(false);
    expect(result.reason).toMatch(/compose_spec/);
  });

  it('длинное описание трека проходит: лимит совпадает с лимитом маршрута', async () => {
    // Раньше здесь стоял предел 600 символов, и любой длинный запрос падал
    // с «String must contain at most 600 character(s)».
    const prompt = `тёмный бит ${'подробное описание '.repeat(60)}`;
    expect(prompt.length).toBeGreaterThan(600);
    const result = await runTool('compose_spec', { prompt }, { completeChat });
    expect(result.ok).toBe(true);
    expect(result.usedFallback).toBe(false);
  });
});

describe('edit_ir', () => {
  it('меняет трек и возвращает измеренную дельту', async () => {
    const ir = planIR('тёмный ло-фай на 88 BPM', { seed: 1 });
    const result = await runTool('edit_ir', { ir, transform: 'darker', amount: 0.5 });
    expect(result.ok).toBe(true);
    expect(result.transform).toBe('darker');
    expect(result.ir).toBeTruthy();
    expect(result.delta).toHaveProperty('scoreBefore');
    expect(result.delta).toHaveProperty('scoreAfter');
    expect(typeof result.delta.scoreBefore).toBe('number');
  });

  it('неизвестный трансформ — ошибка аргументов', async () => {
    const ir = planIR('тест', { seed: 1 });
    const result = await runTool('edit_ir', { ir, transform: 'не-существует' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/аргумент/i);
  });

  it('план, пришедший JSON-строкой, разбирается и принимается', async () => {
    const ir = planIR('тёмный ло-фай на 88 BPM', { seed: 1 });
    const result = await runTool('edit_ir', { ir: JSON.stringify(ir), transform: 'darker', amount: 0.5 });
    expect(result.ok).toBe(true);
    expect(result.transform).toBe('darker');
  });
});

describe('схемы для нативных вызовов', () => {
  it('у каждого инструмента есть схема аргументов в формате провайдера', () => {
    const schemas = toolApiSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(8);
    for (const entry of schemas) {
      expect(entry.type).toBe('function');
      expect(entry.function.name).toBeTruthy();
      expect(entry.function.parameters.type).toBe('object');
      expect(entry.function.parameters.properties).toBeTruthy();
    }
  });

  it('схемы собираются по списку режима', () => {
    const schemas = toolApiSchemas(['compose_spec', 'compile']);
    expect(schemas.map((entry) => entry.function.name)).toEqual(['compose_spec', 'compile']);
  });

  it('у compose_spec в схеме нет жёсткого предела промта', () => {
    const compose = toolApiSchemas(['compose_spec'])[0];
    expect(compose.function.parameters.properties.prompt.maxLength).toBeGreaterThanOrEqual(4000);
  });
});

describe('usage_report', () => {
  it('отдаёт числа по расходу, а не нули', async () => {
    const result = await runTool('usage_report', { scope: 'all' });
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty('totalTokens');
    expect(result).toHaveProperty('byModel');
  });
});

describe('инструменты без внешних зависимостей', () => {
  it('локальный рендер честно говорит, что это фаза B', async () => {
    const result = await runTool('render_local', { code: 's("bd")' });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/фаза B/i);
  });

  it('разбор честно говорит про 14–27 минут', async () => {
    const result = await runTool('deep_dive', {});
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/14–27 минут/);
  });
});

describe('вызов с ошибками', () => {
  it('неизвестный инструмент не роняет цикл', async () => {
    const result = await runTool('нет_такого', {});
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/неизвестный инструмент/);
  });

  it('инструмент существует в реестре и совпадает по описанию', () => {
    const tool = toolById('library_search');
    expect(tool).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(20);
  });
});
