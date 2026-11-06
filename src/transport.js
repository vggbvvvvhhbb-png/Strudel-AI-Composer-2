// Транспорт: play/stop, слайдер BPM 40–220, выбор тональности, пульсация play в такт.
import { getBpm, setCpm, getKey, setKey } from './core/code-model.js';
import { startRecording, stopRecording, isRecording } from './core/recorder.js';
import { staticValidate } from './core/validator.js';
import { evaluateCode, stop } from './strudel-engine.js';
import { log } from './ui.js';

const $ = (id) => document.getElementById(id);

const NOTES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const SCALES = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'harmonic minor'];

const hooks = { getCode: () => '', setCode: () => {}, onPlayToggle: null };
let applyTimer = null;
let playing = false;

function parseKeyPair(keyStr) {
  const [note = 'c', scale = 'major'] = String(keyStr || 'c:major').split(':');
  return { note: note.toLowerCase(), scale: scale.toLowerCase() };
}

function fillKeySelect(keyStr) {
  const sel = $('key-select');
  sel.replaceChildren();
  const { note, scale } = parseKeyPair(keyStr);
  for (const n of NOTES) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n.toUpperCase();
    opt.selected = n === note;
    sel.appendChild(opt);
  }
  const scaleSel = $('scale-select');
  scaleSel.replaceChildren();
  for (const s of SCALES) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    opt.selected = s === scale;
    scaleSel.appendChild(opt);
  }
}

// Применить BPM/key к коду и переиграть без остановки такта (повторный evaluate).
function applyTransport() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(async () => {
    let code = hooks.getCode();
    if (!code.trim()) return;
    const bpm = Number($('bpm-slider').value);
    const key = `${$('key-select').value}:${$('scale-select').value}`;
    code = setCpm(setKey(code, key), bpm);
    if (!staticValidate(code).ok) return;
    hooks.setCode(code);
    if (playing) {
      const res = await evaluateCode(code);
      if (!res.ok) log(`Ошибка после смены BPM/key: ${res.error}`, 'error');
    }
  }, 300);
}

export function initTransport({ getCode, setCode, onPlayToggle }) {
  hooks.getCode = getCode;
  hooks.setCode = setCode;
  hooks.onPlayToggle = onPlayToggle;

  $('bpm-slider').addEventListener('input', () => {
    $('bpm-value').textContent = $('bpm-slider').value;
    document.documentElement.style.setProperty('--beat-dur', `${60 / Number($('bpm-slider').value)}s`);
    applyTransport();
  });
  $('key-select').addEventListener('change', applyTransport);
  $('scale-select').addEventListener('change', applyTransport);

  // Запись WAV: длительность в тактах или ручная остановка.
  $('btn-record').addEventListener('click', async () => {
    const btn = $('btn-record');
    if (isRecording()) {
      const res = await stopRecording();
      btn.classList.remove('recording');
      btn.textContent = '● Rec';
      $('rec-time').textContent = '';
      if (res) log(`WAV сохранён (${res.seconds.toFixed(1)} с)`, 'ok');
      return;
    }
    const bars = Number($('rec-bars').value) || null;
    const res = await startRecording({
      bars,
      bpm: Number($('bpm-slider').value),
      name: 'track',
      onTick: (s) => { $('rec-time').textContent = `${s.toFixed(1)} с`; },
      onFinished: () => {
        btn.classList.remove('recording');
        btn.textContent = '● Rec';
        $('rec-time').textContent = '';
        log('Запись завершена — WAV скачан', 'ok');
      },
    });
    if (!res.ok) {
      log(res.reason, 'error');
      return;
    }
    btn.classList.add('recording');
    btn.textContent = '■ Стоп';
    log(bars ? `Запись ${bars} такт(ов) пошла…` : 'Запись пошла (ручная остановка кнопкой)', 'ok');
  });

  $('btn-play').addEventListener('click', async () => {
    if (playing) {
      stop();
      playing = false;
      document.documentElement.classList.remove('playing');
    } else {
      const code = hooks.getCode();
      if (!code.trim()) return;
      const res = await evaluateCode(code);
      if (res.ok) {
        playing = true;
        document.documentElement.classList.add('playing');
      } else log(`Ошибка исполнения: ${res.error}`, 'error');
    }
    hooks.onPlayToggle?.(playing);
  });
  $('btn-stop-transport').addEventListener('click', () => {
    stop();
    playing = false;
    document.documentElement.classList.remove('playing');
    hooks.onPlayToggle?.(false);
  });
}

// Синхронизация контрола с кодом из редактора (без переигрывания).
export function syncTransport(code) {
  const bpm = getBpm(code);
  if (bpm && Number($('bpm-slider').value) !== Math.round(bpm)) {
    $('bpm-slider').value = String(Math.min(220, Math.max(40, Math.round(bpm))));
    $('bpm-value').textContent = $('bpm-slider').value;
  }
  const keyStr = getKey(code);
  if (keyStr) fillKeySelect(keyStr);
}

export function transportIsPlaying() {
  return playing;
}

// Текущие значения транспорта для сохранения в пресет.
export function transportState() {
  return {
    bpm: Number($('bpm-slider').value),
    key: `${$('key-select').value}:${$('scale-select').value}`,
  };
}
