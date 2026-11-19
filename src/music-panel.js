// Панель «Музыкальный разбор»: оценка трека, критерии, замечания,
// улучшение по разбору и варианты A/B.
//
// Модуль ничего не знает про устройство приложения: код берётся через getCode,
// результат возвращается через setCode/applyCode, сообщения — через log.
// Все данные с сервера вставляются только через textContent.
import { analyzeMusic, refineMusic, musicVariants, fetchMusicStyles } from './api/client.js';

const $ = (id) => document.getElementById(id);

const hooks = {
  getCode: () => '',
  setCode: null,
  applyCode: null,
  log: () => {},
  // Рендер трека в браузере: возвращает { report } — отчёт о звучании.
  // Без него разбор идёт только по коду.
  renderAudio: null,
};

let els = null; // DOM-узлы панели (null — панели на странице нет)
let styleId = 'generic';
let pending = 0; // счётчик активных запросов: кнопки гасятся, пока он не нулевой

const LABELS = {
  analyze: '🎼 Разобрать',
  refine: '✨ Улучшить по разбору',
  variants: '🎲 Варианты A/B',
};

/* --- Инициализация --- */

export function initMusicPanel({ getCode, setCode, applyCode, log, renderAudio } = {}) {
  if (getCode) hooks.getCode = getCode;
  if (setCode) hooks.setCode = setCode;
  if (applyCode) hooks.applyCode = applyCode;
  if (log) hooks.log = log;
  if (renderAudio) hooks.renderAudio = renderAudio;

  els = {
    style: $('music-style'),
    analyze: $('btn-analyze'),
    refine: $('btn-refine'),
    variants: $('btn-variants'),
    score: $('music-score'),
    criteria: $('music-criteria'),
    issues: $('music-issues'),
    variantBox: $('music-variants'),
  };
  if (!els.score) {
    // Панели на этой странице нет — дальше работать не с чем.
    els = null;
    return;
  }

  // Внутри #music-score живут два блока: оценка и сводка улучшения.
  els.scoreMain = document.createElement('div');
  els.scoreMain.className = 'music-score-main';
  els.refineBox = document.createElement('div');
  els.refineBox.className = 'music-refine';
  els.audioBox = document.createElement('div');
  els.audioBox.className = 'music-audio';
  els.score.append(els.scoreMain, els.refineBox, els.audioBox);

  els.analyze?.addEventListener('click', () => runAnalyze());
  els.refine?.addEventListener('click', () => runRefine());
  els.variants?.addEventListener('click', () => runVariants());
  els.style?.addEventListener('change', () => {
    styleId = els.style.value || 'generic';
    if (currentCode().trim()) runAnalyze(); // смена стиля — новый разбор
  });

  loadStyles();
}

async function loadStyles() {
  try {
    const styles = await fetchMusicStyles();
    if (!els?.style) return;
    els.style.replaceChildren();
    for (const style of styles) {
      const option = document.createElement('option');
      option.value = style.id;
      option.textContent = style.nameRu || style.name || style.id;
      els.style.appendChild(option);
    }
    if (styles.length && !styles.some((s) => s.id === styleId)) {
      const generic = styles.find((s) => s.id === 'generic');
      styleId = generic ? generic.id : styles[0].id;
    }
    els.style.value = styleId;
  } catch (err) {
    hooks.log(`Не удалось загрузить список стилей: ${err.message || err}`, 'error');
  }
}

/* --- Вспомогательное --- */

function currentCode() {
  return String(hooks.getCode?.() ?? '');
}

function pushBusy(button, label) {
  pending += 1;
  for (const el of [els.analyze, els.refine, els.variants]) {
    if (el) el.disabled = true;
  }
  if (button) button.textContent = label;
}

function popBusy() {
  pending = Math.max(0, pending - 1);
  if (pending > 0) return;
  for (const el of [els.analyze, els.refine, els.variants]) {
    if (el) el.disabled = false;
  }
  if (els.analyze) els.analyze.textContent = LABELS.analyze;
  if (els.refine) els.refine.textContent = LABELS.refine;
  if (els.variants) els.variants.textContent = LABELS.variants;
}

function note(text) {
  const p = document.createElement('p');
  p.className = 'music-note';
  p.textContent = text;
  return p;
}

