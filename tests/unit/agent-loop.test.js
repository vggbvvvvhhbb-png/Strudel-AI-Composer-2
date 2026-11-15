// Агентный цикл: план → инструмент → наблюдение → ответ.
//
// Проверяем поведение, а не «функция вернула объект»:
//   • модель выбирает инструменты, и мы их выполняем (настоящий цикл);
//   • модель ответила мусором — план строится по правилам, а не падает;
//   • модель недоступна — агент отвечает по наблюдениям и говорит об этом;
//   • инструмент деградировал — это видно и в шаге, и в итоге;
//   • лимиты сессии соблюдаются: бесконечного цикла не будет;
//   • ответ приходит потоком событий, шаги отдельно от текста.
//
// Модель подменена (vi.mock) — сам цикл, инструменты и схемы настоящие.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { completeChat, streamChat, runTool } = vi.hoisted(() => ({
  completeChat: vi.fn(),
  streamChat: vi.fn(),
  runTool: vi.fn(),
}));

vi.mock('../../server/llm/router.js', () => ({ completeChat, streamChat }));
// Инструменты — по умолчанию настоящие; подменяются только в тех тестах,
// где нужен конкретный ответ (например, поиск без ключа поиска).
vi.mock('../../server/agent/tools.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runTool: (...args) => runTool(...args) };
});

// importActual, а не import: обычный import вернул бы мок, и вызов ушёл бы
// в него же — бесконечная рекурсия.
const actualTools = await vi.importActual('../../server/agent/tools.js');
const { runAgent, detectMode, deterministicAnswer } = await import('../../server/agent/loop.js');
const { fallbackSpec } = await import('../../server/music/compose/pipeline.js');

beforeEach(() => {
  runTool.mockImplementation(actualTools.runTool);
});

/** Собирает события цикла в массив. */
async function collect(options) {
  const events = [];
  for await (const event of runAgent(options)) events.push(event);
  return events;
}

/** План от «модели»: JSON, как его ждёт навигатор. */
function planJson(steps, mode = 'composer', goal = 'Собрать бит') {
  return JSON.stringify({ mode, goal, steps });
}

describe('выбор режима', () => {
  it('по словам запроса определяется режим', () => {
    expect(detectMode('найди в интернете, что такое phonk drift')).toBe('research');
    expect(detectMode('сделай бит в стиле phonk')).toBe('composer');
    expect(detectMode('поменяй тембр виолончели')).toBe('director');
    expect(detectMode('привет')).toBe('chat');
  });

  it('запрос гайда — композитор: цель в бите, поиск лишь подготовка', () => {
    // Запрос гейда: «найди в интернете, что такое phonk drift, и сделай бит
    // в этом стиле». Раньше побеждал поиск, и агент оставался в ресёрче без
    // инструментов компиляции — половину запроса выполнить не мог.
    expect(detectMode('найди в интернете, что такое phonk drift, и сделай бит в этом стиле')).toBe('composer');
  });
});

describe('цепочка поиск → чтение', () => {
  it('после успешного поиска агент читает найденную страницу', async () => {
    const calls = [];
    completeChat.mockResolvedValue(planJson([
      { tool: 'web_search', args: { query: 'phonk drift' } },
    ], 'composer'));
    streamChat.mockImplementation(async function* () { yield 'ок'; });

    // Подменяем инструмент поиска: настоящий требует ключа, а проверяем
    // именно цепочку «нашёл адрес → прочитал страницу».
    runTool.mockImplementation(async (name, args) => {
      calls.push(name);
      if (name === 'web_search') {
        return { ok: true, available: true, degraded: false, results: [{ title: 'Phonk', url: 'https://example.org/phonk' }] };
      }
      if (name === 'web_fetch') {
        return { ok: true, url: args.url, text: 'phonk — мемфис-рэп', truncated: false };
      }
      return actualTools.runTool(name, args, {});
    });

    const events = await collect({
      prompt: 'найди в интернете, что такое phonk drift, и сделай бит в этом стиле',
      mode: 'composer',
      env: {},
    });
    expect(calls).toContain('web_search');
    expect(calls).toContain('web_fetch');
    const fetchStart = events.find((event) => event.type === 'tool_start' && event.id === 'web_fetch');
    expect(fetchStart.args.url).toBe('https://example.org/phonk');
    // Шаг добавлен на лету — это видно в его «зачем».
    expect(fetchStart.why).toMatch(/прочитать найденную страницу/);
  });
});

