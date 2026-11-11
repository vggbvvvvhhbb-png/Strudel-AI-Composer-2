// Структурная композиция в интерфейсе: переключатель режимов,
// трейс пайплайна и таймлайн секций.
//
// Модуль не знает про устройство приложения: код берётся через getCode,
// результат возвращается через setCode/applyCode, сообщения — через log.
// Данные с сервера вставляются только через textContent.

import { composeTrack, composeVariants, composeMutate } from './api/client.js';

const $ = (id) => document.getElementById(id);

const hooks = {
  getCode: () => '',
  setCode: null,
  applyCode: null,
  log: () => {},
};

let els = null;
let pending = 0;
// Последняя спека — к ней применяются мутации и варианты.
// Без неё кнопки разнообразия недоступны: мутировать нечего.
let lastSpec = null;

// Режимы генерации. «Структурный» — LLM планирует, компилятор пишет
// код (валидно по построению). «Свободный» — код пишет модель сам.
const MODES = [
  { id: 'structured', label: 'Структурный' },
  { id: 'free', label: 'Свободный' },
];

export function initCompose({ getCode, setCode, applyCode, log } = {}) {
  if (getCode) hooks.getCode = getCode;
  if (setCode) hooks.setCode = setCode;
  if (applyCode) hooks.applyCode = applyCode;
  if (log) hooks.log = log;

  els = {
    mode: $('compose-mode'),
    run: $('btn-compose'),
    mutate: $('btn-compose-mutate'),
    variants: $('btn-compose-variants'),
    trace: $('compose-trace'),
    timeline: $('compose-timeline'),
    blocks: $('compose-timeline-blocks'),
    energy: $('compose-energy'),
    sections: $('compose-sections'),
    variantBox: $('compose-variants'),
  };
  if (!els.trace) {
    els = null;
    return;
  }

  els.run?.addEventListener('click', () => runCompose());
  els.mutate?.addEventListener('click', () => runMutate());
  els.variants?.addEventListener('click', () => runSpecVariants());
  els.mode?.addEventListener('change', () => {
    const structured = els.mode.value === 'structured';
    // В свободном режиме трейс и таймлайн не строятся: нет спеки.
    if (els.timeline) els.timeline.hidden = !structured;
    if (els.sections) els.sections.hidden = !structured;
    hooks.log(structured ? 'Режим: структурный (план → код)' : 'Режим: свободный (код пишет модель)');
  });
}

/* --- Запуск пайплайна --- */

async function runCompose() {
  const prompt = String($('prompt-input')?.value ?? '').trim();
  if (!prompt) {
    hooks.log('Введите команду — по ней строится трек', 'error');
    return;
  }
  const mode = els.mode?.value === 'free' ? 'free' : 'structured';

  pushBusy();
  clearTrace();
  try {
    const result = await composeTrack({
      prompt,
      mode,
      onEvent: (event) => handleEvent(event),
    });
    if (result.code) {
      await applyCode(result.code);
      hooks.log(
        `Трек готов: ${result.score?.total ?? '—'} баллов${result.improved ? ` (было ${result.before})` : ''}`,
        'ok',
      );
    }
  } catch (err) {
    hooks.log(`Композиция не удалась: ${err.message || err}`, 'error');
  } finally {
    popBusy();
  }
}

/* --- Разнообразие: мутации и варианты спеки --- */

