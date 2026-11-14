// Поиск: best-of-N по мутациям IR (бриф §5.3, спринт S3.3).
//
// Идея: LLM выдаёт план, но план — не лучший из возможных. Поэтому
// кандидаты не перегенерируются моделью, а получаются ДЕТЕРМИНИРОВАННЫМИ
// мутациями IR: смена грува, фильтра, регистра, плотности, темпа, гармонии.
// Каждый кандидат оценивается символьным оракулом (миллисекунды), и
// выигрывают несколько лучших.
//
// Экономика: измерено — queryArc движка даёт ~11 кандидатов/с, а быстрый
// оракул (без движка) — сотни в секунду. Поэтому символьный поиск идёт по
// ВСЕМ кандидатам, а движок включается только для финалистов.
//
// Детерминизм: мутации адресные (seed, индекс кандидата), поэтому один и
// тот же IR с тем же seed всегда даёт одну и ту же выдачу.

import { cloneIR } from '../ir/schema.js';
import { random01, pick } from '../ir/prng.js';
import { IR_GROOVE_TEMPLATES } from '../ir/schema.js';
import { applyTransform } from '../ir/transforms.js';
import { symbolicReport } from './report.js';

/** Имена мутаций — чтобы поиск был читаемым в отчёте. */
export const MUTATIONS = [
  'grooveTemplate', 'swing', 'density', 'lpf', 'register',
  'energy', 'tempo', 'harmony', 'motif', 'palette',
];

/**
 * Одна мутация IR. Детерминирована по (seed, индекс).
 * @param {object} ir исходный IR
 * @param {number} seed зерно
 * @param {number} index номер кандидата
 * @returns {{ir:object, name:string, detail:string}}
 */
export function mutateIR(ir, seed, index) {
  const next = cloneIR(ir);
  const name = pick(seed, MUTATIONS, 'mutation', index);
  const roll = random01(seed, 'mutation-roll', index);
  const detail = applyMutation(next, name, seed, index, roll);
  return { ir: next, name, detail };
}

/** Применяет мутацию по имени; возвращает человекочитаемое описание. */
function applyMutation(ir, name, seed, index, roll) {
  switch (name) {
    case 'grooveTemplate': {
      const current = ir.groove.template;
      const options = IR_GROOVE_TEMPLATES.filter((template) => template !== current);
      const next = pick(seed, options, 'groove', index);
      ir.groove.template = next;
      ir.groove.swing = undefined;
      return `грув ${current} → ${next}`;
    }
    case 'swing': {
      const current = ir.groove.swing ?? 0.5;
      const delta = (roll - 0.5) * 0.12;
      ir.groove.swing = Math.max(0.5, Math.min(0.68, current + delta));
      return `свинг ${current.toFixed(2)} → ${ir.groove.swing.toFixed(2)}`;
    }
    case 'density': {
      const role = pick(seed, ['kick', 'snare', 'hats', 'perc'], 'density-role', index);
      const delta = (roll - 0.5) * 0.4;
      let touched = 0;
      for (const section of ir.sections) {
        const layer = section.layers[role];
        if (!layer) continue;
        layer.density = Math.max(0.2, Math.min(1, layer.density + delta));
        touched += 1;
      }
      return `плотность ${role} ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} (${touched} секций)`;
    }
    case 'lpf': {
      const role = pick(seed, ['chords', 'pad', 'lead', 'arp'], 'lpf-role', index);
      const factor = 1 + (roll - 0.5) * 0.6;
      let touched = 0;
      for (const section of ir.sections) {
        const layer = section.layers[role];
        if (!layer) continue;
        const base = layer.lpf ?? 2400;
        layer.lpf = Math.max(120, Math.min(20000, Math.round(base * factor)));
        touched += 1;
      }
      return `фильтр ${role} ×${factor.toFixed(2)} (${touched} секций)`;
    }
    case 'register': {
      const role = pick(seed, ['lead', 'arp', 'chords'], 'register-role', index);
      const steps = roll > 0.5 ? 1 : -1;
      try {
        applyTransform(ir, 'shiftRegister', role, steps);
      } catch {
        return 'регистр: роль не найдена';
      }
      return `регистр ${role} ${steps > 0 ? '+1' : '−1'} октава`;
    }
    case 'energy': {
      if (!ir.sections.length) return 'энергия: в плане нет секций';
      const section = pick(seed, ir.sections.map((item) => item.id), 'energy-section', index);
      const delta = (roll - 0.5) * 0.4;
      applyTransform(ir, 'boostSection', section, delta);
      return `энергия секции ${section} ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`;
    }
    case 'tempo': {
      const factor = 1 + (roll - 0.5) * 0.12;
      applyTransform(ir, 'scaleTempo', factor);
      return `темп ×${factor.toFixed(3)} → ${ir.meta.bpm} BPM`;
    }
    case 'harmony': {
      const section = pick(seed, ir.sections.map((item) => item.id), 'harmony-section', index);
      const target = ir.sections.find((item) => item.id === section);
      if (!target || !target.harmony.length) return 'гармония: секция пуста';
      const stepIndex = Math.floor(random01(seed, 'harmony-step', index) * target.harmony.length);
      const color = pick(seed, [undefined, 'add9', '7', 'sus'], 'harmony-color', index);
      applyTransform(ir, 'setHarmony', section, stepIndex, undefined, color);
      return `гармония ${section}[${stepIndex}] цвет ${color || '—'}`;
    }
    case 'motif': {
      const section = pick(seed, ir.sections.map((item) => item.id), 'motif-section', index);
      applyTransform(ir, 'addVariation', section);
      return `вариация мотива в ${section}`;
    }
    case 'palette': {
      const role = pick(seed, ['chords', 'lead', 'arp', 'pad'], 'palette-role', index);
      const options = ['piano', 'triangle', 'sawtooth', 'square', 'supersaw', 'sine'];
      const ref = pick(seed, options, 'palette-ref', index);
      ir.palette = { ...(ir.palette || {}), [role]: { ref } };
      return `инструмент ${role} → ${ref}`;
    }
    default:
      return 'без изменений';
  }
}