describe('цикл с моделью', () => {
  it('модель выбирает инструменты, мы их выполняем, ответ приходит потоком', async () => {
    completeChat.mockImplementation(async ({ messages }) => {
      const text = messages.map((message) => message.content).join('\n');
      // Планировщик и сборщик спеки — разные запросы: различаем по маркеру.
      if (text.includes('AGENT_PLAN_JSON')) {
        return planJson([
          { tool: 'library_search', args: { query: 'kick', kind: 'samples', limit: 3 }, why: 'подобрать ударные' },
          { tool: 'compose_spec', args: { prompt: 'тёмный бит с ударными' }, why: 'собрать спеку' },
          { tool: 'compile', args: {}, why: 'скомпилировать' },
        ]);
      }
      return JSON.stringify(fallbackSpec('techno', 1));
    });
    streamChat.mockImplementation(async function* () {
      yield 'Собрал ';
      yield 'бит.';
    });

    const events = await collect({ prompt: 'сделай бит с ударными', mode: 'composer', env: {} });
    const types = events.map((event) => event.type);

    expect(types[0]).toBe('plan');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
    expect(types).toContain('text');
    expect(types[types.length - 1]).toBe('done');

    const plan = events.find((event) => event.type === 'plan');
    expect(plan.planSource).toBe('model');
    expect(plan.steps.map((step) => step.tool)).toEqual(['library_search', 'compose_spec', 'compile']);

    const done = events.find((event) => event.type === 'done');
    expect(done.answer).toBe('Собрал бит.');
    expect(done.toolsUsed).toEqual(['library_search', 'compose_spec', 'compile']);
    expect(done.degraded).toEqual([]);
    // Спека от предыдущего шага подставилась в компиляцию автоматически.
    expect(typeof done.track.code).toBe('string');
    expect(done.track.code.length).toBeGreaterThan(0);
  });

  it('компиляция без спеки — честная причина, а не «инструмент упал»', async () => {
    completeChat.mockResolvedValue(planJson([
      { tool: 'compile', args: {}, why: 'скомпилировать' },
    ]));
    streamChat.mockImplementation(async function* () { yield 'ок'; });

    const events = await collect({ prompt: 'сделай бит', mode: 'composer', env: {} });
    const toolEnd = events.find((event) => event.type === 'tool_end');
    expect(toolEnd.ok).toBe(false);
    expect(toolEnd.reason).toMatch(/compose_spec/);
  });

  it('мусор вместо плана — план по правилам, и это сказано вслух', async () => {
    completeChat.mockResolvedValue('не знаю, что делать');
    streamChat.mockImplementation(async function* () {
      yield 'Ответ по правилам.';
    });

    const events = await collect({ prompt: 'найди в интернете, что такое phonk drift', env: {} });
    const plan = events.find((event) => event.type === 'plan');
    expect(plan.planSource).toBe('heuristic');
    expect(plan.degraded).toBe(true);
    expect(plan.reason).toMatch(/валидный план/);
    // Эвристика должна предложить осмысленные шаги, а не пустой список.
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it('инструмент вне режима в план не попадает', async () => {
    completeChat.mockResolvedValue(planJson([
      { tool: 'edit_ir', args: { transform: 'darker' } },
      { tool: 'library_search', args: { query: 'kick' } },
    ], 'composer'));
    streamChat.mockImplementation(async function* () { yield 'ок'; });

    const events = await collect({ prompt: 'сделай бит', mode: 'composer', env: {} });
    const plan = events.find((event) => event.type === 'plan');
    // edit_ir — инструмент режима «Дирижёр». В композиторе его быть не должно:
    // режим — это и есть лимит, иначе агент правил бы чужой трек.
    expect(plan.steps.map((step) => step.tool)).toEqual(['library_search']);
  });
});

describe('честная деградация', () => {
  it('без ключа поиск деградирует, и это видно в шаге и в итоге', async () => {
    completeChat.mockResolvedValue(planJson([
      { tool: 'web_search', args: { query: 'phonk drift' } },
    ], 'research'));
    streamChat.mockImplementation(async function* () { yield 'Ответ без интернета.'; });

    const events = await collect({ prompt: 'найди в интернете, что такое phonk drift', mode: 'research', env: {} });
    const toolEnd = events.find((event) => event.type === 'tool_end');
    expect(toolEnd.ok).toBe(false);
    expect(toolEnd.degraded).toBe(true);
    expect(toolEnd.reason).toMatch(/Интернет недоступен/);

    const done = events.find((event) => event.type === 'done');
    expect(done.degraded.length).toBe(1);
    expect(done.degraded[0].tool).toBe('web_search');
  });
});

describe('модель недоступна', () => {
  it('агент отвечает по наблюдениям и признаётся в этом', async () => {
    completeChat.mockRejectedValue(new Error('LLM недоступен'));
    streamChat.mockRejectedValue(new Error('LLM недоступен'));

    const events = await collect({ prompt: 'найди, что такое phonk drift', mode: 'research', env: {} });
    const done = events.find((event) => event.type === 'done');
    expect(done.answerSource).toBe('observations');
    expect(done.answer).toMatch(/без модели/);
    // Инструмент всё равно был вызван — цикл не остановился на первом шаге.
    expect(done.toolsUsed.length).toBeGreaterThan(0);
  });

  it('детерминированный ответ перечисляет статусы инструментов', () => {
    const answer = deterministicAnswer({
      plan: { goal: 'goal' },
      observations: [{ tool: 'web_search', ok: false, degraded: true, reason: 'Интернет недоступен', summary: null }],
      degraded: [{ tool: 'web_search', reason: 'Интернет недоступен' }],
    });
    expect(answer).toMatch(/web_search/);
    expect(answer).toMatch(/Интернет недоступен/);
    expect(answer).toMatch(/честная оговорка/i);
  });
});

describe('расход токенов и память', () => {
  it('без счётчиков провайдера usage — честная оценка, а не ноль', async () => {
    completeChat.mockResolvedValue(planJson([
      { tool: 'library_search', args: { query: 'kick' } },
    ], 'composer'));
    streamChat.mockImplementation(async function* () { yield 'ок' });

    // Запрос уникальный: иначе ответ возьмётся из кэша ответов, а это
    // другая ветка (токены не тратились вовсе).
    const events = await collect({ prompt: 'уникальный запрос для замера usage 42', mode: 'composer', env: {} });
    const usage = events.find((event) => event.type === 'usage');
    expect(usage).toBeTruthy();
    // Провайдер (в тесте — мок) счётчиков не отдал: ноль токенов означал бы
    // «бесплатно», а правда — «нет данных». Значит, показываем оценку.
    expect(usage.estimated).toBe(true);
    expect(usage.tokens).toBeGreaterThan(0);
    // Цена неизвестна — флаг говорит, что показывать нечего.
    expect(usage.priceKnown).toBe(false);
  });

  it('ответ из кэша — токены не потрачены, и это сказано прямо', async () => {
    completeChat.mockResolvedValue(planJson([
      { tool: 'library_search', args: { query: 'kick' } },
    ], 'composer'));
    streamChat.mockImplementation(async function* () { yield 'ок' });

    const prompt = 'второй одинаковый запрос для проверки кэша 7';
    await collect({ prompt, mode: 'composer', env: {} });
    const events = await collect({ prompt, mode: 'composer', env: {} });
    const usage = events.find((event) => event.type === 'usage');
    expect(usage.cached).toBe(true);
    expect(usage.tokens).toBe(0);
  });

  it('предыдущие реплики попадают в промпт ответчика', async () => {
    completeChat.mockResolvedValue(planJson([
      { tool: 'library_search', args: { query: 'kick' } },
    ], 'composer'));
    streamChat.mockImplementation(async function* () { yield 'ок' });

    await collect({
      prompt: 'сделай бит с учётом прошлого',
      mode: 'composer',
      env: {},
      history: [
        { role: 'user', content: 'хочу тёмный бит' },
        { role: 'assistant', content: 'сделаю тёмный бит' },
      ],
    });

    const messages = streamChat.mock.calls.at(-1)[0].messages;
    const joined = messages.map((message) => message.content).join('\n');
    expect(joined).toMatch(/хочу тёмный бит/);
    expect(joined).toMatch(/сделаю тёмный бит/);
  });
});

describe('лимиты сессии', () => {
  it('шагов больше лимита режима — лишние не выполняются', async () => {
    const steps = Array.from({ length: 12 }, () => ({ tool: 'library_search', args: { query: 'kick' } }));
    completeChat.mockResolvedValue(planJson(steps, 'composer'));
    streamChat.mockImplementation(async function* () { yield 'ок'; });

    const events = await collect({ prompt: 'сделай бит', mode: 'composer', env: {} });
    const started = events.filter((event) => event.type === 'tool_start');
    expect(started.length).toBeLessThanOrEqual(8);
    const done = events.find((event) => event.type === 'done');
    expect(done.guard.steps).toBeLessThanOrEqual(8);
  });

  it('один и тот же инструмент не вызывается бесконечно', async () => {
    const steps = Array.from({ length: 10 }, () => ({ tool: 'library_search', args: { query: 'kick' } }));
    completeChat.mockResolvedValue(planJson(steps, 'composer'));
    streamChat.mockImplementation(async function* () { yield 'ок'; });

    const events = await collect({ prompt: 'сделай бит', mode: 'composer', env: {} });
    const started = events.filter((event) => event.type === 'tool_start');
    expect(started.length).toBeLessThanOrEqual(8);
  });
});
