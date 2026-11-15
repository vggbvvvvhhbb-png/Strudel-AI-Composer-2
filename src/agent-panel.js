// Панель помощника-агента в студии.
//
// ЧТО ПОКАЗЫВАЕМ. Шаги плана и вызовы инструментов — отдельными карточками,
// ответ — отдельно. Это не украшение: пользователь должен видеть, ЧТО агент
// делает, и где он споткнулся. Инструмент, который не сработал, помечен
// прямо в карточке — вместе с причиной.
//
// ПРИМЕНЕНИЕ ПРАВКИ. Если агент собрал код трека, рядом с ответом появляется
// кнопка «Взять в редактор». Ничего не применяется молча: код трека — это
// то, что пользователь слушает, поэтому решение остаётся за ним.
//
// ЧЕСТНОСТЬ СТАТУСА. Если ключа поиска нет, панель пишет об этом ДО запроса:
// «интернет недоступен — агент ответит по локальной библиотеке». Агент не
// притворяется, что искал в интернете.

import { agentStream, fetchAgentTools } from './api/client.js';
import { log } from './ui.js';

const $ = (id) => document.getElementById(id);

/**
 * Создаёт элемент с классами и текстом.
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{getCode:()=>string, setCode:(code:string)=>void, onApply?:(code:string)=>void}} options
 */