function button(text, className, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

// Значение критерия в человекочитаемом виде.
function formatValue(criterion) {
  const value = criterion.value;
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (criterion.unit === 'доля') return `${Math.round(value * 100)}%`;
  return `${value} ${criterion.unit || ''}`.trim();
}

/* --- Разбор --- */

export function analyzeCurrent() {
  if (!els) return Promise.resolve(null);
  return runAnalyze();
}

async function runAnalyze() {
  const code = currentCode();
  if (!code.trim()) {
    hooks.log('Нет кода для разбора — сгенерируйте трек', 'error');
    return null;
  }
  pushBusy(els.analyze, '⏳ Разбор…');
  try {
    // Сначала звук: рендер в браузере даёт отчёт, без него разбор идёт
    // только по коду, а с ним — по фактическому звучанию.
    const audioReport = await renderAudioReport(code);
    const payload = await analyzeMusic({ code, style: styleId, audioReport });
    renderAnalysis(payload);
    const audio = payload.audio;
    hooks.log(
      audio
        ? `Разбор готов: ${payload.score.total}/100 (${payload.score.grade}), ` +
            `звук: ${audio.report?.lufsI ?? '—'} LUFS, ${audio.report?.truePeakDbtp ?? '—'} dBTP`
        : `Разбор готов: ${payload.score.total}/100 (${payload.score.grade}), профиль «${payload.profile?.nameRu || '—'}»`,
      'ok',
    );
    return payload;
  } catch (err) {
    hooks.log(`Разбор не удался: ${err.message || err}`, 'error');
    return null;
  } finally {
    popBusy();
  }
}

/**
 * Рендерит трек и отдаёт отчёт о звучании.
 *
 * Рендер не проходит не весь разбор: если звук построить не удалось, разбор
 * всё равно полезен — по коду. Поэтому ошибка рендера не роняет запрос.
 *
 * @param {string} code
 * @returns {Promise<object|null>} MetricsReport
 */
async function renderAudioReport(code) {
  if (!hooks.renderAudio) return null;
  try {
    const rendered = await hooks.renderAudio(code);
    return rendered?.report ?? null;
  } catch (err) {
    hooks.log(`Рендер для разбора не удался: ${err.message || err}`, 'error');
    return null;
  }
}

function renderAnalysis(payload) {
  const score = payload?.score || {};
  const profile = payload?.profile || {};

  els.scoreMain.replaceChildren();
  const box = document.createElement('div');
  box.className = 'music-score';

  const total = document.createElement('div');
  total.className = 'music-score-total';
  total.textContent = String(score.total ?? '—');

  const grade = document.createElement('div');
  grade.className = 'music-grade';
  grade.textContent = score.grade || '';

  box.append(total, grade);

  const profileLine = document.createElement('div');
  profileLine.className = 'music-profile';
  profileLine.textContent = `Стиль-референс: ${profile.nameRu || '—'}`;
  els.scoreMain.append(box, profileLine);

  renderCriteria(score.criteria || []);
  renderIssues(score.issues || []);
  renderAudio(payload?.audio || null, payload?.audioRejected || null);
}

/**
 * Блок «звук»: числа рендера и замечания по нему.
 *
 * Числа — из отчёта о рендере (тот же DSP, что звучит), замечания — из
 * Audio QA: они машиночитаемые, поэтому подсказка под ними есть всегда.
 */
function renderAudio(audio, rejected) {
  els.audioBox.replaceChildren();

  if (rejected) {
    els.audioBox.appendChild(note(`Отчёт о звучании не принят: ${rejected}`));
    return;
  }
  if (!audio) {
    els.audioBox.appendChild(note('Звук не рендерился — разбор только по коду'));
    return;
  }

  const box = document.createElement('div');
  box.className = 'music-audio-box';

  const head = document.createElement('div');
  head.className = 'music-audio-head';
  head.textContent = `Звук: ${audio.total ?? '—'}/100 (аудио-блок, 20% скора)`;
  box.append(head);

  const report = audio.report || {};
  const lines = [
    `Громкость: ${fmt(report.lufsI)} LUFS-I (коридор −16…−12)`,
    `True peak: ${fmt(report.truePeakDbtp)} dBTP (потолок −1.0)`,
    `Пик: ${fmt(report.peakDbfs)} dBFS · клиппинг: ${report.clipCount ?? '—'}`,
    `Сжатость: ${fmt(report.crestDb)} дБ`,
    report.repeatability
      ? `Повторяемость: Δ ${fmt(report.repeatability.lufsDeltaDb)} LU · ${
          report.repeatability.passed ? 'проходит ✓' : 'НЕ проходит ✗'
        }`
      : 'Повторяемость: не измерена',
  ];
  for (const text of lines) {
    const line = document.createElement('div');
    line.className = 'music-audio-line';
    line.textContent = text;
    box.append(line);
  }

  const findings = audio.findings || [];
  if (findings.length) {
    const list = document.createElement('div');
    list.className = 'music-audio-findings';
    for (const finding of findings) {
      const item = document.createElement('div');
      item.className = `music-audio-finding music-audio-${finding.severity === 'error' ? 'error' : 'warn'}`;
      const label = document.createElement('span');
      label.className = 'music-audio-finding-label';
      label.textContent = finding.label || finding.code || '';
      const hint = document.createElement('span');
      hint.className = 'music-audio-finding-hint';
      hint.textContent = finding.hint || '';
      item.append(label, hint);
      list.append(item);
    }
    box.append(list);
  }

  els.audioBox.append(box);
}

/** Число для показа: с двумя знаками, тире вместо NaN. */
function fmt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';
}

