// Панель помощника-агента: события интерфейса без браузера.
//
// Проверяем то, что важно для пользователя и для честности:
//   • агент вызывается с запросом, режимом и текущим кодом;
//   • план, шаги инструментов и ответ показываются РАЗДЕЛЬНО;
//   • не сработавший инструмент виден как «не сработал», а не молчит;
//   • код из ответа попадает в редактор только по явной кнопке;
//   • без ключа поиска панель пишет об этом ДО запроса.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ agentStream: vi.fn(), fetchAgentTools: vi.fn() }));
vi.mock('../../src/api/client.js', () => api);
vi.mock('../../src/ui.js', () => ({ log: vi.fn() }));

const { initAgentPanel } = await import('../../src/agent-panel.js');

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.style = { setProperty() {} };
    this.classList = {
      set: new Set(),
      add(name) { this.set.add(name); },
      remove(name) { this.set.delete(name); },
      toggle(name, force) {
        const on = force === undefined ? !this.set.has(name) : Boolean(force);
        if (on) this.set.add(name);
        else this.set.delete(name);
        return on;
      },
      contains(name) { return this.set.has(name); },
    };
    // Настоящий DOM: className и classList — одно и то же. Фейковый должен
    // вести себя так же, иначе поиск по классу ничего не находит.
    Object.defineProperty(this, 'className', {
      get: () => [...this.classList.set].join(' '),
      set: (value) => {
        this.classList.set = new Set(String(value || '').split(/\s+/).filter(Boolean));
      },
    });
    this.value = '';
    this.textContent = '';
    this.options = [];
    this.isConnected = true;
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.title = '';
  }

  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  scrollIntoView() {}
  focus() {}
  querySelector(selector) {
    const wanted = selector.replace(/^\./, '');
    const find = (node) => {
      for (const child of node.children ?? []) {
        if (child.classList?.contains(wanted)) return child;
        const deep = find(child);
        if (deep) return deep;
      }
      return null;
    };
    return find(this);
  }

  async click() { await this.listeners.click?.(); }
}

/** Весь текст поддерева — чтобы проверять, что видно пользователю. */
const text = (element) => [element.textContent ?? '', ...element.children.map(text)].join(' ');

let elements;
let setCode;

beforeEach(() => {
  vi.clearAllMocks();
  elements = new Map();
  for (const id of ['agent-input', 'agent-send', 'agent-stop', 'agent-stream', 'agent-mode',
    'agent-services', 'agent-usage']) {
    elements.set(id, new Element());
  }
  elements.get('agent-input').value = 'найди, что такое phonk drift';
  elements.get('agent-mode').value = 'research';
  vi.stubGlobal('document', {
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
  });
  api.fetchAgentTools.mockResolvedValue({
    modes: [
      { id: 'chat', label: 'Чат', hint: 'быстро' },
      { id: 'research', label: 'Ресёрч', hint: 'поиск' },
      { id: 'composer', label: 'Композитор', hint: 'сборка' },
    ],
    tools: [{ id: 'web_search' }, { id: 'library_search' }],
    services: { internet: false, missing: ['EXA_API_KEY'] },
  });
  api.agentStream.mockImplementation(async ({ onEvent }) => {
    onEvent({ type: 'plan', mode: 'research', modeLabel: 'Ресёрч', goal: 'найти стиль', steps: [{ tool: 'web_search', why: 'ищем описание' }] });
    onEvent({ type: 'tool_start', id: 'web_search', index: 1, why: 'ищем описание' });
    onEvent({ type: 'tool_end', id: 'web_search', index: 1, ok: false, degraded: true, reason: 'Интернет недоступен', ms: 5 });
    onEvent({ type: 'text', text: 'Стиль такой-то' });
    onEvent({ type: 'done', mode: 'research', answer: 'Стиль такой-то', degraded: [{ tool: 'web_search', reason: 'Интернет недоступен' }], track: { code: '$KICK: s("bd")' }, guard: { toolCalls: 1 } });
  });
  setCode = vi.fn();
  initAgentPanel({ getCode: () => 'старый код', setCode });
});

afterEach(() => vi.unstubAllGlobals());

describe('паспорт агента', () => {
  it('режимы подставляются, а отсутствие интернета сказано вслух', async () => {
    await Promise.resolve();
    await Promise.resolve();
    const services = elements.get('agent-services');
    expect(services.textContent).toMatch(/Интернет недоступен/);
    const mode = elements.get('agent-mode');
    expect(mode.children.length).toBe(3);
    expect(mode.children[1].value).toBe('research');
  });

  it('пустой список режимов получает умолчание «композитор», а не первый вариант', async () => {
    // Именно этот случай ломался в браузере: после append списка браузер
    // сам выделяет первый вариант («Чат»), и проверка «значение не задано»
    // уже не срабатывала — агент молча работал в режиме чата.
    elements.get('agent-mode').value = '';
    initAgentPanel({ getCode: () => '' });
    await Promise.resolve();
    await Promise.resolve();
    expect(elements.get('agent-mode').value).toBe('composer');
  });

  it('выбранный человеком режим умолчанием не перебивается', async () => {
    expect(elements.get('agent-mode').value).toBe('research');
  });
});