export function initAgentPanel({ getCode, setCode, onApply } = {}) {
  const input = $('agent-input');
  const sendBtn = $('agent-send');
  const stopBtn = $('agent-stop');
  const stream = $('agent-stream');
  const modeSelect = $('agent-mode');
  const serviceNote = $('agent-services');
  const usageNote = $('agent-usage');
  const summaryNote = $('agent-summary');
  if (!input || !sendBtn || !stream) return;

  let controller = null;
  let busy = false;

  // История разговора: агент должен помнить, о чём говорили. Храним её в
  // панели (диалог живёт в открытой студии) и отправляем с каждым запросом.
  const history = [];
  const HISTORY_LIMIT = 8;

  // Режим выбирает человек — значит, его выбор главнее умолчания. Отмечаем
  // сам факт выбора, а не значение: паспорт мог прийти уже после выбора.
  let userChoseMode = false;
  modeSelect?.addEventListener('change', () => {
    userChoseMode = true;
  });

  // --- Паспорт агента: режимы и честный статус внешних сервисов ----------
  fetchAgentTools()
    .then((info) => {
      if (modeSelect && modeSelect.options.length === 0) {
        // До подстановки список был пуст: человек выбрать режим ещё не мог.
        const preset = modeSelect.value;
        for (const mode of info.modes ?? []) {
          const option = document.createElement('option');
          option.value = mode.id;
          option.textContent = mode.label;
          option.title = mode.hint ?? '';
          modeSelect.append(option);
        }
        // После append браузер сам выделяет первый вариант («Чат»), поэтому
        // проверка «if (!value)» уже не срабатывает. Умолчание ставим явно —
        // но только если режим не выбрали: ни заранее, ни пока шёл запрос.
        const hasComposer = (info.modes ?? []).some((mode) => mode.id === 'composer');
        if (!preset && !userChoseMode && hasComposer) modeSelect.value = 'composer';
      }
      if (serviceNote) {
        const internet = info.services?.internet;
        serviceNote.textContent = internet
          ? `Инструментов: ${(info.tools ?? []).length}. Интернет доступен.`
          : `Инструментов: ${(info.tools ?? []).length}. Интернет недоступен — агент ответит по локальной библиотеке.`;
        serviceNote.classList.toggle('is-warn', !internet);
      }
    })
    .catch((err) => {
      if (serviceNote) serviceNote.textContent = `Паспорт агента недоступен: ${err.message}`;
    });

  // --- Отрисовка ---------------------------------------------------------
  const clear = () => {
    stream.replaceChildren();
    if (usageNote) usageNote.textContent = '';
    if (summaryNote) summaryNote.textContent = '';
  };

  const toolCards = new Map();

  // Прокручиваем ВНУТРЕННИЙ список, а не через scrollIntoView: тот дёргает
  // внешнюю колонку, и заголовок «Помощник» уезжает из поля зрения вместе
  // с запросом. Пользователь должен видеть, что агент делает, а не искать его.
  function scrollStream() {
    stream.scrollTop = stream.scrollHeight;
  }

  function renderPlan(event) {
    const block = el('div', 'agent-plan');
    const head = el('div', 'agent-plan-head');
    head.append(el('span', 'agent-plan-mode', event.modeLabel ?? event.mode ?? 'план'));
    head.append(el('span', 'agent-plan-goal', event.goal ?? ''));
    block.append(head);

    if (event.degraded) {
      // План по правилам, а не от модели — говорим об этом прямо.
      block.append(el('div', 'agent-warn', event.reason ?? 'План собран по правилам, а не моделью.'));
    }

    const list = el('ol', 'agent-steps');
    for (const step of event.steps ?? []) {
      const item = el('li', 'agent-step');
      // План кликабельный: клик по шагу показывает карточку этого
      // инструмента. Ничего не перезапускается и ничего не стоит денег —
      // шаг просто подсвечивается.
      const button = el('button', 'agent-step-btn');
      button.type = 'button';
      button.title = 'Показать результат этого шага';
      button.append(el('code', 'agent-step-tool', step.tool));
      if (step.why) button.append(el('span', 'agent-step-why', step.why));
      button.addEventListener('click', () => focusTool(step.tool));
      item.append(button);
      list.append(item);
    }
    block.append(list);
    stream.append(block);
  }

  /**
   * Подсвечивает карточку инструмента с указанным именем.
   * @param {string} tool
   */
  function focusTool(tool) {
    for (const card of toolCards.values()) {
      const id = card.querySelector('.agent-tool-id')?.textContent;
      if (id === tool) {
        card.classList.add('is-highlight');
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => card.classList.remove('is-highlight'), 1200);
        return;
      }
    }
  }

  function renderToolStart(event) {
    const card = el('div', 'agent-tool');
    const head = el('div', 'agent-tool-head');
    head.append(el('span', 'agent-tool-icon', '→'));
    head.append(el('code', 'agent-tool-id', event.id));
    head.append(el('span', 'agent-tool-state', 'вызов…'));
    card.append(head);
    if (event.why) card.append(el('div', 'agent-tool-why', event.why));
    toolCards.set(event.index, card);
    stream.append(card);
    scrollStream();
  }

  function renderToolEnd(event) {
    const card = toolCards.get(event.index) ?? el('div', 'agent-tool');
    const state = card.querySelector('.agent-tool-state');
    const failed = !event.ok;
    // Время показываем с точностью до 0.1 мс: у быстрых инструментов
    // целые миллисекунды показывали «0 мс» — то есть ничего.
    const timing = typeof event.ms === 'number' ? ` · ${Math.round(event.ms * 10) / 10} мс` : '';
    card.classList.toggle('is-failed', failed);
    card.classList.toggle('is-degraded', Boolean(event.degraded) && !failed);
    if (state) {
      state.textContent = failed
        ? `не сработал${timing}`
        : event.degraded
          ? 'деградация'
          : `ок${timing}`;
    }
    if (event.reason) card.append(el('div', 'agent-tool-reason', event.reason));
    if (event.summary) card.append(el('div', 'agent-tool-summary', event.summary));
    if (!card.isConnected) stream.append(card);
    scrollStream();
  }

  function renderText(event) {
    let answer = stream.querySelector('.agent-answer');
    if (!answer) {
      answer = el('div', 'agent-answer');
      stream.append(answer);
    }
    answer.textContent += event.text ?? '';
    scrollStream();
  }

  function renderUsage(event) {
    if (!usageNote) return;
    if (event.cached) {
      usageNote.textContent = 'Ответ взят из кэша — токены не тратились.';
      return;
    }
    const tokens = event.tokens ?? 0;
    const parts = [event.estimated
      ? `Токенов ≈ ${tokens} (оценка: провайдер не отдал счётчики)`
      : `Токенов: ${tokens}`];
    // Цена показывается только если она посчитана по известной модели.
    // Ноль цены при неизвестной модели — это «нет данных», а не «бесплатно».
    parts.push(event.priceKnown
      ? `Цена: $${Number(event.costUsd ?? 0).toFixed(4)}`
      : 'Цена не измерена (модель или провайдер неизвестны)');
    if (typeof event.requestCount === 'number' && event.requestCount > 0) {
      parts.push(`учтённых вызовов модели: ${event.requestCount}`);
    }
    usageNote.textContent = parts.join(' · ');
  }

  function renderDone(event) {
    if (event.degraded?.length) {
      const warn = el('div', 'agent-warn');
      warn.append(el('strong', null, 'Часть инструментов не дала данных: '));
      for (const item of event.degraded) {
        warn.append(el('div', 'agent-warn-line', `• ${item.tool}: ${item.reason ?? 'без причины'}`));
      }
      stream.append(warn);
    }
    const code = event.track?.code;
    if (code && code.trim()) {
      const bar = el('div', 'agent-apply');
      const btn = el('button', 'btn primary', '↓ Взять код в редактор');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        setCode?.(code);
        onApply?.(code);
        btn.textContent = '✓ Код в редакторе';
        log('Код агента загружен в редактор', 'ok');
      });
      bar.append(btn);
      stream.append(bar);
    }
    if (summaryNote) {
      const tools = event.guard?.toolCalls ?? 0;
      summaryNote.textContent = `Инструментов вызвано: ${tools}. Режим: ${event.mode}.`;
    }
  }

  // --- Запуск ------------------------------------------------------------
  async function send() {
    if (busy) return;
    const prompt = input.value.trim();
    if (!prompt) {
      input.focus();
      return;
    }
    busy = true;
    clear();
    sendBtn.disabled = true;
    if (stopBtn) stopBtn.hidden = false;
    controller = new AbortController();

    try {
      await agentStream({
        prompt,
        mode: modeSelect?.value || undefined,
        currentCode: getCode?.() ?? null,
        history: history.slice(-HISTORY_LIMIT),
        signal: controller.signal,
        onEvent: (event) => {
          switch (event.type) {
            case 'plan': renderPlan(event); break;
            case 'tool_start': renderToolStart(event); break;
            case 'tool_end': renderToolEnd(event); break;
            case 'text': renderText(event); break;
            case 'usage': renderUsage(event); break;
            case 'done': renderDone(event); break;
            case 'error':
              stream.append(el('div', 'agent-warn', event.message ?? 'Агент остановился с ошибкой.'));
              break;
            default: break;
          }
        },
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        stream.append(el('div', 'agent-warn', 'Остановлено.'));
      } else {
        stream.append(el('div', 'agent-warn', `Агент недоступен: ${err?.message || err}`));
      }
    } finally {
      // Реплики запоминаем только если диалог состоялся: прерванный запрос
      // и ответ «агент недоступен» в память не идут.
      const answer = stream.querySelector('.agent-answer')?.textContent?.trim();
      if (answer) {
        history.push({ role: 'user', content: prompt });
        history.push({ role: 'assistant', content: answer });
        if (history.length > HISTORY_LIMIT * 2) history.splice(0, history.length - HISTORY_LIMIT * 2);
      }
      busy = false;
      sendBtn.disabled = false;
      if (stopBtn) stopBtn.hidden = true;
      controller = null;
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      send();
    }
  });
  stopBtn?.addEventListener('click', () => controller?.abort());
}
