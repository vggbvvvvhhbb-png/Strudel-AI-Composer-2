// Учёт стоимости LLM: цена, честность цен и ровно одна запись на вызов.
//
// Почему тест идёт через настоящий роутер, а не напрямую в recordUsage:
// главный риск был не «функция не считает», а «считает дважды» или
// «не считает вовсе, потому что вызвали из другого места». Роутер —
// единственная точка, где токены тратятся, поэтому тест бьёт по нему.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PRICING,
  priceOf,
  recordUsage,
  resetUsage,
  usageSummary,
} from '../../server/stats.js';
import { mergeUsage, parseProviderUsage } from '../../server/llm/usage.js';
import { withUsageContext } from '../../server/llm/context.js';

let originalFetch = null;

beforeEach(() => {
  resetUsage();
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** Заглушка провайдера: ответ OpenAI сusage-счётчиком. */
function stubProvider({ promptTokens = 1000, completionTokens = 500 } = {}) {
  global.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'сгенерированный код' } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('таблица цен', () => {
  it('знает модель владельца (gpt-6-luna через relay.fast, D-120)', () => {
    const price = priceOf('gpt-6-luna');
    expect(price.known).toBe(true);
    expect(price.prompt).toBe(0.008);
    expect(price.completion).toBe(0.04);
  });

  it('знает модель по умолчанию для Anthropic (claude-sonnet-4-5)', () => {
    // Раньше в таблице был только 'claude-sonnet-4', а модель по умолчанию —
    // 'claude-sonnet-4-5': её использование считалось бесплатным.
    const price = priceOf('claude-sonnet-4-5');
    expect(price.known).toBe(true);
    expect(price.prompt).toBe(3);
    expect(price.completion).toBe(15);
  });

  it('префикс free/ больше не означает «бесплатно» (правило APInex, D-120)', () => {
    // На relay.fast free-моделей нет: молча считать free/… бесплатным нельзя.
    const price = priceOf('free/gpt-6-luna');
    expect(price.known).toBe(false);
    expect(price.reason).toBe('unknown-model');
  });

  it('неизвестная модель помечается как «цена неизвестна»', () => {
    const price = priceOf('какая-то-новая-модель');
    expect(price.known).toBe(false);
    expect(price.reason).toBe('unknown-model');
  });

  it('в таблице нет моделей с нулевой ценой без причины', () => {
    for (const [model, price] of Object.entries(PRICING)) {
      expect(price.prompt).toBeGreaterThan(0);
      expect(price.completion).toBeGreaterThan(0);
      expect(model).toBeTruthy();
    }
  });
});

describe('запись и агрегаты', () => {
  it('считает цену по токенам', () => {
    recordUsage({ model: 'gpt-6-luna', promptTokens: 1_000_000, completionTokens: 1_000_000 });
    const summary = usageSummary();
    expect(summary.requests).toBe(1);
    expect(summary.promptTokens).toBe(1_000_000);
    expect(summary.costUsd).toBeCloseTo(0.048, 6);
  });

  it('группирует по фиче, сессии, суткам и операции', () => {
    withUsageContext({ operationId: 'op-1', sessionId: 's-1' }, () => {
      recordUsage({ model: 'gpt-6-luna', promptTokens: 1000, completionTokens: 500, feature: 'compose' });
    });
    withUsageContext({ operationId: 'op-2', sessionId: 's-1' }, () => {
      recordUsage({ model: 'gpt-6-luna', promptTokens: 2000, completionTokens: 1000, feature: 'compose' });
    });
    const summary = usageSummary();
    expect(summary.byFeature.compose.requests).toBe(2);
    expect(summary.bySession['s-1'].requests).toBe(2);
    expect(summary.byOperation['op-1'].requests).toBe(1);
    // Цена одной операции = цена одной генерации.
    expect(summary.tracks.length).toBe(2);
    expect(summary.tracks[0].costUsd).toBeGreaterThan(0);
    // Цена суток — сумма за сегодня.
    expect(summary.night.requests).toBe(2);
    expect(summary.night.costUsd).toBeCloseTo(summary.costUsd, 8);
  });

  it('модель без цены попадает в отдельный список, а не в молчаливый ноль', () => {
    recordUsage({ model: 'неизвестная-модель', promptTokens: 1000, completionTokens: 500 });
    const summary = usageSummary();
    expect(summary.unpricedModels.length).toBe(1);
    expect(summary.unpricedModels[0].model).toBe('неизвестная-модель');
    expect(summary.unpricedModels[0].requests).toBe(1);
  });

  it('явная цена важнее расчётной (транскрипция считается по секундам)', () => {
    recordUsage({ model: 'whisper-large-v3-turbo', costUsd: 0.5 });
    expect(usageSummary().costUsd).toBe(0.5);
    expect(usageSummary().unpricedModels.length).toBe(0);
  });

  it('сервис с явной ценой 0 (Freesound) — не «модель без цены»', () => {
    // Freesound бесплатен, но это измеренный факт, а не дыра в таблице цен.
    recordUsage({ model: 'freesound-search', provider: 'freesound', costUsd: 0 });
    const summary = usageSummary();
    expect(summary.requests).toBe(1);
    expect(summary.unpricedModels.length).toBe(0);
  });
});

describe('нормализация usage провайдеров', () => {
  it('понимает формат OpenAI', () => {
    expect(parseProviderUsage({ prompt_tokens: 10, completion_tokens: 20 }))
      .toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it('понимает формат Anthropic', () => {
    expect(parseProviderUsage({ input_tokens: 10, output_tokens: 20 }))
      .toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it('сливает максимумом, а не суммой', () => {
    // Anthropic присылает счётчик двумя событиями — сумма дала бы двойной счёт.
    expect(mergeUsage({ input_tokens: 10 }, { output_tokens: 20 }))
      .toEqual({ promptTokens: 10, completionTokens: 20 });
    expect(mergeUsage({ prompt_tokens: 10, completion_tokens: 20 }, { prompt_tokens: 10, completion_tokens: 20 }))
      .toEqual({ promptTokens: 10, completionTokens: 20 });
  });
});

describe('сквозной путь: вызов модели → цена в /api/stats', () => {
  it('один вызов — ровно одна запись и ненулевая цена', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-6-luna';
    process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
    process.env.LLM_PROVIDERS = 'openai';
    delete process.env.MOCK_LLM;

    const { completeChat } = await import('../../server/llm/router.js');
    stubProvider({ promptTokens: 1000, completionTokens: 500 });

    const content = await completeChat({
      messages: [{ role: 'user', content: 'сделай бит' }],
      feature: 'compose',
    });
    expect(content).toBe('сгенерированный код');

    const summary = usageSummary();
    expect(summary.requests).toBe(1);
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(summary.byFeature.compose.requests).toBe(1);
    expect(summary.byModel['gpt-6-luna'].requests).toBe(1);
  });

  it('onUsage не удваивает запись', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-6-luna';
    process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
    process.env.LLM_PROVIDERS = 'openai';

    const { completeChat } = await import('../../server/llm/router.js');
    stubProvider();

    const seen = [];
    await completeChat({
      messages: [{ role: 'user', content: 'ещё' }],
      feature: 'variants',
      onUsage: (usage) => seen.push(usage),
    });

    expect(seen.length).toBe(1);
    // Запись ровно одна: колбэк вызывающего и учёт — не одно и то же.
    expect(usageSummary().requests).toBe(1);
    expect(usageSummary().byFeature.variants.requests).toBe(1);
  });

  it('цена операции = цена одной генерации, а не сумма всего сервера', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-6-luna';
    process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
    process.env.LLM_PROVIDERS = 'openai';

    const { completeChat } = await import('../../server/llm/router.js');
    stubProvider({ promptTokens: 1000, completionTokens: 500 });

    await withUsageContext({ operationId: 'op-track-1', sessionId: 's-1' }, () =>
      completeChat({ messages: [{ role: 'user', content: 'трек' }], feature: 'compose' }));

    const summary = usageSummary();
    expect(summary.byOperation['op-track-1'].requests).toBe(1);
    expect(summary.tracks.length).toBe(1);
    expect(summary.tracks[0].costUsd).toBeCloseTo(summary.costUsd, 8);
    expect(summary.sessions.length).toBe(1);
  });
});

describe('потоковая генерация', () => {
  it('счётчик провайдера в потоке — измерение, а не оценка', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-6-luna';
    process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
    process.env.LLM_PROVIDERS = 'openai';

    const { streamChat } = await import('../../server/llm/router.js');
    const sse = [
      'data: {"choices":[{"delta":{"content":"ко"}}]}',
      'data: {"choices":[{"delta":{"content":"д"}}]}',
      'data: {"usage":{"prompt_tokens":800,"completion_tokens":200},"choices":[]}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    global.fetch = async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

    const chunks = [];
    for await (const delta of streamChat({
      messages: [{ role: 'user', content: 'сгенерируй' }],
      feature: 'generate',
    })) {
      chunks.push(delta);
    }
    expect(chunks.join('')).toBe('код');

    const summary = usageSummary();
    expect(summary.requests).toBe(1);
    expect(summary.estimatedRequests).toBe(0);
    expect(summary.totalTokens).toBe(1000);
    expect(summary.costUsd).toBeGreaterThan(0);
  });

  it('поток без счётчика — честная оценка с флагом, а не ноль', async () => {
    // Так работает APInex: stream_options.include_usage он может проигнорировать.
    // Молчаливый ноль означал бы «бесплатно», а это неправда.
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-6-luna';
    process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
    process.env.LLM_PROVIDERS = 'openai';

    const { streamChat } = await import('../../server/llm/router.js');
    const sse = 'data: {"choices":[{"delta":{"content":"код"}}]}\n\ndata: [DONE]\n\n';
    global.fetch = async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

    const chunks = [];
    for await (const delta of streamChat({
      messages: [{ role: 'user', content: 'описание трека' }],
      feature: 'generate',
    })) {
      chunks.push(delta);
    }
    expect(chunks.join('')).toBe('код');

    const summary = usageSummary();
    expect(summary.requests).toBe(1);
    expect(summary.estimatedRequests).toBe(1);
    expect(summary.totalTokens).toBeGreaterThan(0);
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(summary.byFeature.generate.requests).toBe(1);
  });
});
