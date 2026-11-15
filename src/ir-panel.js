// Панель IR: описание → план → код, правки плана и поиск вариантов.
//
// Отличие от панели «Музыкальный разбор»: разбор смотрит на КОД и ЗВУК,
// а эта панель работает с ПЛАНОМ (Composition IR). Поэтому «сделай
// мрачнее» здесь — не перегенерация текста, а измеримая правка плана:
// показывается дельта (скор, темп, лад, число ошибок линтера).
//
// Панель ничего не знает про устройство приложения: код применяется через
// applyCode, сообщения — через log.

import { irPlan, irTransform, irSearch, irCritique } from './api/client.js';
import { setCurrentIr } from './core/ir-store.js';

const $ = (id) => document.getElementById(id);

const hooks = {
  applyCode: null,
  log: () => {},
};

let els = null;
let currentIr = null;
let pending = 0;

/** Кнопки правок: имя → подпись и аргументы. */
const TRANSFORMS = [
  { name: 'darker', label: '🌑 Мрачнее' },
  { name: 'brighter', label: '🌕 Светлее' },
  { name: 'energize', label: '⚡ Энергичнее' },
  { name: 'calm', label: '🌊 Спокойнее' },
];

export function initIrPanel({ applyCode, log } = {}) {
  if (applyCode) hooks.applyCode = applyCode;
  if (log) hooks.log = log;

  els = {
    root: $('ir-panel'),
    plan: $('btn-ir-plan'),
    search: $('btn-ir-search'),
    critique: $('btn-ir-critique'),
    transforms: $('ir-transforms'),
    report: $('ir-report'),
  };
  if (!els.root) {
    els = null;
    return;
  }

  els.plan?.addEventListener('click', () => runPlan());
  els.search?.addEventListener('click', () => runSearch());
  els.critique?.addEventListener('click', () => runCritique());

  els.transforms?.replaceChildren();
  for (const transform of TRANSFORMS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost';
    btn.textContent = transform.label;
    btn.addEventListener('click', () => runTransform(transform.name));
    els.transforms.appendChild(btn);
  }
}

/* --- Вспомогательное --- */

function promptText() {
  return String($('prompt-input')?.value ?? '').trim();
}

