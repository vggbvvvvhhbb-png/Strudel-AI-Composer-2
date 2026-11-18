// Нативный агентный цикл: модель вызывает инструменты структурой.
//
// Регрессии живого гейта A (16.11.2026, relay.fast + Exa):
//   • compose_spec в нативном пути не получал completeChat и ВСЕГДА уходил
//     в запасной план — «спека модели» не рождалась вовсе;
//   • спека, собранная в нативном цикле (bag), не доходила до ctx: компиляция
//     видела «нет спеки» при уже собранной спеке;
//   • tool_end нативного пути не нёс chars — гейт не мог измерить чтение страницы.
//
// Роутер подменён (vi.mock), инструменты и схемы настоящие.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { completeChat, streamChat, completeChatTools, runTool } = vi.hoisted(() => ({
  completeChat: vi.fn(),
  streamChat: vi.fn(),
  completeChatTools: vi.fn(),
  runTool: vi.fn(),
}));

vi.mock('../../server/llm/router.js', () => ({ completeChat, streamChat, completeChatTools }));
vi.mock('../../server/agent/tools.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runTool: (...args) => runTool(...args) };
});

const actualTools = await vi.importActual('../../server/agent/tools.js');
const { runAgent } = await import('../../server/agent/loop.js');
const { fallbackSpec } = await import('../../server/music/compose/pipeline.js');

beforeEach(() => {
  vi.clearAllMocks();
  runTool.mockImplementation(actualTools.runTool);
  streamChat.mockImplementation(async function* () { yield 'ок'; });
});

/** Раунд нативных вызовов: модель просит инструменты. */
function toolRound(calls) {
  return {
    content: null,
    toolCalls: calls.map((call, i) => ({
      id: `call_${i}`,
      name: call.tool,
      arguments: call.args ?? {},
    })),
  };
}

/** Финальный раунд: модель ответила текстом без вызовов. */
function textRound(text) {
  return { content: text, toolCalls: [] };
}

async function collect(options) {
  const events = [];
  for await (const event of runAgent(options)) events.push(event);
  return events;
}

describe('нативный путь: спека и компиляция', () => {
  it('compose_spec получает модель и не деградирует, когда модель ответила', async () => {
    completeChatTools
      .mockResolvedValueOnce(toolRound([{ tool: 'compose_spec', args: { prompt: 'тёмный техно бит' } }]))
      .mockResolvedValueOnce(textRound('Собрал трек.'));
    // Спека «от модели»: валидный план из библиотеки, но путь — модельский.
    completeChat.mockResolvedValue(JSON.stringify(fallbackSpec('techno', 1)));

    const events = await collect({ prompt: 'натив-тест-1: сделай техно бит', mode: 'composer', env: {} });
    const specEnd = events.find((event) => event.type === 'tool_end' && event.id === 'compose_spec');
    expect(specEnd.ok).toBe(true);
    expect(specEnd.degraded).toBe(false);
    expect(completeChat).toHaveBeenCalled();
    const done = events.find((event) => event.type === 'done');
    expect(done.track.spec).toBeTruthy();
    expect(done.track.code.length).toBeGreaterThan(0);
  });

  it('compile после нативного compose_spec видит спеку сессии', async () => {
    completeChatTools
      .mockResolvedValueOnce(toolRound([{ tool: 'compose_spec', args: { prompt: 'тёмный техно бит' } }]))
      .mockResolvedValueOnce(toolRound([{ tool: 'compile', args: {} }]))
      .mockResolvedValueOnce(textRound('Готово.'));
    completeChat.mockResolvedValue(JSON.stringify(fallbackSpec('techno', 1)));

    const events = await collect({ prompt: 'натив-тест-2: сделай техно бит', mode: 'composer', env: {} });
    const compileEnd = events.find((event) => event.type === 'tool_end' && event.id === 'compile');
    expect(compileEnd.ok).toBe(true);
    expect(compileEnd.reason).toBeNull();
  });

  it('гарантия композитора: compile без вызова моделью берёт спеку из нативного цикла', async () => {
    // Модель собрала спеку и ответила текстом, compile не вызвала.
    // ensureComposed обязан скомпилировать НА ТОЙ ЖЕ спеке, а не упасть
    // с «нет спеки» (баг живого прогона: bag.spec не синхронизировался с ctx).
    completeChatTools
      .mockResolvedValueOnce(toolRound([{ tool: 'compose_spec', args: { prompt: 'тёмный техно бит' } }]))
      .mockResolvedValueOnce(textRound('Собрал.'));
    completeChat.mockResolvedValue(JSON.stringify(fallbackSpec('techno', 1)));

    const events = await collect({ prompt: 'натив-тест-3: сделай техно бит', mode: 'composer', env: {} });
    const compileEnds = events.filter((event) => event.type === 'tool_end' && event.id === 'compile');
    expect(compileEnds.length).toBe(1);
    expect(compileEnds[0].ok).toBe(true);
  });
});

