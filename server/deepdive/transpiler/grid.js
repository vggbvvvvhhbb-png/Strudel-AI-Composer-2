// Сетка шагов: сколько шагов в такте, в какой шаг попал удар и как из
// измеренных ударов собрать паттерн.
//
// Всё считается от измеренной сетки drums.onsets.grid и от времени
// измеренных ударов: ни один шаг не придумывается.

import { GM_TO_SAMPLE } from './samples.js';

/**
 * Порядок шагов сетки в такте: 1/4 → 4, 1/8 → 8, 1/12 → 12, 1/16 → 16, 1/24 → 24, 1/32 → 32.
 */
export function stepsPerBar(gridStep) {
  const map = { '1/4': 4, '1/8': 8, '1/12': 12, '1/16': 16, '1/24': 24, '1/32': 32 };
  return map[gridStep] ?? 16;
}

/** Шаг сетки, в который попадает удар (доля шага от начала такта). */
export function gridFraction(hitTime, barStart, barSec) {
  const fraction = (hitTime - barStart) / barSec;
  return Math.min(0.9999, Math.max(0, fraction));
}

/**
 * Группы измеренных ударов для одной секции.
 *
 * ОГРАНИЧЕНИЕ ФОРМАТА. Каждая секция в TrackSpec — это ОДИН повторяющийся
 * паттерн (arrange([cycles, CONST])), а имена секций ограничены девятью
 * значениями. Значит, внутри секции bar-level вариация не выражается, и мы
 * берём ДОМИНИРУЮЩИЙ такт секции — самый частый её рисунок. Для монтажей и
 * фанков с повторяющимся баром это точное попадание; для треков с постоянной
 * вариацией — приближение. Это записано в отчёт, а не спрятано.
 *
 * @returns {{groups:Array, barSignature:string, stepCount:number}}
 */
export function buildGroupsForSection(roleHits, section, barSec, gridSteps) {
  const bars = [];
  for (let bar = 0; bar < section.cycles; bar += 1) {
    const barStart = section.start_s + bar * barSec;
    const barEnd = barStart + barSec;
    const inBar = roleHits.filter((hit) => {
      const time = hit.time_s ?? hit.time ?? null;
      return time !== null && time >= barStart && time < barEnd;
    });
    const cells = new Map(); // step -> {sample, velocity, offsetMs}
    for (const hit of inBar) {
      const time = hit.time_s ?? hit.time;
      const fraction = gridFraction(time, barStart, barSec);
      const step = Math.min(15, Math.round(fraction * 16));
      const offsetMs = (fraction * 16 - step) * (barSec * 1000) / 16;
      const sample = GM_TO_SAMPLE[hit.gm] ?? hit.label ?? 'perc';
      const velocity = Number(hit.velocity ?? 0.8);
      const previous = cells.get(step);
      // На один шаг — самый громкий удар.
      if (!previous || velocity > previous.velocity) {
        cells.set(step, { sample, velocity, offsetMs });
      }
    }
    bars.push(cells);
  }
  if (!bars.length) return { groups: [], barSignature: '', stepCount: gridSteps };

  // Доминирующий такт: самый частый рисунок (по подписи из шагов и сэмплов).
  const signatures = new Map();
  bars.forEach((cells, index) => {
    const signature = [...cells.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([step, cell]) => `${step}:${cell.sample}`)
      .join(',');
    if (!signatures.has(signature)) signatures.set(signature, { count: 0, index });
    signatures.get(signature).count += 1;
  });
  let best = null;
  for (const entry of signatures.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  const chosen = bars[best.index] ?? new Map();

  // Группировка по (сэмпл, динамика, сдвиг): внутри группы шаги стоят на своих
  // местах, разные группы несут разные веса.
  const groups = new Map();
  for (const [step, cell] of [...chosen.entries()].sort((a, b) => a[0] - b[0])) {
    const velocityBucket = Math.round(cell.velocity * 20) / 20;
    const offsetBucket = Math.round(cell.offsetMs / 5) * 5;
    const key = `${cell.sample}|${velocityBucket}|${offsetBucket}`;
    if (!groups.has(key)) {
      groups.set(key, { sample: cell.sample, steps: [], gain: velocityBucket, lateMs: offsetBucket });
    }
    groups.get(key).steps.push(step);
  }
  return {
    groups: [...groups.values()].filter((group) => group.steps.length),
    barSignature: best ? [...signatures.keys()].length : 0,
    stepCount: gridSteps,
  };
}

/**
 * Раскладка ударов по шагам сетки для одного такта.
 *
 * @returns {{tokens:string[], gains:number[]}|null}
 */
export function barFromHits(hits, barStart, barEnd, steps, stepSec, fallbackGain = 0.8) {
  const tokens = new Array(steps).fill('~');
  const gains = new Array(steps).fill(0);
  const seen = new Array(steps).fill(false);
  for (const hit of hits) {
    const time = hit.time_s ?? hit.time ?? null;
    if (time === null) continue;
    if (time < barStart - stepSec * 0.5 || time >= barEnd) continue;
    const index = Math.round((time - barStart) / stepSec);
    if (index < 0 || index >= steps) continue;
    // На один шаг — самый громкий удар: иначе два удара схлопнутся в один токен.
    const gain = hit.velocity ?? 0.8;
    if (!seen[index] || gain > gains[index]) {
      const sample = GM_TO_SAMPLE[hit.gm] ?? hit.label ?? 'perc';
      tokens[index] = sample;
      gains[index] = gain;
      seen[index] = true;
    }
  }
  if (!seen.some(Boolean)) return null;
  const normalized = gains.map((g) => (g > 0 ? Number(g.toFixed(3)) : fallbackGain));
  return { tokens, gains: normalized };
}

/**
 * Ритмическая строка mini-нотации из шагов.
 *
 * Формат mini-нотации — часть языка плана: шаги уходят в TrackSpec как
 * массивы токенов, но сам формат остаётся описанным здесь.
 */
export function tokensToMini(tokens) {
  return tokens.join(' ');
}