function renderCriteria(criteria) {
  els.criteria.replaceChildren();
  if (!criteria.length) {
    els.criteria.appendChild(note('Критерии не пришли'));
    return;
  }
  for (const criterion of criteria) {
    const status = criterion.status || 'na';
    const row = document.createElement('div');
    row.className = `music-criterion music-status-${status}`;

    const head = document.createElement('div');
    head.className = 'music-criterion-head';
    const label = document.createElement('span');
    label.className = 'music-criterion-label';
    label.textContent = criterion.label || criterion.id || '';
    const points = document.createElement('span');
    points.className = 'music-criterion-points';
    points.textContent = `${criterion.points ?? 0} / ${criterion.weight ?? 0}`;
    head.append(label, points);

    const meta = document.createElement('div');
    meta.className = 'music-criterion-meta';
    meta.textContent = `${formatValue(criterion)} · цель: ${criterion.targetText || criterion.target || '—'}`;

    const bar = document.createElement('div');
    bar.className = 'music-bar';
    const fill = document.createElement('div');
    fill.className = 'music-bar-fill';
    const percent = Math.max(0, Math.min(1, Number(criterion.score) || 0));
    fill.style.width = `${Math.round(percent * 100)}%`;
    bar.appendChild(fill);

    row.append(head, meta, bar);
    els.criteria.appendChild(row);
  }
}

function renderIssues(issues) {
  els.issues.replaceChildren();
  if (!issues.length) {
    els.issues.appendChild(note('По коду серьёзных замечаний нет; замечания к звуку — выше.'));
    return;
  }
  for (const issue of issues) {
    const near = (Number(issue.score) || 0) >= 0.55;
    const item = document.createElement('div');
    item.className = `music-issue ${near ? 'music-issue-near' : 'music-issue-bad'}`;

    const head = document.createElement('div');
    head.className = 'music-issue-head';
    const label = document.createElement('span');
    label.className = 'music-issue-label';
    label.textContent = issue.label || issue.id || '';
    const gain = document.createElement('span');
    gain.className = 'music-issue-gain';
    gain.textContent = `+${issue.gain ?? 0} балла`;
    head.append(label, gain);

    const hint = document.createElement('p');
    hint.className = 'music-issue-hint';
    hint.textContent = issue.hint || '';

    item.append(head, hint);
    els.issues.appendChild(item);
  }
}

/* --- Улучшение по разбору --- */

async function runRefine() {
  const code = currentCode();
  if (!code.trim()) {
    hooks.log('Нет кода для улучшения — сгенерируйте трек', 'error');
    return;
  }
  pushBusy(els.refine, '⏳ Улучшение…');
  try {
    const result = await refineMusic({ code, style: styleId, iterations: 2 });
    renderRefine(result);
    const before = result.before?.score?.total ?? '—';
    const after = result.after?.score?.total ?? '—';
    if (result.improved) {
      hooks.log(`Улучшено: ${before} → ${after}`, 'ok');
      await applyCode(result.code);
      await runAnalyze(); // перерисовываем разбор уже улучшенного кода
    } else {
      hooks.log(`Улучшение не дало прироста (${before} → ${after})`, 'error');
    }
  } catch (err) {
    hooks.log(`Улучшение не удалось: ${err.message || err}`, 'error');
  } finally {
    popBusy();
  }
}

