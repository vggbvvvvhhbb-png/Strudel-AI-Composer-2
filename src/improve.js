// Режим «улучшить текущий трек»: запрос → полный новый код → diff → применить/отклонить.
import { generateCode } from './api/client.js';
import { diffLines, changedRegions } from './core/code-model.js';
import { log } from './ui.js';

const $ = (id) => document.getElementById(id);

const hooks = { getCode: () => '', apply: null };
let pending = null; // { newCode }

export function initImprove({ getCode, apply }) {
  hooks.getCode = getCode;
  hooks.apply = apply;
  $('btn-improve').addEventListener('click', runImprove);
  $('btn-diff-apply').addEventListener('click', applyDiff);
  $('btn-diff-reject').addEventListener('click', rejectDiff);
}

async function runImprove() {
  const instruction = $('improve-input').value.trim();
  const code = hooks.getCode();
  if (!instruction) {
    log('Опишите, что поправить', 'error');
    return;
  }
  if (!code.trim()) {
    log('Сначала сгенерируйте трек', 'error');
    return;
  }
  const btn = $('btn-improve');
  btn.disabled = true;
  btn.textContent = '⏳ Улучшение…';
  try {
    const newCode = await generateCode({
      prompt: instruction,
      mode: 'improve',
      currentCode: code,
      onDelta: () => {}, // полный код приходит по done; печать не нужна в диалоге правки
    });
    pending = { newCode };
    renderDiff(code, newCode);
    log('Предложены правки — просмотрите diff', 'ok');
  } catch (err) {
    log(`Улучшение не удалось: ${err.message || err}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Улучшить';
  }
}

function renderDiff(oldCode, newCode) {
  const box = $('diff-view');
  box.replaceChildren();
  const changed = changedRegions(oldCode, newCode);
  const touched = [
    changed.bpm ? 'BPM' : null,
    changed.key ? 'Key' : null,
    ...changed.parts.map((p) => `$${p}`),
  ].filter(Boolean);
  const summary = document.createElement('p');
  summary.className = 'diff-summary';
  summary.textContent = touched.length ? `Затронуто: ${touched.join(', ')}` : 'Изменений нет';
  box.appendChild(summary);

  for (const { type, text } of diffLines(oldCode, newCode)) {
    const line = document.createElement('div');
    line.className = `diff-line ${type}`;
    line.textContent = text || ' ';
    box.appendChild(line);
  }
  $('diff-panel').hidden = false;
}

function applyDiff() {
  if (!pending) return;
  $('diff-panel').hidden = true;
  const code = pending.newCode;
  pending = null;
  hooks.apply?.(code); // применить + прогнать валидацию + исполнить (ui.js)
}

function rejectDiff() {
  pending = null;
  $('diff-panel').hidden = true;
  log('Правки отклонены — код не изменён');
}
