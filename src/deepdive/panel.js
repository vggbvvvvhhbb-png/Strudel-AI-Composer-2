// Панель «Разбор» — клиентская часть режима Deep Dive.
//
// Режим включается фиче-флагом (?dive=1 или сохранённый выбор) и живёт
// отдельной вкладкой рядом со студией: студия в выключенном состоянии
// выглядит и работает ровно как раньше.
//
// Модуль ничего не знает про устройство студии: код в редактор кладётся
// через существующие syncMixer/syncTransport, сообщения — через log.
import '../styles/deepdive.css';
import { analyzeTrack, refineTrack, downloadMidi, fetchJob, waitForJob, getAccessToken, setAccessToken } from './api.js';
import { createAbPlayer } from './player.js';
import { $, el, clear, num, fmtTime, downloadBlob } from './dom.js';
import {
  renderPassport,
  renderStructure,
  renderLayers,
  renderTwin,
  renderMetrics,
  renderHonesty,
  renderIterations,
} from './render.js';
import { estimateDeepDive, formatEstimate, formatRemaining } from './estimate.js';
import { syncMixer } from '../mixer.js';
import { syncTransport } from '../transport.js';
import { log } from '../ui.js';

const STAGES = ['upload', 'analyze', 'separate', 'stems', 'twin', 'render', 'compare', 'done'];
const STAGE_TITLES = {
  upload: 'Загрузка файла',
  analyze: 'Анализ звука',
  separate: 'Разделение на стемы',
  stems: 'Описание слоёв',
  twin: 'Сборка код-двойника',
  render: 'Рендер двойника',
  compare: 'Сравнение с оригиналом',
  done: 'Готово',
};
const STORAGE_KEY = 'strudel.dive';

const state = {
  file: null,
  payload: null,
  jobId: null,
  abort: null,
  busy: false,
  refineBusy: false,
  durationS: 0,
  // Отсчёт до конца самого долгого этапа: считается на клиенте, чтобы
  // «осталось ~N мин» не требовало связи с сервером.
  eta: null,
  etaTimer: 0,
};

let player = null;
let timer = 0;

export function initDeepDive() {
  const panel = $('dive-panel');
  const nav = $('dive-nav');
  if (!panel || !nav) return;

  player = createAbPlayer({ onState: syncPlayerUi });

  // Навигация появляется только когда режим включён: без флага вкладок в шапке нет,
  // поэтому студия выглядит ровно как раньше.
  nav.hidden = !unlocked();
  $('dive-tab-studio')?.addEventListener('click', () => setView('studio'));
  $('dive-tab-dive')?.addEventListener('click', () => setView('dive'));

  wireUpload();
  wireActions();
  wireCodeModal();
  updateHqVisibility();

  // ?dive=1 открывает разбор сразу; иначе — студия, но вкладка «Разбор» доступна.
  setView(flagFromUrl() ? 'dive' : 'studio');

  // Прямая ссылка /razbor/<job-id>: открываем разбор по идентификатору.
  // Токен доступа лежит во фрагменте адреса (#t=…) — сервер его не видит,
  // берём его сами и передаём дальше заголовком.
  const linkedJob = jobIdFromLocation();
  if (linkedJob) {
    setAccessToken(tokenFromLocation());
    openJobById(linkedJob);
  }
}

/* --- Прямая ссылка на задачу --- */

function jobIdFromLocation() {
  const match = /^\/razbor\/([A-Za-z0-9-]+)\/?$/.exec(window.location.pathname);
  return match ? match[1] : null;
}

/**
 * Токен доступа из фрагмента адреса.
 *
 * Фрагмент не уходит на сервер — ни в логи, ни в Referer. Это единственное
 * место, где токен может лежать в ссылке.
 */
