// Символьные метрики музыкальности (бриф v2 §6 и §4.2 «L1»).
//
// ЭТО НЕ ОЦЕНКА ВКУСА. Это измеримые свойства структуры трека: форма,
// контраст секций, корреляция энергии с целевой кривой, повторяемость
// мотива, закрытие фраз, связка бас–кик, тональная чистота.
//
// Честная оговорка из брифа: символьные метрики — гипотезы о том, что слышит
// человек. До проверки человеческими парами (H3) оракул — фильтр дефектов и
// грубый ранжировщик, но НЕ судья вкуса. Здесь это зафиксировано в коде.

import { keyInfo } from './ir-events.js';

/** Вес роли в энергетическом прокси: сколько роли даёт такту. */
export const ROLE_ENERGY_WEIGHT = {
  kick: 1.0, snare: 0.8, hats: 0.4, perc: 0.5,
  bass: 0.9, sub: 0.9, chords: 0.7, pad: 0.5,
  lead: 0.8, arp: 0.5, fx: 0.3, texture: 0.2,
};

/** Роли, чьи высоты образуют мелодическую линию. */
const MELODIC_ROLES = new Set(['lead', 'arp']);

/** Устойчивые ступени лада: тоника, терция, квинта (индексы 0, 2, 4). */
const STABLE_DEGREES = new Set([0, 2, 4]);

const EPS = 1e-9;

/** Пирсон: корреляция двух рядов. null, если ряд вырожден. */
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  if (den < EPS) return null;
  return num / den;
}

/** Косинусная близость двух векторов. */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na < EPS || nb < EPS) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Считает символьные метрики трека.
 *
 * @param {Array} events события (см. ir-events.js)
 * @param {object} context {ir, sections, bars, bpm, key}
 * @returns {object} метрики
 */
export function symbolicMetrics(events, context) {
  const { ir, sections = [], bars = 0, bpm = 120 } = context;
  const info = context.key || keyInfo(ir.meta.key);
  const seconds = (bars * 240000) / bpm / 1000;

  const perBar = new Array(bars).fill(0);
  const perRole = {};
  const roleCounts = {};
  let energySum = 0;

  for (const event of events) {
    const bar = Math.min(bars - 1, Math.max(0, Math.floor(event.t)));
    const weight = ROLE_ENERGY_WEIGHT[event.role] ?? 0.5;
    const energy = (event.vel ?? 0) * weight;
    perBar[bar] += energy;
    energySum += energy;
    roleCounts[event.role] = (roleCounts[event.role] || 0) + 1;
    perRole[event.role] = (perRole[event.role] || 0) + (event.vel ?? 0);
  }

  const maxEnergy = Math.max(...perBar, EPS);
  const energyProfile = perBar.map((value) => value / maxEnergy);

  // Целевая кривая: энергия секции, развёрнутая по тактам.
  const targetProfile = new Array(bars).fill(0);
  for (const section of sections) {
    for (let bar = section.startBar; bar < section.endBar && bar < bars; bar += 1) {
      targetProfile[bar] = section.energy ?? 0.5;
    }
  }

  const energyCorrelation = pearson(energyProfile, targetProfile);

  // --- контраст соседних секций ---
  const sectionFeatures = sections.map((section) => sectionFeature(events, section));
  const contrasts = [];
  for (let i = 0; i + 1 < sectionFeatures.length; i += 1) {
    const similarity = cosineSimilarity(sectionFeatures[i], sectionFeatures[i + 1]);
    contrasts.push(round(1 - similarity, 4));
  }
  const minContrast = contrasts.length ? Math.min(...contrasts) : 0;

  // --- тональность ---
  // Мелодические роли (лид, арп) обязаны лежать в ладе. Аккордовые — нет:
  // септима и терция доминанты по определению вне тональной шкалы, и штрафовать
  // за это значит наказывать за правильную гармонию.
  const melodic = events.filter((event) => MELODIC_ROLES.has(event.role));
  const harmonic = events.filter((event) => ['chords', 'pad'].includes(event.role));
  const melodicPitches = melodic.flatMap((event) => event.pitches || []);
  const allowed = new Set(info.intervals.map((i) => (info.pc + i) % 12));
  const inScale = melodicPitches.filter((midi) => allowed.has(((midi % 12) + 12) % 12)).length;
  const scaleFit = melodicPitches.length ? inScale / melodicPitches.length : null;
  const harmonicPitches = harmonic.flatMap((event) => event.pitches || []);
  const harmonicIn = harmonicPitches.filter((midi) => allowed.has(((midi % 12) + 12) % 12)).length;
  const harmonicFit = harmonicPitches.length ? harmonicIn / harmonicPitches.length : null;

  // --- мотив: повторяемость и вариации ---
  const motif = motifRecurrence(events, sections, bars);

  // --- закрытие фраз ---
  const phrases = phraseClosure(events, sections, bars, info);

  // --- связка бас–кик ---
  const bassKick = bassKickLock(events);

  // --- микротайминг ---
  const micro = microtiming(events, bpm);

  // --- разнообразие тактов ---
  const variation = barVariation(events, bars);

  return {
    bars,
    bpm,
    key: info.name,
    events: events.length,
    density: seconds > 0 ? events.length / seconds : 0,
    roleCounts,
    roleBalance: normalizeRoleBalance(perRole),
    energyProfile: energyProfile.map((v) => round(v, 4)),
    targetProfile: targetProfile.map((v) => round(v, 4)),
    energyCorrelation: energyCorrelation === null ? null : round(energyCorrelation, 4),
    energyRange: round(Math.max(...energyProfile, 0) - Math.min(...energyProfile, 0), 4),
    sectionContrasts: contrasts,
    minContrast: round(minContrast, 4),
    scaleFit: scaleFit === null ? null : round(scaleFit, 4),
    harmonicFit: harmonicFit === null ? null : round(harmonicFit, 4),
    motifRecurrence: motif,
    phraseClosure: phrases,
    bassKickLock: round(bassKick, 4),
    microtiming: micro,
    variation: variation,
  };
}

