// Микшер по партиям: fader gain, M/S кнопки, индикатор уровня.
// Правки применяются к коду в редакторе и исполняются повторным evaluate без остановки такта.
import { evaluateCode } from './strudel-engine.js';
import { parseParts, setPartMuted, setPartSolo, unsoloAll, setPartGain, getPartGain } from './core/code-model.js';
import { staticValidate } from './core/validator.js';
import { log } from './ui.js';

const $ = (id) => document.getElementById(id);

const state = { solo: null, soloBackup: [], applyTimer: null, labels: [] };

function applyLive(code) {
  clearTimeout(state.applyTimer);
  state.applyTimer = setTimeout(async () => {
    if (!staticValidate(code).ok) return; // битую правку не исполняем — ждём ручную
    const res = await evaluateCode(code);
    if (!res.ok) log(`Ошибка после правки микшера: ${res.error}`, 'error');
  }, 250);
}

function channelEl(part) {
  const row = document.createElement('div');
  row.className = 'channel';
  row.dataset.label = part.label;

  const name = document.createElement('span');
  name.className = 'channel-name';
  name.textContent = part.label || '$';
  name.title = part.muted ? 'Приглушена (_)' : '';

  const fader = document.createElement('input');
  fader.type = 'range';
  fader.min = '0';
  fader.max = '1';
  fader.step = '0.01';
  fader.value = String(getPartGain(currentCode(), part.label) ?? 0.8);
  fader.setAttribute('aria-label', `Громкость ${part.label}`);
  fader.addEventListener('input', () => {
    applyLive(setPartGain(currentCode(), part.label, Number(fader.value)));
    vu.style.setProperty('--level', fader.value);
  });

  const vu = document.createElement('div');
  vu.className = 'vu';
  vu.style.setProperty('--level', fader.value);

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'chip';
  muteBtn.textContent = 'M';
  muteBtn.setAttribute('aria-label', `Mute ${part.label}`);
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

  row.append(name, fader, vu, muteBtn, soloBtn);
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
      el.querySelector('.chip').classList.toggle('active', part.muted);
    });
    return;
  }
  state.labels = parts.map((p) => p.label);
  box.replaceChildren(...parts.map(channelEl));
}

export function mixerPlaying(on) {
  document.documentElement.classList.toggle('playing', on);
}
