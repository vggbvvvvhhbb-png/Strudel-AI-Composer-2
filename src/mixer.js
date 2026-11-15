// Микшер по партиям: fader gain, M/S кнопки, индикатор уровня.
// Правки применяются к коду в редакторе и исполняются повторным evaluate без остановки такта.
import { getEngine } from './engine-loader.js';
import { parseParts, setPartMuted, setPartSolo, unsoloAll, setPartGain, getPartGain } from './core/code-model.js';
import { staticValidate } from './core/validator.js';
import { accentOf } from './accents.js';
import { log } from './ui.js';

const $ = (id) => document.getElementById(id);

const state = { solo: null, soloBackup: [], applyTimer: null, labels: [] };

function applyLive(code) {
  clearTimeout(state.applyTimer);
  state.applyTimer = setTimeout(async () => {
    if (!staticValidate(code).ok) return; // битую правку не исполняем — ждём ручную
    const { evaluateCode } = await getEngine();
    const res = await evaluateCode(code);
    if (!res.ok) log(`Ошибка после правки микшера: ${res.error}`, 'error');
  }, 250);
}

function channelEl(part, index) {
  const row = document.createElement('div');
  row.className = `channel accent-${accentOf(index)}`;
  row.dataset.label = part.label;

  const name = document.createElement('span');
  name.className = 'channel-name';
  const dot = document.createElement('span');
  dot.className = 'channel-dot';
  const label = document.createElement('span');
  label.className = 'channel-label';
  label.textContent = part.label || '$';
  label.title = part.muted ? 'Приглушена (_)' : '';
  name.append(dot, label);

  const fader = document.createElement('input');
  fader.type = 'range';
  fader.min = '0';
  fader.max = '1';
  fader.step = '0.01';
  fader.value = String(getPartGain(currentCode(), part.label) ?? 0.8);
  fader.setAttribute('aria-label', `Громкость ${part.label}`);

  // Числовое значение громкости — рядом с именем партии.
  const readout = document.createElement('span');
  readout.className = 'channel-gain';
  readout.textContent = Number(fader.value).toFixed(2);

  fader.addEventListener('input', () => {
    readout.textContent = Number(fader.value).toFixed(2);
    // Gain тоже попадает в код редактора — иначе пресет сохранит старое значение.
    const next = setPartGain(currentCode(), part.label, Number(fader.value));
    setEditorCode(next);
    applyLive(next);
  });

  // Индикатор уровня: значение приходит из живых метров (см. meters.js).
  const vu = document.createElement('div');
  vu.className = 'vu';
  vu.style.setProperty('--level', '0');

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'chip';
  muteBtn.textContent = 'M';
  muteBtn.setAttribute('aria-label', `Mute ${part.label}`);
  muteBtn.setAttribute('aria-pressed', String(Boolean(part.muted)));
  muteBtn.addEventListener('click', () => {
    const nowMuted = !part.muted;
    if (state.solo && !nowMuted) return; // при активном solo ручная разглушка запрещена
    const next = setPartMuted(currentCode(), part.label, nowMuted);
    setEditorCode(next);
    applyLive(next);
  });

  const soloBtn = document.createElement('button');
  soloBtn.type = 'button';
  soloBtn.className = 'chip';
  soloBtn.textContent = 'S';
  soloBtn.setAttribute('aria-pressed', String(state.solo === part.label));
  soloBtn.setAttribute('aria-label', `Solo ${part.label}`);
  soloBtn.addEventListener('click', () => {
    let next;
    if (state.solo === part.label) {
      state.solo = null;
      next = unsoloAll(currentCode(), state.soloBackup);
      state.soloBackup = [];
    } else {
      const { code, previous } = setPartSolo(currentCode(), part.label);
      state.solo = part.label;
      state.soloBackup = previous;
      next = code;
    }
    setEditorCode(next);
    applyLive(next);
  });

  row.append(name, muteBtn, soloBtn, fader, vu);
  return row;
}

// Источник кода и способы его обновления подключает ui.js при инициализации.
const hooks = { getCode: () => '', setCode: () => {} };
const currentCode = () => hooks.getCode();
const setEditorCode = (code) => hooks.setCode(code);

export function initMixer({ getCode, setCode }) {
  hooks.getCode = getCode;
  hooks.setCode = setCode;
}

// Перестроить каналы под текущий код (вызывается из ui.js при правке редактора).
export function syncMixer(code) {
  const box = $('mixer');
  if (!box) return;
  const parts = parseParts(code);
  const labels = parts.map((p) => p.label).join('|');
  if (labels === state.labels.join('|')) {
    // те же партии — только обновить состояния кнопок (после ручных правок кода)
    box.querySelectorAll('.channel').forEach((el) => {
      const part = parts.find((p) => p.label === el.dataset.label);
      if (!part) return;
      el.classList.toggle('muted', part.muted);
      const muteBtn = el.querySelector('.chip[aria-label^="Mute"]');
      if (muteBtn) muteBtn.setAttribute('aria-pressed', String(Boolean(part.muted)));
      const soloBtn = el.querySelector('.chip[aria-label^="Solo"]');
      if (soloBtn) soloBtn.setAttribute('aria-pressed', String(state.solo === part.label));
    });
    return;
  }
  state.labels = parts.map((p) => p.label);
  box.replaceChildren(...parts.map((part, i) => channelEl(part, i)));
}

// Индикатор «играет» на <html> — им пользуется подсветка партий и анимации.
export function mixerPlaying(on) {
  document.documentElement.classList.toggle('playing', on);
}