/** Вектор признаков секции: слоты 1/16 + плотности ролей. */
function sectionFeature(events, section) {
  const slots = new Array(16).fill(0);
  const roles = {};
  for (const event of events) {
    if (event.section !== section.index) continue;
    const local = (event.t - section.startBar) * 16;
    const slot = ((Math.round(local) % 16) + 16) % 16;
    slots[slot] += (event.vel ?? 0);
    roles[event.role] = (roles[event.role] || 0) + (event.vel ?? 0);
  }
  const roleNames = Object.keys(ROLE_ENERGY_WEIGHT).sort();
  return [...slots, ...roleNames.map((role) => roles[role] || 0)];
}

/**
 * Повторяемость мотива.
 *
 * Ищем рисунок мелодии (набор занятых слотов), который встречается ≥3 раз
 * и в ≥2 секциях; вариация — те же слоты, но другой набор классов высоты.
 */
function motifRecurrence(events, sections, bars) {
  const perBar = new Map();
  for (const event of events) {
    if (!MELODIC_ROLES.has(event.role)) continue;
    const bar = Math.floor(event.t);
    if (!perBar.has(bar)) perBar.set(bar, { slots: [], classes: [] });
    const entry = perBar.get(bar);
    const local = Math.round((event.t - bar) * 16);
    entry.slots.push(local);
    for (const midi of event.pitches || []) {
      entry.classes.push(((midi % 12) + 12) % 12);
    }
  }

  const byShape = new Map();
  for (const [bar, entry] of [...perBar.entries()].sort((a, b) => a[0] - b[0])) {
    const slots = [...entry.slots].sort((a, b) => a - b).join(',');
    const classes = entry.classes.join(',');
    const sectionIndex = sections.findIndex(
      (section) => bar >= section.startBar && bar < section.endBar,
    );
    if (!byShape.has(slots)) byShape.set(slots, []);
    byShape.get(slots).push({ bar, classes, sectionIndex });
  }

  let best = { shape: null, count: 0, sectionCount: 0, variations: 0 };
  for (const [shape, occurrences] of byShape) {
    if (occurrences.length < 2) continue;
    const sectionCount = new Set(occurrences.map((o) => o.sectionIndex)).size;
    const variations = new Set(occurrences.map((o) => o.classes)).size;
    if (
      occurrences.length > best.count
      || (occurrences.length === best.count && variations > best.variations)
    ) {
      best = { shape, count: occurrences.length, sectionCount, variations };
    }
  }

  return {
    count: best.count,
    sectionCount: best.sectionCount,
    variations: best.variations,
    // Хук засчитывается, если рисунок звучит ≥3 раз, в ≥2 секциях и хотя бы
    // однажды с вариацией (бриф §4.2).
    hook: best.count >= 3 && best.sectionCount >= 2 && best.variations >= 2,
  };
}

/**
 * Закрытие фраз: антецедент (открытый) и консеквент (закрытый).
 *
 * Тип фразы определяет гармония в её последнем такте: если аккорд там —
 * тоника, фраза консеквент и должна закрываться устойчивой ступенью; иначе —
 * антецедент, и он должен оставаться открытым.
 *
 * Фразы не пересекают границы секций: фраза — единица внутри арки.
 */