function tokenFromLocation() {
  const hash = window.location.hash || '';
  const match = /(?:^|[#&])t=([A-Za-z0-9]+)/.exec(hash);
  return match ? match[1] : null;
}

/**
 * Открыть разбор по ссылке.
 *
 * Что обещаем и что проверяем: задача живёт на сервере, её результат лежит
 * на диске — значит вкладку можно закрыть и вернуться по ссылке. Если задача
 * ещё идёт — показываем прогресс и доводим до результата.
 */
async function openJobById(jobId) {
  setView('dive');
  hideError();
  resetProgress();
  updateProgress('reconnect', 'Открываем разбор по ссылке…', 0);
  try {
    const data = await fetchJob(jobId);
    state.jobId = jobId;
    showPermalink(jobId);
    if (data.status === 'done' && data.result) {
      applyPayload(data.result);
      return;
    }
    if (data.status === 'error') {
      showError(data.error || 'Разбор не удался');
      return;
    }
    await waitForJob(jobId, { onEvent: handleEvent });
  } catch (err) {
    showError(humanError(err));
  }
}

function showPermalink(jobId) {
  const box = $('dive-link');
  if (!box) return;
  const token = getAccessToken();
  const input = $('dive-link-url');
  const note = $('dive-link-note');
  // Без токена ссылка бесполезна: сервер отдаёт отчёт только по токену.
  // Значит, показать её нечего — прячем блок целиком.
  if (!token) {
    box.hidden = true;
    return;
  }
  const url = `${window.location.origin}/razbor/${jobId}#t=${token}`;
  box.hidden = false;
  if (input) input.value = url;
  if (note) {
    note.textContent = 'Ссылка содержит токен доступа — передавайте её целиком. Без токена разбор не откроется.';
  }
}

/* --- Фиче-флаг и переключение вкладок --- */

function flagFromUrl() {
  const value = new URLSearchParams(window.location.search).get('dive');
  return value === '1' || value === 'true';
}

// Режим «разблокирован», если его уже включали: тогда навигация остаётся в шапке,
// и панель доступна по клику без флага в адресе.
function unlocked() {
  if (flagFromUrl()) return true;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function setView(view) {
  const main = document.querySelector('main.app-grid');
  const panel = $('dive-panel');
  if (!main || !panel) return;

  const next = view === 'dive' ? 'dive' : 'studio';
  main.dataset.view = next;
  panel.hidden = next !== 'dive';

  $('dive-tab-studio')?.setAttribute('aria-selected', String(next === 'studio'));
  $('dive-tab-dive')?.setAttribute('aria-selected', String(next === 'dive'));

  // Открытие разбора «разблокирует» режим: дальше вкладка доступна всегда.
  if (next === 'dive') {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // приватный режим браузера — просто не запоминаем
    }
  }

  if (next === 'dive' && !timer) {
    timer = setInterval(updatePlayerClock, 200);
  }
}

/* --- Загрузка файла --- */

function wireUpload() {
  const drop = $('dive-drop');
  const input = $('dive-file');

  drop?.addEventListener('click', () => input?.click());
  drop?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input?.click();
    }
  });

  input?.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) takeFile(file);
    input.value = ''; // тот же файл можно выбрать повторно
  });

  drop?.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-drag');
  });
  drop?.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
  drop?.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-drag');
    const file = e.dataTransfer?.files?.[0];
    if (file) takeFile(file);
  });

  $('dive-analyze')?.addEventListener('click', runAnalyze);
  $('dive-abort')?.addEventListener('click', () => {
    state.abort?.abort();
  });
  $('dive-separate')?.addEventListener('change', () => {
    updateHqVisibility();
    updateEstimate();
  });
  $('dive-hq')?.addEventListener('change', () => {
    updateEstimate();
  });
  $('dive-link-copy')?.addEventListener('click', copyPermalink);
}

/**
 * Режим «высокое качество» — экспериментальный и ночной: он в 3–6 раз
 * дороже обычного по времени. Показываем его только когда разделение
 * включено, иначе он бессмыслен.
 */
function updateHqVisibility() {
  const wrap = $('dive-hq-wrap');
  if (!wrap) return;
  const separate = Boolean($('dive-separate')?.checked);
  wrap.hidden = !separate;
  if (!separate) {
    const hq = $('dive-hq');
    if (hq) hq.checked = false;
  }
}

/** Модель разделения: обычная или «высокое качество» (ночной режим). */
function currentModel() {
  return $('dive-hq')?.checked ? 'htdemucs_ft' : 'htdemucs';
}

/**
 * Оценка времени. Считается по длительности файла — до ответа сервера —
 * и уточняется серверной оценкой, когда приходит паспорт.
 */