/**
 * Поиск лучших кандидатов.
 *
 * @param {object} ir исходный IR
 * @param {object} [options]
 * @param {number} [options.n] сколько кандидатов сгенерировать (по умолчанию 16)
 * @param {number} [options.topK] сколько вернуть (по умолчанию 3)
 * @param {number} [options.seed] зерно (по умолчанию ir.seed)
 * @param {(ir:object)=>object} [options.analyze] функция оценки (по умолчанию быстрый оракул)
 * @returns {{candidates:Array, base:object, elapsedMs:number}}
 */
export function searchBest(ir, options = {}) {
  const n = Math.max(1, options.n ?? 16);
  const topK = Math.max(1, options.topK ?? 3);
  const seed = options.seed ?? ir.seed ?? 0;
  const analyze = options.analyze || symbolicReport;

  const started = Date.now();
  const baseReport = analyze(ir);
  const candidates = [];

  for (let index = 0; index < n; index += 1) {
    let mutation = null;
    let error = null;
    try {
      mutation = mutateIR(ir, seed, index);
    } catch (err) {
      // Мутация может не подойти вырожденному плану (например, пустому
      // списку секций). Один сбойный кандидат не должен рушить весь поиск:
      // он просто выбывает, а остальные кандидаты оцениваются как обычно.
      error = String(err?.message || err);
    }
    if (!mutation) {
      candidates.push({
        index,
        mutation: 'unknown',
        detail: 'мутация не применилась',
        score: null,
        error,
        ir: null,
        report: null,
      });
      continue;
    }
    let report = null;
    try {
      report = analyze(mutation.ir);
    } catch (err) {
      error = String(err?.message || err);
    }
    if (!report) {
      candidates.push({
        index,
        mutation: mutation.name,
        detail: mutation.detail,
        score: null,
        error,
        ir: mutation.ir,
        report: null,
      });
      continue;
    }
    candidates.push({
      index,
      mutation: mutation.name,
      detail: mutation.detail,
      score: report.score.total,
      errors: report.lintSummary.errors,
      ir: mutation.ir,
      report,
    });
  }

  // Сортировка: сначала скор, потом меньше ошибок. Детерминированно.
  const ranked = [...candidates].sort((a, b) => {
    const scoreA = a.score ?? -1;
    const scoreB = b.score ?? -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    if (a.errors !== b.errors) return a.errors - b.errors;
    return a.index - b.index;
  });

  return {
    base: { score: baseReport.score.total, report: baseReport },
    candidates: ranked.slice(0, topK),
    all: candidates,
    elapsedMs: Date.now() - started,
    evaluated: candidates.length,
  };
}
