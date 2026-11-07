// Живые метры партий: срабатывания нот → уровень → VU в микшере и подсветка активной партии.
//
// Как это устроено: в цепочку каждой партии вплетается .onTrigger(..., false).
// Второй аргумент false — ключевой: он означает «не забирать звук», поэтому штатный
// webaudio-выход остаётся включённым, а наш обработчик получает каждый сработавший hap.
// (Так же работает встроенный .log() в Strudel.)
//
// Инструментация применяется только к исполняемой копии — редактор и LLM видят чистый код.
import { parseParts, commentStart } from './core/code-model.js';

// Имя глобальной функции-моста: её видит исполняемый код Strudel.
const GLOBAL_FN = 'SA_METER';

const DECAY_PER_SEC = 1.9; // скорость затухания индикатора
const ACTIVE_THRESHOLD = 0.12; // с какого уровня партия считается «звучащей»

const levels = new Map(); // метка партии → уровень 0..1
const listeners = new Set();
let rafId = 0;

// Мост: исполняемый код вызывает SA_METER("BASS") на каждой сработавшей ноте.
function hit(label) {
  if (!label) return;
  levels.set(label, 1);
  startLoop();
  emit();
}

// Затухание в отдельном цикле кадров: вспышка на.note, плавное угасание.
function startLoop() {
  if (rafId) return;
  let prev = performance.now();
  const step = (now) => {
    const dt = Math.min(0.12, (now - prev) / 1000);
    prev = now;
    let alive = false;
    for (const [label, value] of levels) {
      const next = Math.max(0, value - dt * DECAY_PER_SEC);
      if (next <= 0.001) levels.delete(label);
      else {
        levels.set(label, next);
        alive = true;
      }
    }
    emit();
    rafId = alive ? requestAnimationFrame(step) : 0;
  };
  rafId = requestAnimationFrame(step);
}

function emit() {
  const snapshot = new Map(levels);
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) {
      console.warn('Ошибка подписчика метров:', err);
    }
  }
}

/** Подписка на изменения уровней. Возвращает функцию отписки. */
export function subscribeLevels(fn) {
  listeners.add(fn);
  fn(new Map(levels));
  return () => listeners.delete(fn);
}

/** Текущий уровень партии 0..1. */
export function levelOf(label) {
  return levels.get(label) ?? 0;
}

/** Метки партий, которые звучат прямо сейчас. */
export function activeLabels() {
  const out = [];
  for (const [label, value] of levels) if (value >= ACTIVE_THRESHOLD) out.push(label);
  return out;
}

/** Сброс всех метров (стоп/смена трека). */
export function resetMeters() {
  levels.clear();
  emit();
}

/**
 * Вплетает счётчики в код: в конец цепочки каждой партии добавляется
 * .onTrigger(()=>SA_METER('LABEL'),false). Возвращает новый код и список меток.
 *
 * Метка берётся в одинарных кавычках: транспайлер Strudel превращает любой
 * литерал в двойных кавычках в mini-паттерн (miniAllStrings), и до обработчика
 * дошла бы не строка, а объект-паттерн.
 *
 * Чистая функция: код не меняется на месте, исходная строка не трогается.
 */
export function instrumentCode(code) {
  const parts = parseParts(code);
  if (!parts.length) return { code, labels: [] };

  const lines = code.split('\n');
  const labels = [];
  const seen = new Set();

  for (const part of parts) {
    const label = part.label;
    if (!label || seen.has(label)) continue;
    const index = part.endLine;
    const line = lines[index];
    if (typeof line !== 'string') continue;

    const commentAt = commentStart(line);
    const head = commentAt === -1 ? line : line.slice(0, commentAt);
    const tail = commentAt === -1 ? '' : line.slice(commentAt);
    const trimmed = head.trimEnd();
    if (!trimmed) continue;

    const quoted = `'${label.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    lines[index] = `${trimmed}.onTrigger(()=>${GLOBAL_FN}(${quoted}),false)${tail ? ` ${tail}` : ''}`;
    seen.add(label);
    labels.push(label);
  }

  return { code: lines.join('\n'), labels };
}

// Устанавливаем мост один раз при загрузке модуля.
if (typeof globalThis !== 'undefined' && typeof globalThis[GLOBAL_FN] !== 'function') {
  globalThis[GLOBAL_FN] = hit;
}

export const METER_GLOBAL = GLOBAL_FN;