function updateEstimate(serverEstimate = null) {
  const box = $('dive-estimate');
  if (!box) return;
  const separate = Boolean($('dive-separate')?.checked);
  const model = currentModel();
  const durationS = serverEstimate?.durationS ?? state.durationS;

  if (!serverEstimate && !durationS) {
    box.hidden = true;
    return;
  }

  const estimate = serverEstimate
    ? {
      minutesMin: serverEstimate.minutesMin,
      minutesMax: serverEstimate.minutesMax,
      separate: serverEstimate.separate ?? separate,
    }
    : estimateDeepDive({ durationS, separate, model });

  box.hidden = false;
  const headline = `Оценка: ${formatEstimate(estimate)}`;
  const detail = estimate.separate
    ? 'разделение на стемы на CPU — верхняя граница по худшему замеру'
    : 'без разделения на стемы';
  const modelNote = estimate.separate && model === 'htdemucs_ft'
    ? '· режим «высокое качество» (экспериментальный, ночной)'
    : '';
  box.textContent = `${headline} · ${detail}${modelNote}`;
}

function copyPermalink() {
  const input = $('dive-link-url');
  if (!input?.value) return;
  const done = () => {
    const note = $('dive-link-note');
    if (note) note.textContent = 'Ссылка скопирована.';
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(input.value).then(done).catch(() => {
      input.select();
    });
    return;
  }
  input.select();
}

/** Длительность файла — для оценки до первого ответа сервера. */
function readDuration(file) {
  return new Promise((resolve) => {
    let settled = false;
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.addEventListener('loadedmetadata', () => {
      done(Number.isFinite(audio.duration) ? audio.duration : 0);
    });
    audio.addEventListener('error', () => done(0));
    setTimeout(() => done(0), 4000);
    audio.src = url;
  });
}