function renderRefine(result) {
  els.refineBox.replaceChildren();
  const box = document.createElement('div');
  box.className = 'music-refine-box';

  const head = document.createElement('div');
  head.className = 'music-refine-head';
  head.textContent = `Было ${result.before?.score?.total ?? '—'} → стало ${result.after?.score?.total ?? '—'}`;
  box.appendChild(head);

  const steps = result.steps || [];
  if (!steps.length) {
    box.appendChild(note('Шагов улучшения не было'));
  }
  for (const step of steps) {
    const row = document.createElement('div');
    row.className = `music-step ${step.applied ? 'music-step-applied' : 'music-step-skipped'}`;

    const title = document.createElement('div');
    title.className = 'music-step-title';
    const sign = step.applied ? '✓' : '·';
    const gain = step.gain ? ` (+${step.gain})` : '';
    title.textContent = `Шаг ${step.iteration}: ${sign} ${step.score ?? '—'}${gain}`;

    row.appendChild(title);
    if (step.reason) {
      const reason = document.createElement('div');
      reason.className = 'music-step-reason';
      reason.textContent = step.reason;
      row.appendChild(reason);
    }
    for (const fixed of step.fixed || []) {
      const fix = document.createElement('div');
      fix.className = 'music-step-fixed';
      fix.textContent = `исправлено: ${fixed}`;
      row.appendChild(fix);
    }
    box.appendChild(row);
  }

  els.refineBox.appendChild(box);
}

// Прогнать код: сначала пробуем applyCode (валидация + исполнение), иначе просто пишем код.
async function applyCode(code) {
  if (hooks.applyCode) {
    await hooks.applyCode(code);
    return;
  }
  hooks.setCode?.(code);
}

/* --- Варианты A/B --- */

async function runVariants() {
  const prompt = String($('prompt-input')?.value ?? '').trim();
  if (!prompt) {
    hooks.log('Введите команду — по ней строятся варианты', 'error');
    return;
  }
  const existing = currentCode().trim();
  pushBusy(els.variants, '⏳ Варианты…');
  try {
    const result = await musicVariants({
      prompt,
      count: 3,
      style: styleId,
      currentCode: existing || undefined,
    });
    renderVariants(result);
    hooks.log(`Вариантов готово: ${result.variants?.length ?? 0}`, 'ok');
  } catch (err) {
    hooks.log(`Варианты не получились: ${err.message || err}`, 'error');
  } finally {
    popBusy();
  }
}

function renderVariants(result) {
  els.variantBox.replaceChildren();
  const variants = result?.variants || [];

  if (result?.original) {
    els.variantBox.appendChild(
      variantCard({
        rank: null,
        title: 'Исходный',
        score: result.original.score,
        angle: 'текущий код без изменений',
        code: null,
        onLoad: null,
      }),
    );
  }

  if (!variants.length) {
    els.variantBox.appendChild(note('Ни один вариант не прошёл проверку'));
    return;
  }

  for (const variant of variants) {
    els.variantBox.appendChild(
      variantCard({
        rank: variant.rank,
        title: `Вариант ${variant.rank ?? ''}`.trim(),
        score: variant.score,
        angle: variant.angle || '',
        code: variant.code || '',
        onLoad: async () => {
          await applyCode(variant.code);
          hooks.log(`Вариант ${variant.rank ?? ''} загружен`, 'ok');
          await runAnalyze();
        },
      }),
    );
  }
}

function variantCard({ rank, title, score, angle, code, onLoad }) {
  const card = document.createElement('div');
  card.className = `music-variant${rank === null ? ' music-variant-original' : ''}`;

  const head = document.createElement('div');
  head.className = 'music-variant-head';

  const name = document.createElement('span');
  name.className = 'music-variant-title';
  name.textContent = title;

  const total = document.createElement('span');
  total.className = 'music-variant-total';
  total.textContent = score?.total !== undefined ? String(score.total) : '—';

  const grade = document.createElement('span');
  grade.className = 'music-variant-grade';
  grade.textContent = score?.grade || '';

  head.append(name, total, grade);
  card.appendChild(head);

  if (angle) {
    const text = document.createElement('p');
    text.className = 'music-variant-angle';
    text.textContent = angle;
    card.appendChild(text);
  }

  if (onLoad && code) {
    card.appendChild(button('Загрузить', 'btn music-variant-load', onLoad));
  }
  return card;
}