describe('нативный P5: измеренный контекст', () => {
  it('паспорт доступен модели, compose_spec и гарантированной композиции', async () => {
    const reference = { passport: { durationS: 8, measurements: { tempo: { bpm: 120 } } }, candidates: {} };
    runTool.mockImplementation(async (id, args, ctx) => id === 'analyze_reference'
      ? { ok: true, degraded: false, reference }
      : actualTools.runTool(id, args, ctx));
    completeChatTools
      .mockResolvedValueOnce(toolRound([{ tool: 'analyze_reference', args: { taskId: '12345678-1234-4234-8234-123456789abc' } }]))
      .mockResolvedValueOnce(textRound('Референс измерен.'));
    completeChat.mockResolvedValue(JSON.stringify(fallbackSpec('techno', 1)));
    const events = await collect({ prompt: 'натив-p5: сделай techno бит', mode: 'composer', env: {} });
    expect(completeChat.mock.calls[0][0].messages[0].content).toContain(JSON.stringify(reference.passport));
    const modelToolMessage = completeChatTools.mock.calls[1][0].messages.find(m => m.role === 'tool');
    expect(JSON.parse(modelToolMessage.content).reference).toEqual(reference);
    expect(events.find(e => e.type === 'done').track.spec).toBeTruthy();
  });

  it('паспорт сохраняется между нативными раундами до явного compose_spec', async () => {
    const reference = { passport: { durationS: 12 }, candidates: {} };
    runTool.mockImplementation(async (id, args, ctx) => id === 'analyze_reference'
      ? { ok: true, degraded: false, reference }
      : actualTools.runTool(id, args, ctx));
    completeChatTools
      .mockResolvedValueOnce(toolRound([{ tool: 'analyze_reference', args: { taskId: '12345678-1234-4234-8234-123456789abc' } }]))
      .mockResolvedValueOnce(toolRound([{ tool: 'compose_spec', args: { prompt: 'techno' } }]))
      .mockResolvedValueOnce(textRound('Готово.'));
    completeChat.mockResolvedValue(JSON.stringify(fallbackSpec('techno', 1)));
    await collect({ prompt: 'натив-p5-explicit: сделай techno бит', mode: 'composer', env: {} });
    expect(completeChat.mock.calls[0][0].messages[0].content).toContain(JSON.stringify(reference.passport));
  });
});

describe('нативный путь: измеримость шагов', () => {
  it('tool_end чтения страницы несёт chars — длину прочитанного текста', async () => {
    const pageText = 'phonk drift — '.repeat(60);
    completeChatTools
      .mockResolvedValueOnce(toolRound([{ tool: 'web_fetch', args: { url: 'https://example.org/phonk' } }]))
      .mockResolvedValueOnce(textRound('Прочитал.'));
    runTool.mockImplementation(async (name, args, ctx) => {
      if (name === 'web_fetch') return { ok: true, url: args.url, text: pageText, truncated: false };
      return actualTools.runTool(name, args, ctx);
    });

    const events = await collect({ prompt: 'натив-тест-4: прочитай страницу о phonk', mode: 'research', env: {} });
    const fetchEnd = events.find((event) => event.type === 'tool_end' && event.id === 'web_fetch');
    expect(fetchEnd.ok).toBe(true);
    expect(fetchEnd.chars).toBe(pageText.length);
  });
});