function takeFile(file) {
  state.file = file;
  const text = $('dive-drop-text');
  if (text) text.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} МБ`;
  const analyze = $('dive-analyze');
  if (analyze) analyze.disabled = false;
  hideError();

  // Оригинал декодируем сразу: A/B-плеер должен быть готов к моменту результата.
  player?.setOriginalFile(file).catch(() => {
    const note = $('dive-drop-text');
    if (note) note.textContent = `${file.name} — браузер не смог декодировать этот файл`;
  });

  // Длительность — для оценки времени: её знает браузер, а сервер ещё нет.
  readDuration(file).then((duration) => {
    state.durationS = duration;
    updateEstimate();
  });
}

/* --- Разбор --- */

async function runAnalyze() {
  if (!state.file || state.busy) return;
  setBusy(true);
  hideError();
  resetProgress();
  updateEstimate();

  const controller = new AbortController();
  state.abort = controller;

  try {
    const payload = await analyzeTrack({
      file: state.file,
      separate: Boolean($('dive-separate')?.checked),
      model: currentModel(),
      onEvent: handleEvent,
      signal: controller.signal,
    });
    applyPayload(payload);
  } catch (err) {
    if (err?.name === 'AbortError') showError('Разбор прерван');
    else showError(humanError(err));
  } finally {
    setBusy(false);
    state.abort = null;
    stopEta();
  }
}

function handleEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'stage') {
    updateProgress(event.stage, event.label, event.progress, event.eta);
  } else if (event.type === 'job') {
    if (event.id) state.jobId = event.id;
    showPermalink(event.id);
  } else if (event.type === 'passport') {
    // Паспорт приходит до стемов: измерения видны сразу.
    applyPassport(event.payload, event.estimate);
  } else if (event.type === 'result' && event.payload) {
    applyPayload(event.payload);
  }
}

/**
 * Паспорт — измерения трека. Показываем их сразу, не дожидаясь стемов:
 * на CPU разделение занимает десятки минут, и ждать результата, чтобы
 * увидеть темп, — это плохой UX.
 */
function applyPassport(payload, estimate) {
  renderPassport(payload);
  if (payload?.structure) renderStructure(payload);
  if (estimate) {
    updateEstimate({ ...estimate, durationS: payload?.track?.duration_s ?? state.durationS });
  }
}

/**
 * Прогресс по этапам.
 *
 * Тексты нейтральные: описывают, что происходит, и не обещают ни времени
 * точнее измеренного, ни качества результата.
 */
function updateProgress(stage, label, progress, eta = null) {
  const wrap = $('dive-progress-wrap');
  if (wrap) wrap.hidden = false;

  const bar = $('dive-progress-bar');
  if (bar) {
    const value = Number(progress);
    bar.style.width = `${Number.isFinite(value) ? Math.min(1, Math.max(0, value)) * 100 : 0}%`;
  }

  // «В очереди» — это состояние этапа разделения, а не отдельный этап:
  // в списке подсвечиваем разделение, а текстом говорим, что идёт ожидание.
  const listStage = stage === 'queue' ? 'separate' : stage;
  const stageEl = $('dive-stage');
  if (stageEl) stageEl.textContent = label || STAGE_TITLES[listStage] || stage || 'работаем…';

  const list = $('dive-stages');
  if (list) {
    clear(list);
    const currentIndex = STAGES.indexOf(listStage);
    for (const name of STAGES) {
      const item = el('li', 'dive-stage-item');
      const index = STAGES.indexOf(name);
      if (stage === 'done' || (currentIndex >= 0 && index < currentIndex)) item.classList.add('is-done');
      else if (name === listStage) item.classList.add('is-current');
      item.append(el('span', 'dive-stage-dot', name === listStage ? '●' : '○'));
      item.append(el('span', 'dive-stage-name', STAGE_TITLES[name] ?? name));
      list.append(item);
    }
  }

  if (eta?.seconds) startEta(label, eta.seconds);
  else if (stage !== 'separate') stopEta();
}

/**
 * Обратный отсчёт до конца самого долгого этапа.
 *
 * Считается на клиенте: сервер не шлёт событий минутами подряд (Demucs молчит),
 * а «осталось ~12 мин» должно обновляться само.
 */
function startEta(label, seconds) {
  state.eta = { label, deadline: Date.now() + Number(seconds) * 1000 };
  if (state.etaTimer) return;
  state.etaTimer = setInterval(() => {
    if (!state.eta) {
      stopEta();
      return;
    }
    const left = Math.round((state.eta.deadline - Date.now()) / 1000);
    const stageEl = $('dive-stage');
    if (stageEl && left > 0) {
      stageEl.textContent = `${state.eta.label} — ${formatRemaining(left)}`;
    }
  }, 30000);
}

function stopEta() {
  state.eta = null;
  if (state.etaTimer) {
    clearInterval(state.etaTimer);
    state.etaTimer = 0;
  }
}

function resetProgress() {
  const wrap = $('dive-progress-wrap');
  if (wrap) wrap.hidden = false;
  const bar = $('dive-progress-bar');
  if (bar) bar.style.width = '0%';
  const stageEl = $('dive-stage');
  if (stageEl) stageEl.textContent = 'загружаем файл…';
  clear($('dive-stages'));
  stopEta();
}

function setBusy(busy) {
  state.busy = busy;
  const analyze = $('dive-analyze');
  if (analyze) {
    analyze.disabled = busy || !state.file;
    analyze.textContent = busy ? '⏳ Разбираем…' : '🔬 Разобрать';
  }
  const abort = $('dive-abort');
  if (abort) abort.hidden = !busy;
}

/* --- Результат --- */

function applyPayload(payload) {
  state.payload = payload;
  state.jobId = payload?.track?.id ?? payload?.job_id ?? payload?.id ?? null;
  if (state.jobId) showPermalink(state.jobId);

  // Длительность из результата — точнее, чем чтение метаданных в браузере.
  const durationS = Number(payload?.track?.duration_s);
  if (Number.isFinite(durationS) && durationS > 0) state.durationS = durationS;

  renderPassport(payload);
  renderStructure(payload);
  renderLayers(payload);
  renderTwin(payload);
  renderMetrics(payload);
  renderHonesty(payload);
  renderIterations(payload);

  loadTwinAudio(payload);

  const refine = $('dive-refine');
  if (refine) refine.disabled = !state.jobId;
  const midi = $('dive-export-midi');
  if (midi) midi.disabled = !state.jobId;
  const json = $('dive-export-json');
  if (json) json.disabled = false;
  const code = $('dive-export-code');
  if (code) code.disabled = !payload?.code_twin?.code;

  const stageEl = $('dive-stage');
  if (stageEl) stageEl.textContent = 'готово';
  const bar = $('dive-progress-bar');
  if (bar) bar.style.width = '100%';
  const estimate = $('dive-estimate');
  if (estimate) estimate.hidden = true;
  stopEta();
}

// Двойник подгружаем для A/B-сравнения. LUFS берём из метрик рендера;
// если их нет — считаем уровень двойника по LUFS оригинала и честно это подписываем.
function loadTwinAudio(payload) {
  const render = payload?.code_twin?.render || {};
  const url = render.wav_url;
  if (!url || render.status !== 'rendered') {
    player?.setTwin(null, { lufs: null }).catch(() => {});
    return;
  }

  const { lufs, estimated } = twinLufs(payload);
  const token = getAccessToken();
  player?.setTwin(url, {
    lufs,
    lufsEstimated: estimated,
    headers: token ? { 'X-Razbor-Token': token } : undefined,
  }).catch(() => {});
}

function twinLufs(payload) {
  const metrics = Array.isArray(payload?.code_twin?.metrics) ? payload.code_twin.metrics : [];
  for (let i = metrics.length - 1; i >= 0; i -= 1) {
    const value = Number(metrics[i]?.layers?.loudness?.twin_lufs_i);
    if (Number.isFinite(value)) return { lufs: value, estimated: false };
  }
  const render = payload?.code_twin?.render || {};
  const fromRender = Number(render.lufs_i ?? render.lufs_integrated);
  if (Number.isFinite(fromRender)) return { lufs: fromRender, estimated: false };

  // Луфса двойника нет — считаем его равным измерению оригинала и говорим об этом.
  const fallback = Number(payload?.measurements?.loudness?.lufs_integrated);
  if (Number.isFinite(fallback)) return { lufs: fallback, estimated: true };
  return { lufs: null, estimated: true };
}

/* --- Действия --- */

function wireActions() {
  $('dive-code-show')?.addEventListener('click', openCodeModal);
  $('dive-code-take')?.addEventListener('click', takeCodeToEditor);

  $('dive-export-json')?.addEventListener('click', exportJson);
  $('dive-export-code')?.addEventListener('click', exportCode);
  $('dive-export-midi')?.addEventListener('click', exportMidi);

  $('dive-refine')?.addEventListener('click', runRefine);

  $('dive-ab-play')?.addEventListener('click', () => {
    player?.togglePlay();
  });
  $('dive-ab-toggle')?.addEventListener('click', () => {
    const next = player?.toggleSource();
    if (next) syncPlayerUi(player.state());
  });
}

function wireCodeModal() {
  $('dive-code-modal-close')?.addEventListener('click', closeCodeModal);
  $('dive-code-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCodeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCodeModal();
  });
}

function openCodeModal() {
  const modal = $('dive-code-modal');
  const pre = $('dive-code-modal-code');
  if (!modal || !pre) return;
  pre.textContent = state.payload?.code_twin?.code || 'Код не пришёл — данных нет';
  modal.hidden = false;
  $('dive-code-modal-close')?.focus();
}

function closeCodeModal() {
  const modal = $('dive-code-modal');
  if (modal) modal.hidden = true;
}

// Кладём код в редактор и синхронизируем микшер/транспорт — как это делает
// история пресетов. Воспроизведение НЕ запускаем: только подготовка.
function takeCodeToEditor() {
  const code = state.payload?.code_twin?.code;
  if (!code) return;
  const editor = $('code-input');
  if (!editor) return;
  editor.value = code;
  syncMixer(code);
  syncTransport(code);
  log('Код-двойник загружен в редактор — нажмите ▶, чтобы послушать', 'ok');
}

function exportJson() {
  if (!state.payload) return;
  downloadBlob(new Blob([JSON.stringify(state.payload, null, 2)], { type: 'application/json' }), 'deepdive-result.json');
}

function exportCode() {
  const code = state.payload?.code_twin?.code;
  if (!code) return;
  downloadBlob(new Blob([code], { type: 'text/javascript' }), 'twin.js');
}

async function exportMidi() {
  if (!state.jobId) return;
  try {
    const blob = await downloadMidi(state.jobId);
    downloadBlob(blob, `twin-${state.jobId}.mid`);
  } catch (err) {
    showError(humanError(err));
  }
}

/* --- Улучшение --- */

async function runRefine() {
  if (!state.jobId || state.refineBusy) return;
  state.refineBusy = true;
  hideError();
  const button = $('dive-refine');
  if (button) {
    button.disabled = true;
    button.textContent = '⏳ Улучшаем…';
  }

  try {
    const payload = await refineTrack({
      job: state.jobId,
      iterations: 3,
      onEvent: (event) => {
        if (event?.type === 'stage') {
          const stageEl = $('dive-stage');
          if (stageEl) stageEl.textContent = event.label || `итерация ${event.stage ?? ''}`;
        }
      },
    });
    applyPayload(payload);
    log('Улучшение завершено — метрики обновлены', 'ok');
  } catch (err) {
    showError(humanError(err));
  } finally {
    state.refineBusy = false;
    if (button) {
      button.disabled = !state.jobId;
      button.textContent = '✨ Улучшить';
    }
  }
}

/* --- A/B-плеер --- */

function syncPlayerUi(s) {
  if (!s) return;
  const stateEl = $('dive-ab-state');
  if (stateEl) {
    stateEl.textContent = s.source === 'twin' ? 'сейчас: Двойник' : 'сейчас: Оригинал';
  }

  const toggle = $('dive-ab-toggle');
  if (toggle) {
    toggle.textContent = 'Оригинал ⇄ Двойник';
    toggle.disabled = !s.hasOriginal || !s.hasTwin;
    toggle.title = s.hasTwin
      ? 'Переключить источник (позиция сохраняется)'
      : 'Двойник недоступен: рендер не выполнен или завершился ошибкой';
  }

  const play = $('dive-ab-play');
  if (play) {
    play.textContent = s.playing ? '⏹ Стоп' : '▶ Играть';
    play.disabled = !s.hasOriginal && !s.hasTwin;
  }

  const note = $('dive-ab-note');
  if (note) note.textContent = loudnessNote(s);

  updatePlayerClock();
}

function loudnessNote(s) {
  const parts = [];
  parts.push(
    s.originalLufs !== null && s.originalLufs !== undefined
      ? `оригинал ${num(s.originalLufs, 1)} LUFS (измерено в браузере)`
      : 'громкость оригинала не измерена',
  );
  if (s.twinLufs !== null && s.twinLufs !== undefined) {
    parts.push(
      `двойник ${num(s.twinLufs, 1)} LUFS${s.twinLufsEstimated ? ' (оценка по измерениям оригинала)' : ' (из метрик рендера)'}`,
    );
  } else {
    parts.push('громкость двойника неизвестна — уровни не выровнены');
  }
  if (s.originalLufs !== null && s.originalLufs !== undefined && s.twinLufs !== null && s.twinLufs !== undefined) {
    parts.push(`выровнено по LUFS: оригинал ×${num(s.originalGain, 2)}, двойник ×${num(s.twinGain, 2)}`);
  }
  return parts.join(' · ');
}

function updatePlayerClock() {
  const clock = $('dive-ab-time');
  if (!clock || !player) return;
  const s = player.state();
  clock.textContent = s.duration ? `${fmtTime(s.position)} / ${fmtTime(s.duration)}` : '—';
}

/* --- Ошибки --- */

function showError(message) {
  const box = $('dive-error');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

function hideError() {
  const box = $('dive-error');
  if (!box) return;
  box.hidden = true;
  box.textContent = '';
}

// Человекочитаемая ошибка: без стектрейсов и кодов статусов в тексте.
// Текст сервера (он уже написан для человека) сохраняем; подсказку даём только
// там, где сервер ответил пустым кодом статуса.
function humanError(err) {
  const raw = String(err?.message || err || 'Неизвестная ошибка').split('\n')[0].trim();
  if (/кодом 413/i.test(raw)) return 'Файл слишком большой — сервер принимает до 100 МБ';
  if (/кодом 400/i.test(raw)) return 'Сервер не принял файл: это не аудио или формат не поддерживается';
  if (/кодом 404/i.test(raw)) return 'Сервер не нашёл нужный эндпойнт — режим «Разбор» ещё не развёрнут';
  if (/Failed to fetch|NetworkError|load failed|fetch failed/i.test(raw)) {
    return 'Сервер недоступен — проверьте, что он запущен';
  }
  if (/NotSupportedError|EncodingError/i.test(raw)) {
    return 'Браузер не смог декодировать этот файл';
  }
  if (/Задача не найдена/i.test(raw)) {
    return 'Задача не найдена: разбор не состоялся или результат удалён по TTL';
  }
  if (/Мьютекс занят/i.test(raw)) {
    return 'Другая тяжёлая операция заняла мьютекс — повторите разбор позже';
  }
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}