// «🎲 ещё вариант»: одна детерминированная мутация спеки, без модели.
async function runMutate() {
  if (!lastSpec) {
    hooks.log('Сначала спланируйте трек — мутировать нечего', 'error');
    return;
  }
  pushBusy(els.mutate);
  try {
    const result = await composeMutate({
      spec: lastSpec,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    lastSpec = result.spec;
    await applyCode(result.code);
    renderSpec({ spec: result.spec, attempts: 0, usedFallback: false });
    renderTimeline(result.sections || []);
    hooks.log(`Вариант «${result.mutation}»: ${result.score?.total ?? '—'} баллов`, 'ok');
  } catch (err) {
    hooks.log(`Мутация не удалась: ${err.message || err}`, 'error');
  } finally {
    popBusy();
  }
}

// Варианты одной спеки: структурно разные планы с оценкой каждого.
async function runSpecVariants() {
  if (!lastSpec) {
    hooks.log('Сначала спланируйте трек — варианты строятся от его спеки', 'error');
    return;
  }
  pushBusy(els.variants);
  try {
    const result = await composeVariants({
      spec: lastSpec,
      count: 4,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    renderVariants(result.variants || []);
    hooks.log(`Вариантов готово: ${result.variants?.length ?? 0}`, 'ok');
  } catch (err) {
    hooks.log(`Варианты не получились: ${err.message || err}`, 'error');
  } finally {
    popBusy();
  }
}

function renderVariants(variants) {
  if (!els.variantBox) return;
  els.variantBox.replaceChildren();
  if (!variants.length) {
    const note = document.createElement('p');
    note.className = 'compose-trace-note';
    note.textContent = 'Ни один вариант не прошёл проверку';
    els.variantBox.appendChild(note);
    return;
  }

  for (const variant of variants) {
    const card = document.createElement('div');
    card.className = 'compose-variant';

    const head = document.createElement('div');
    head.className = 'compose-variant-head';

    const rank = document.createElement('span');
    rank.className = 'compose-variant-rank';
    rank.textContent = `#${variant.rank ?? '—'}`;

    const angle = document.createElement('span');
    angle.className = 'compose-variant-angle';
    angle.textContent = [variant.angle, variant.mutation].filter(Boolean).join(' + ');

    const score = document.createElement('span');
    score.className = 'compose-variant-score';
    score.textContent = variant.score?.total !== undefined ? String(variant.score.total) : '—';

    head.append(rank, angle, score);
    card.appendChild(head);

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'btn compose-variant-load';
    load.textContent = 'Загрузить';
    load.addEventListener('click', async () => {
      lastSpec = variant.spec;
      await applyCode(variant.code);
      renderSpec({ spec: variant.spec, attempts: 0, usedFallback: false });
      renderTimeline(variant.sections || []);
      hooks.log(`Вариант ${variant.rank ?? ''} загружен`, 'ok');
    });
    card.appendChild(load);

    els.variantBox.appendChild(card);
  }
}

/* --- События пайплайна --- */

function handleEvent(event) {
  switch (event.type) {
    case 'style':
      traceRow('Стиль', event.style);
      break;
    case 'warn':
      traceRow('Внимание', event.message, 'warn');
      break;
    case 'fallback':
      traceRow('Запасной план', event.message, 'warn');
      break;
    case 'spec':
      lastSpec = event.spec || null;
      renderSpec(event);
      break;
    case 'compiled':
      traceRow('Компиляция', `${event.parts?.length ?? 0} партий, ${event.sections?.length ?? 0} секций`);
      renderTimeline(event.sections || []);
      break;
    case 'scored':
      traceRow('Оценка', `${event.score?.total ?? '—'} баллов`, 'ok');
      break;
    case 'refine-step':
      traceRow(
        `Улучшение ${event.iteration}`,
        `${event.remark?.label || ''}${event.gain ? ` (+${event.gain})` : ''}`,
        'ok',
      );
      if (event.remark?.hint) traceNote(event.remark.hint);
      break;
    case 'refined':
      traceRow('Итог улучшения', `${event.before} → ${event.after}`, event.improved ? 'ok' : 'warn');
      if (event.spec) lastSpec = event.spec;
      break;
    case 'done':
      traceRow('Готово', event.mode === 'free' ? 'свободный режим' : 'структурный режим', 'ok');
      break;
    case 'error':
      traceRow('Ошибка', event.message, 'error');
      break;
    default:
      break;
  }
}

/* --- Трейс --- */

function clearTrace() {
  if (els.trace) els.trace.replaceChildren();
}

function traceRow(label, value, kind = '') {
  if (!els.trace) return;
  const row = document.createElement('div');
  row.className = `compose-trace-row${kind ? ` compose-trace-${kind}` : ''}`;

  const name = document.createElement('span');
  name.className = 'compose-trace-label';
  name.textContent = label;

  const text = document.createElement('span');
  text.className = 'compose-trace-value';
  text.textContent = value ?? '';

  row.append(name, text);
  els.trace.appendChild(row);
}

function traceNote(text) {
  if (!els.trace || !text) return;
  const note = document.createElement('p');
  note.className = 'compose-trace-note';
  note.textContent = text;
  els.trace.appendChild(note);
}

// Спека в трейсе: форма и роли по секциям — видно, что именно запланировано.
function renderSpec(event) {
  const spec = event.spec;
  if (!spec) return;
  const parts = [];
  parts.push(`${spec.meta?.style} · ${spec.meta?.bpm} BPM · ${spec.meta?.key}`);
  const harmony = spec.harmony?.progressionId
    ? spec.harmony.progressionId
    : (spec.harmony?.degrees || []).join('-');
  parts.push(`гармония: ${harmony}`);
  traceRow('Спека', parts.join(' · '));
  if (event.usedFallback) {
    traceRow('Попыток модели', `${event.attempts ?? 0} — план собран из библиотеки`, 'warn');
  } else {
    traceRow('Попыток модели', String(event.attempts ?? 1));
  }
  if (spec.reasoning) traceNote(spec.reasoning);

  // Форма — списком секций с их ролями.
  if (!els.sections || !Array.isArray(spec.form)) return;
  els.sections.replaceChildren();
  for (const section of spec.form) {
    const item = document.createElement('div');
    item.className = 'compose-section';

    const head = document.createElement('div');
    head.className = 'compose-section-head';

    const kind = document.createElement('span');
    kind.className = 'compose-section-kind';
    kind.textContent = section.kind;

    const bars = document.createElement('span');
    bars.className = 'compose-section-bars';
    bars.textContent = `${section.bars} такт`;

    const energy = document.createElement('span');
    energy.className = 'compose-section-energy';
    energy.textContent = `энергия ${Math.round((section.energy || 0) * 100)}%`;

    head.append(kind, bars, energy);
    item.appendChild(head);

    const roles = document.createElement('div');
    roles.className = 'compose-section-roles';
    roles.textContent = Object.keys(section.roles || {}).join(' · ');
    item.appendChild(roles);

    els.sections.appendChild(item);
  }
}

/* --- Таймлайн секций --- */

// Таймлайн: цветные блоки по длине секций + кривая энергии.
// Длина блока пропорциональна числу тактов — глаз сразу видит,
// где трек держится, а где проносится.
function renderTimeline(sections) {
  if (!els.timeline || !sections.length) return;
  els.timeline.hidden = false;

  const totalBars = sections.reduce((sum, s) => sum + (s.bars || 0), 0) || 1;

  // Блоки секций.
  if (!els.blocks) return;
  els.blocks.replaceChildren();
  for (const section of sections) {
    const block = document.createElement('div');
    block.className = 'compose-tl-block';
    // Ширина = доля трека; энергия задаёт насыщенность цвета.
    const share = Math.max(0.04, (section.bars || 0) / totalBars);
    block.style.flexGrow = String(share);
    block.style.setProperty('--energy', String(section.energy ?? 0.5));
    block.title = `${section.kind} — ${section.bars} такт, энергия ${Math.round((section.energy || 0) * 100)}%`;

    const label = document.createElement('span');
    label.className = 'compose-tl-label';
    label.textContent = section.kind;

    block.appendChild(label);
    els.blocks.appendChild(block);
  }

  // Кривая энергии: SVG по шагам секций.
  if (!els.energy) return;
  els.energy.replaceChildren();

  const width = 100;
  const height = 32;
  const points = sections.map((section, index) => {
    const x = ((index + 0.5) / sections.length) * width;
    const y = height - (Number(section.energy) || 0) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  area.setAttribute('points', `0,${height} ${points.join(' ')} ${width},${height}`);
  area.classList.add('compose-energy-area');
  els.energy.appendChild(area);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points.join(' '));
  line.classList.add('compose-energy-line');
  els.energy.appendChild(line);
}

/* --- Состояние кнопок --- */

function pushBusy() {
  pending += 1;
  if (els.run) {
    els.run.disabled = true;
    els.run.textContent = '⏳ Композиция…';
  }
}

function popBusy() {
  pending = Math.max(0, pending - 1);
  if (pending > 0) return;
  if (els.run) {
    els.run.disabled = false;
    els.run.textContent = '🧩 Спланировать и собрать';
  }
}