function note(text, className = 'music-note') {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function busy(on) {
  pending = Math.max(0, pending + (on ? 1 : -1));
  const disabled = pending > 0;
  for (const el of [els.plan, els.search, els.critique]) {
    if (el) el.disabled = disabled;
  }
  if (els.transforms) {
    for (const child of els.transforms.children) child.disabled = disabled;
  }
}

async function applyCode(code) {
  if (hooks.applyCode) {
    await hooks.applyCode(code);
    return;
  }
}

/* --- План --- */

async function runPlan() {
  const prompt = promptText();
  if (!prompt) {
    hooks.log('Введите описание — из него соберётся план', 'error');
    return;
  }
  busy(true);
  try {
    const result = await irPlan({ prompt });
    if (!result?.ok) {
      hooks.log(`План не собрался: ${result?.error || 'неизвестная ошибка'}`, 'error');
      return;
    }
    currentIr = result.ir;
    setCurrentIr(currentIr);
    renderReport(result);
    await applyCode(result.code);
    hooks.log(
      `План собран: ${result.report.score.total}/100, ${result.report.sections.length} секций, ` +
        `${result.report.bars} тактов`,
      'ok',
    );
  } catch (err) {
    hooks.log(`План не собрался: ${err.message || err}`, 'error');
  } finally {
    busy(false);
  }
}

/* --- Правки --- */

async function runTransform(name) {
  if (!currentIr) {
    hooks.log('Сначала соберите план', 'error');
    return;
  }
  busy(true);
  try {
    const result = await irTransform({ ir: currentIr, transform: name, amount: 0.6 });
    if (!result?.ok) {
      hooks.log(`Правка не удалась: ${result?.error || 'неизвестная ошибка'}`, 'error');
      return;
    }
    currentIr = result.ir;
    setCurrentIr(currentIr);
    renderReport(result);
    await applyCode(result.code);
    const delta = result.delta || {};
    hooks.log(
      `«${name}»: скор ${delta.scoreBefore} → ${delta.scoreAfter}, ` +
        `лад ${delta.modeBefore} → ${delta.modeAfter}`,
      'ok',
    );
  } catch (err) {
    hooks.log(`Правка не удалась: ${err.message || err}`, 'error');
  } finally {
    busy(false);
  }
}

/* --- Поиск --- */

async function runSearch() {
  const prompt = promptText();
  if (!prompt && !currentIr) {
    hooks.log('Введите описание — из него ищутся варианты', 'error');
    return;
  }
  busy(true);
  try {
    const result = await irSearch({ prompt, ir: currentIr, n: 16, topK: 3 });
    if (!result?.ok) {
      hooks.log(`Поиск не удался: ${result?.error || 'неизвестная ошибка'}`, 'error');
      return;
    }
    renderSearch(result);
    hooks.log(
      `Проверено ${result.evaluated} вариантов за ${result.elapsedMs} мс, ` +
        `лучший ${result.candidates?.[0]?.score ?? '—'}/100`,
      'ok',
    );
  } catch (err) {
    hooks.log(`Поиск не удался: ${err.message || err}`, 'error');
  } finally {
    busy(false);
  }
}

/* --- Критик --- */

async function runCritique() {
  if (!currentIr) {
    hooks.log('Сначала соберите план', 'error');
    return;
  }
  busy(true);
  try {
    const result = await irCritique({ ir: currentIr });
    if (!result?.ok) {
      hooks.log(`Критик не справился: ${result?.error || 'неизвестная ошибка'}`, 'error');
      return;
    }
    currentIr = result.ir;
    setCurrentIr(currentIr);
    renderReport(result);
    await applyCode(result.code);
    const applied = (result.steps || []).filter((step) => step.accepted).length;
    hooks.log(
      `Критик: ${result.startScore} → ${result.report.score.total} (${applied} правок принято)`,
      'ok',
    );
  } catch (err) {
    hooks.log(`Критик не справился: ${err.message || err}`, 'error');
  } finally {
    busy(false);
  }
}

/* --- Отрисовка --- */

function renderReport(result) {
  if (!els.report) return;
  els.report.replaceChildren();
  const report = result.report || {};
  const score = report.score || {};

  const head = document.createElement('div');
  head.className = 'ir-score';
  head.textContent = `${score.total ?? '—'}/100 · ${report.bars ?? '—'} тактов · ` +
    `${report.bpm ?? '—'} BPM · ${report.key || '—'}`;
  els.report.appendChild(head);

  const components = document.createElement('div');
  components.className = 'ir-components';
  for (const component of score.components || []) {
    const item = document.createElement('span');
    item.className = `ir-component ir-component-${component.status || 'na'}`;
    item.textContent = `${component.label}: ${component.value ?? '—'}`;
    components.appendChild(item);
  }
  els.report.appendChild(components);

  const findings = report.lint || [];
  if (findings.length) {
    const list = document.createElement('div');
    list.className = 'ir-findings';
    for (const finding of findings) {
      const item = document.createElement('div');
      item.className = `ir-finding ir-finding-${finding.severity || 'info'}`;
      item.textContent = finding.message || finding.code;
      list.appendChild(item);
    }
    els.report.appendChild(list);
  } else {
    els.report.appendChild(note('Замечаний линтера нет ✓'));
  }

  if (result.warnings?.length) {
    for (const warning of result.warnings) {
      els.report.appendChild(note(`Компилятор: ${warning}`, 'ir-warning'));
    }
  }
}

function renderSearch(result) {
  if (!els.report) return;
  const box = document.createElement('div');
  box.className = 'ir-search';
  box.appendChild(note(`Базовый скор: ${result.base?.score ?? '—'}`));
  for (const candidate of result.candidates || []) {
    const row = document.createElement('div');
    row.className = 'ir-candidate';

    const title = document.createElement('span');
    title.className = 'ir-candidate-title';
    title.textContent = `${candidate.score ?? '—'} · ${candidate.detail || candidate.mutation}`;

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'btn ghost';
    load.textContent = 'Загрузить';
    load.addEventListener('click', async () => {
      busy(true);
      try {
        currentIr = candidate.ir;
      setCurrentIr(currentIr);
        await applyCode(candidate.code);
        if (candidate.report) renderReport({ report: candidate.report });
        hooks.log(`Вариант загружен: ${candidate.detail}`, 'ok');
      } finally {
        busy(false);
      }
    });

    row.append(title, load);
    box.appendChild(row);
  }
  els.report.appendChild(box);
}