describe('запуск запроса', () => {
  it('агент вызывается с запросом, режимом и текущим кодом', async () => {
    await elements.get('agent-send').click();
    expect(api.agentStream).toHaveBeenCalledTimes(1);
    const call = api.agentStream.mock.calls[0][0];
    expect(call.prompt).toBe('найди, что такое phonk drift');
    expect(call.mode).toBe('research');
    expect(call.currentCode).toBe('старый код');
  });

  it('пустой запрос не отправляется', async () => {
    elements.get('agent-input').value = '   ';
    await elements.get('agent-send').click();
    expect(api.agentStream).not.toHaveBeenCalled();
  });

  it('план, шаги и ответ видны раздельно', async () => {
    await elements.get('agent-send').click();
    const view = text(elements.get('agent-stream'));
    expect(view).toMatch(/найти стиль/);
    expect(view).toMatch(/web_search/);
    expect(view).toMatch(/Стиль такой-то/);
  });

  it('не сработавший инструмент помечен, а не спрятан', async () => {
    await elements.get('agent-send').click();
    const view = text(elements.get('agent-stream'));
    expect(view).toMatch(/не сработал/);
    expect(view).toMatch(/Интернет недоступен/);
    // И в итогах агента деградация зафиксирована.
    expect(view).toMatch(/Часть инструментов не дала данных/);
  });

  it('код из ответа попадает в редактор только по кнопке', async () => {
    await elements.get('agent-send').click();
    expect(setCode).not.toHaveBeenCalled();
    const apply = elements.get('agent-stream').children
      .flatMap((child) => child.children ?? [])
      .find((child) => child.tag === 'button');
    expect(apply).toBeTruthy();
    await apply.click();
    expect(setCode).toHaveBeenCalledWith('$KICK: s("bd")');
  });

  it('после запроса кнопка снова доступна', async () => {
    await elements.get('agent-send').click();
    expect(elements.get('agent-send').disabled).toBe(false);
    expect(elements.get('agent-stop').hidden).toBe(true);
  });
});

describe('расход токенов', () => {
  it('оценка помечается оценкой, а ноль цены — как «цена не измерена»', async () => {
    api.agentStream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'usage', tokens: 305, costUsd: 0, requestCount: 1, estimated: true, priceKnown: false });
    });
    await elements.get('agent-send').click();
    const usage = elements.get('agent-usage').textContent;
    expect(usage).toMatch(/Токенов ≈ 305/);
    expect(usage).toMatch(/оценка/);
    // Ноль цены при неизвестной модели — это «нет данных», а не «бесплатно».
    expect(usage).toMatch(/Цена не измерена/);
  });

  it('измеренная цена показывается числом', async () => {
    api.agentStream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'usage', tokens: 1200, costUsd: 0.0123, requestCount: 2, estimated: false, priceKnown: true });
    });
    await elements.get('agent-send').click();
    const usage = elements.get('agent-usage').textContent;
    expect(usage).toMatch(/Токенов: 1200/);
    expect(usage).toMatch(/\$0\.0123/);
  });

  it('ответ из кэша — токены не тратились', async () => {
    api.agentStream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'usage', tokens: 0, costUsd: 0, cached: true });
    });
    await elements.get('agent-send').click();
    expect(elements.get('agent-usage').textContent).toMatch(/кэш/);
  });
});

describe('память разговора', () => {
  it('прошлые реплики уходят с запросом', async () => {
    await elements.get('agent-send').click();
    expect(api.agentStream.mock.calls[0][0].history).toEqual([]);

    api.agentStream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'text', text: 'Второй ответ' });
    });
    await elements.get('agent-send').click();
    const history = api.agentStream.mock.calls[1][0].history;
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'найди, что такое phonk drift' });
    expect(history[1]).toMatchObject({ role: 'assistant' });
  });
});

describe('кликабельный план', () => {
  it('клик по шагу подсвечивает карточку этого инструмента', async () => {
    await elements.get('agent-send').click();
    const stream = elements.get('agent-stream');
    const plan = stream.children.find((child) => child.classList.contains('agent-plan'));
    const list = plan.children.find((child) => child.classList.contains('agent-steps'));
    const step = list.children[0];
    const button = step.children.find((child) => child.tag === 'button');
    expect(button).toBeTruthy();

    const card = stream.children.find((child) => child.classList.contains('agent-tool'));
    expect(card.classList.contains('is-highlight')).toBe(false);
    await button.click();
    expect(card.classList.contains('is-highlight')).toBe(true);
  });
});
