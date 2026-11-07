// Редактор кода: подсветка синтаксиса, текущая строка, активная партия, курсор стриминга.
//
// Устройство: прозрачная <textarea> поверх <pre> с раскрашенными токенами.
// Каждая строка — отдельный блок <span class="ln">, чтобы по строке можно было
// дать подсветку (текущая строка / партия, которая звучит).
import { parseParts } from './core/code-model.js';
import { highlightLine } from './core/highlight.js';

export { highlightLine };

export function initEditor() {
  const ta = document.getElementById('code-input');
  const pre = document.getElementById('code-hl');
  if (!ta || !pre) return { refresh() {}, setActiveParts() {}, setStreaming() {} };

  let activeParts = new Set();
  let streaming = false;
  let currentLine = -1;
  let rendered = { text: null, current: -2, active: '', streaming: null };

  // Ширина полосы прокрутки textarea съедает место — компенсируем её в <pre>,
  // иначе перенос строк в подсветке и в поле ввода разойдутся.
  function syncMetrics() {
    const style = getComputedStyle(ta);
    const border = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
    const scrollbar = Math.max(0, ta.offsetWidth - ta.clientWidth - border);
    pre.style.paddingRight = `${(parseFloat(style.paddingRight) || 0) + scrollbar}px`;
  }

  function updateCurrentLine() {
    const upto = ta.value.slice(0, ta.selectionStart ?? 0);
    const line = upto.split('\n').length - 1;
    if (line !== currentLine) {
      currentLine = line;
      render();
    }
  }

  function render(force = false) {
    const value = ta.value;
    const activeKey = [...activeParts].sort().join('|');
    if (
      !force &&
      rendered.text === value &&
      rendered.current === currentLine &&
      rendered.active === activeKey &&
      rendered.streaming === streaming
    ) {
      return;
    }

    const lines = value.split('\n');
    const parts = parseParts(value);

    // Карта: номер строки → метка партии; отдельно — строки заголовков партий.
    const partOf = new Map();
    const headOf = new Set();
    for (const p of parts) {
      headOf.add(p.startLine);
      for (let i = p.startLine; i <= p.endLine; i++) partOf.set(i, p.label);
    }

    const html = lines
      .map((line, i) => {
        const label = partOf.get(i);
        const classes = ['ln'];
        if (headOf.has(i)) classes.push('part');
        if (label && activeParts.has(label)) classes.push('part-active');
        if (i === currentLine) classes.push('current');
        const body = highlightLine(line) || '&nbsp;';
        const caret = streaming && i === lines.length - 1 ? '<span class="caret">▍</span>' : '';
        return `<span class="${classes.join(' ')}">${body}${caret}</span>`;
      })
      .join('');

    pre.innerHTML = html;
    rendered = { text: value, current: currentLine, active: activeKey, streaming };
    syncMetrics();
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  }

  const refresh = () => render(true);

  // Перехватываем присваивания .value из стриминга/микшера/транспорта —
  // подсветка и слушатели всегда актуальны.
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(ta, 'value', {
    get() {
      return desc.get.call(this);
    },
    set(v) {
      desc.set.call(this, v);
      render(true);
      ta.dispatchEvent(new Event('input', { bubbles: true })); // микшер и статус слушают input
    },
  });

  ta.addEventListener('input', () => render());
  ta.addEventListener('keyup', updateCurrentLine);
  ta.addEventListener('click', updateCurrentLine);
  ta.addEventListener('select', updateCurrentLine);
  ta.addEventListener('focus', updateCurrentLine);
  ta.addEventListener('scroll', () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncMetrics).observe(ta);
  }
  window.addEventListener('resize', syncMetrics);

  /** Метки партий, которые звучат прямо сейчас — подсвечиваются в коде. */
  function setActiveParts(labels) {
    const next = labels instanceof Set ? labels : new Set(labels || []);
    if (next.size === activeParts.size && [...next].every((l) => activeParts.has(l))) return;
    activeParts = next;
    render();
  }

  /** Режим живой печати: мигающий курсор в конце кода. */
  function setStreaming(on) {
    if (on === streaming) return;
    streaming = Boolean(on);
    ta.closest('.editor-wrap')?.classList.toggle('streaming', streaming);
    render();
  }

  updateCurrentLine();
  render(true);

  return { refresh, setActiveParts, setStreaming };
}
