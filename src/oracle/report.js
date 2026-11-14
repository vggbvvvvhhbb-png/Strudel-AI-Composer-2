// Символьный отчёт: IR → события → метрики → замечания → скор.
//
// Это «слой L1» из брифа (§4.2): всё, что можно узнать о треке, НЕ слушая
// его. Считается за миллисекунды, поэтому по треку можно гонять сотни
// кандидатов (см. search.js).
//
// Отчёт — машинночитаемый: по нему принимаются решения (критик-цикл,
// поиск, эволюция скилов), и по нему же видно, что именно не попало в цель.

import { irEvents } from './ir-events.js';
import { symbolicMetrics } from './metrics.js';
import { lintSymbolic, lintSummary } from './lint.js';
import { symbolicScore } from './score.js';
import { sha256Hex } from '../studio/sha256.js';
import { canonicalJson } from '../studio/model.js';

/**
 * Собирает полный символьный отчёт по IR.
 *
 * @param {object} ir CompositionIR
 * @returns {object} отчёт
 */
export function symbolicReport(ir) {
  const { events, bars, bpm, sections, key } = irEvents(ir);
  const metrics = symbolicMetrics(events, { ir, sections, bars, bpm, key });
  const pitches = events.flatMap((event) => event.pitches || []);

  const report = {
    v: 1,
    irHash: sha256Hex(canonicalJson(ir)),
    bpm,
    bars,
    key: key.name,
    genre: ir.meta?.genre ?? null,
    sections,
    metrics,
    registers: registersOf(events),
    roleSum: roleSumOf(ir),
    kinetics: kineticsOf(events),
    pitches,
    eventCount: events.length,
    lint: [],
    score: null,
  };

  report.lint = lintSymbolic(report);
  report.lintSummary = lintSummary(report.lint);
  report.score = symbolicScore(report);
  return report;
}

/** Регистры по ролям: min/max MIDI. */
function registersOf(events) {
  const out = {};
  for (const event of events) {
    if (!event.pitches || !event.pitches.length) continue;
    if (!out[event.role]) out[event.role] = { min: null, max: null };
    for (const midi of event.pitches) {
      if (out[event.role].min === null || midi < out[event.role].min) out[event.role].min = midi;
      if (out[event.role].max === null || midi > out[event.role].max) out[event.role].max = midi;
    }
  }
  return out;
}

/**
 * Сумма уровней ролей в самой плотной секции.
 *
 * Это НЕ запас до мастера: уровни ролей — балансные цели относительно
 * кика, а не абсолютные громкости. Настоящий запас до мастера считает
 * аудио-слой (L0: клиппинг, true peak). Здесь число нужно как грубый
 * индикатор перегруза микса, поэтому и называется честно.
 */
function roleSumOf(ir) {
  let worst = 0;
  for (const section of ir.sections || []) {
    let sum = 0;
    for (const layer of Object.values(section.layers || {})) {
      const gainDb = layer.gainDb ?? 0;
      sum += Math.pow(10, gainDb / 20) * (layer.weight ?? 1);
    }
    if (sum > worst) worst = sum;
  }
  return Math.round(worst * 1000) / 1000;
}

/** Динамика: монотонна ли она. */
function kineticsOf(events) {
  const velocities = new Set(
    events
      .filter((event) => ['kick', 'snare', 'hats', 'perc'].includes(event.role))
      .map((event) => Math.round((event.vel ?? 0) * 100)),
  );
  return {
    distinctVelocities: velocities.size,
    flatVelocity: velocities.size <= 1,
  };
}