function phraseClosure(events, sections, bars, info) {
  const melodic = events
    .filter((event) => MELODIC_ROLES.has(event.role) && (event.pitches || []).length)
    .sort((a, b) => a.t - b.t);

  // Римская цифра на каждый такт трека.
  const romanByBar = new Array(bars).fill(null);
  for (const section of sections) {
    const step = section.harmony || [];
    let bar = section.startBar;
    for (const item of step) {
      const length = item.bars || 1;
      for (let i = 0; i < length && bar < bars; i += 1) {
        romanByBar[bar] = item.rn;
        bar += 1;
      }
    }
  }

  const phrases = [];
  for (const section of sections) {
    for (let start = section.startBar; start < section.endBar; start += 2) {
      const end = Math.min(section.endBar, start + 2);
      const inPhrase = melodic.filter((event) => event.t >= start && event.t < end);
      if (!inPhrase.length) continue;
      const last = inPhrase[inPhrase.length - 1];
      const degree = degreeOf(last.pitches[0], info);
      const roman = romanByBar[end - 1] ?? null;
      const resolved = isTonicRoman(roman);
      phrases.push({
        start,
        end,
        degree,
        roman,
        stable: degree !== null && STABLE_DEGREES.has(degree),
        resolved,
      });
    }
  }

  const consequents = phrases.filter((phrase) => phrase.resolved);
  const antecedents = phrases.filter((phrase) => !phrase.resolved);
  const closed = consequents.filter((phrase) => phrase.stable);
  const open = antecedents.filter((phrase) => !phrase.stable);

  return {
    count: phrases.length,
    consequents: consequents.length,
    antecedents: antecedents.length,
    closed: closed.length,
    openAntecedents: open.length,
    // Доля консеквентов, закрытых устойчивой ступенью (цель ≥ 0.7).
    closureRatio: consequents.length ? round(closed.length / consequents.length, 4) : null,
    // Доля антецедентов, оставшихся открытыми (цель ≥ 0.7).
    openRatio: antecedents.length ? round(open.length / antecedents.length, 4) : null,
  };
}

/** Тonic в римской нотации: I или i (с необязательным хвостом 7/9). */
function isTonicRoman(roman) {
  if (!roman) return false;
  return /^i$/i.test(String(roman).trim())
    || /^i(maj7|min7|7)?$/i.test(String(roman).trim());
}

/** Ступень лада для MIDI-ноты (null, если нота вне лада). */
function degreeOf(midi, info) {
  const pc = ((midi % 12) + 12) % 12;
  const index = info.intervals.findIndex((interval) => (info.pc + interval) % 12 === pc);
  return index === -1 ? null : index;
}

/** Доля атак баса, совпавших с атаками кика (сетка 1/16). */
function bassKickLock(events) {
  const kicks = events.filter((event) => event.role === 'kick').map((event) => event.t);
  const bass = events.filter((event) => event.role === 'bass' || event.role === 'sub');
  if (!bass.length || !kicks.length) return 0;
  let locked = 0;
  for (const event of bass) {
    if (kicks.some((kick) => Math.abs(kick - event.t) < 1 / 32)) locked += 1;
  }
  return locked / bass.length;
}

/** Микротайминг: стандартное отклонение атак ударных от сетки 1/16, в мс. */
function microtiming(events, bpm) {
  const drums = events.filter((event) => ['kick', 'snare', 'hats', 'perc'].includes(event.role));
  if (!drums.length) return { stdMs: 0, meanMs: 0, count: 0 };
  const msPerCycle = 240000 / bpm;
  const deviations = drums.map((event) => {
    const grid = Math.round(event.t * 16) / 16;
    return (event.t - grid) * msPerCycle;
  });
  const mean = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  const variance = deviations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / deviations.length;
  return {
    stdMs: round(Math.sqrt(variance), 3),
    meanMs: round(mean, 3),
    count: deviations.length,
  };
}

/**
 * Разнообразие: доля уникальных тактов.
 *
 * В подпись такта входит не только ритм, но и высоты: иначе трек, где
 * каждый такт отличается гармонией, выглядел бы статичным лупом.
 */
function barVariation(events, bars) {
  const signatures = new Set();
  for (let bar = 0; bar < bars; bar += 1) {
    const parts = events
      .filter((event) => Math.floor(event.t) === bar)
      .map((event) => {
        const classes = (event.pitches || [])
          .map((midi) => ((midi % 12) + 12) % 12)
          .sort((a, b) => a - b)
          .join('.');
        return `${event.role}:${Math.round((event.t - bar) * 16)}${classes ? `[${classes}]` : ''}`;
      })
      .sort()
      .join('|');
    if (signatures.size < 4096) signatures.add(parts);
  }
  const filled = [...signatures].filter((signature) => signature.length > 0).length;
  return {
    uniqueBars: filled,
    bars,
    ratio: bars ? round(filled / bars, 4) : 0,
  };
}

/** Баланс ролей: нормированная доля каждой роли в сумме уровней. */
function normalizeRoleBalance(perRole) {
  const total = Object.values(perRole).reduce((a, b) => a + b, 0);
  const out = {};
  for (const [role, value] of Object.entries(perRole)) {
    out[role] = total > 0 ? round(value / total, 4) : 0;
  }
  return out;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
