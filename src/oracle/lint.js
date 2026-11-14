// Линтер символьной музыкальности.
//
// Отличие от `src/audio/qa.js`: аудио-QA смотрит на ЗВУК (клиппинг, true peak,
// громкость) и предлагает правки кода. Линтер здесь смотрит на СТРУКТУРУ
// (форма, контраст, гармония, грув, регистр) и предлагает ТИПИЗИРОВАННЫЕ
// трансформации IR — то есть конкретные операции из `src/ir/transforms.js`.
//
// Формат замечания — тот же, что у аудио-QA, чтобы интерфейс и отчёты
// читали одинаково:
//
//   { code, severity, params, suggestedTransforms }
//
// severity: 'error' | 'warning' | 'info'.
//
// ПРОВЕРКА ЛИНТЕРА — mutation testing: в эталоны вносятся заведомые дефекты,
// и линтер обязан их находить (recall ≥ 95 %, precision ≥ 90 %).
// См. tests/unit/oracle-lint.test.js.

import { SCALES } from '../ir/harmony.js';

/** Пороги North Star (§4.2). */
export const LINT_THRESHOLDS = {
  minSections: 3,
  minContrast: 0.25,
  minEnergyCorrelation: 0.7,
  minClosureRatio: 0.7,
  minBassKickLock: 0.6,
  minScaleFit: 0.95,
  maxDensity: 20,
  minDensity: 1,
  maxBassMidi: 48, // c3
};

/**
 * Пороги по жанрам.
 *
 * Единые пороги врут: у D&B 33 события/с — это норма, а не «каша», а
 * оффбитный бас в синтипопе — признак жанра, а не рассинхрон. Поэтому
 * часть правил зависит от жанра, и это зафиксировано явно.
 */
export const GENRE_THRESHOLDS = {
  'trip-hop': { maxDensity: 16, lock: 0.6 },
  lofi: { maxDensity: 18, lock: 0.6 },
  dnb: { maxDensity: 40, lock: 0.25 },
  synthpop: { maxDensity: 26, lock: null }, // бас оффбитный — так и надо
  ambient: { maxDensity: 10, lock: null },
};

/** Пороги жанра с запасом по умолчанию. */
export function thresholdsFor(genre) {
  const custom = GENRE_THRESHOLDS[genre] || {};
  return {
    maxDensity: custom.maxDensity ?? LINT_THRESHOLDS.maxDensity,
    lock: custom.lock === undefined ? LINT_THRESHOLDS.minBassKickLock : custom.lock,
  };
}

/**
 * Проверяет трек и возвращает список замечаний.
 *
 * @param {object} report отчёт `symbolicReport`
 * @returns {Array<{code:string, severity:string, params:object, suggestedTransforms:Array}>}
 */
export function lintSymbolic(report) {
  const findings = [];
  const metrics = report.metrics;
  const sections = report.sections || [];
  const thresholds = thresholdsFor(report.genre);

  // --- форма ---
  if (sections.length < LINT_THRESHOLDS.minSections) {
    findings.push({
      code: 'sections-too-few',
      severity: 'error',
      params: { count: sections.length, min: LINT_THRESHOLDS.minSections },
      message: `Секций ${sections.length}: трек без формы читается как луп.`,
      suggestedTransforms: sections.length
        ? [{ transform: 'extendSection', sectionId: sections[sections.length - 1].id, bars: 8 }]
        : [],
    });
  }

  for (const section of sections) {
    if (section.events === 0) {
      findings.push({
        code: 'empty-section',
        severity: 'error',
        params: { sectionId: section.id, kind: section.kind },
        message: `Секция «${section.kind}» пуста — в арке есть провал.`,
        suggestedTransforms: [{ transform: 'boostSection', sectionId: section.id, delta: 0.2 }],
      });
    }
  }

  // Контраст соседних секций: где провал — там и предлагаем правку.
  metrics.sectionContrasts.forEach((contrast, index) => {
    if (contrast >= LINT_THRESHOLDS.minContrast) return;
    const weaker = index + 1;
    findings.push({
      code: 'contrast-low',
      severity: 'warning',
      params: {
        contrast,
        min: LINT_THRESHOLDS.minContrast,
        from: sections[index]?.id,
        to: sections[weaker]?.id,
      },
      message:
        `Секции «${sections[index]?.kind}» и «${sections[weaker]?.kind}» звучат одинаково ` +
        `(контраст ${contrast.toFixed(2)} < ${LINT_THRESHOLDS.minContrast}).`,
      suggestedTransforms: [
        { transform: 'boostSection', sectionId: sections[weaker]?.id, delta: 0.2 },
        { transform: 'thin', role: 'hats', amount: 0.4 },
      ],
    });
  });

  // --- энергия против целевой кривой ---
  if (metrics.energyCorrelation !== null && metrics.energyCorrelation < LINT_THRESHOLDS.minEnergyCorrelation) {
    const deviating = worstSectionByEnergy(metrics, sections);
    findings.push({
      code: 'energy-correlation-low',
      severity: 'warning',
      params: {
        correlation: metrics.energyCorrelation,
        min: LINT_THRESHOLDS.minEnergyCorrelation,
        sectionId: deviating?.id ?? null,
      },
      message:
        `Профиль энергии расходится с аркой (r = ${metrics.energyCorrelation.toFixed(2)} ` +
        `< ${LINT_THRESHOLDS.minEnergyCorrelation}).`,
      suggestedTransforms: deviating
        ? [{ transform: 'boostSection', sectionId: deviating.id, delta: 0.15 }]
        : [],
    });
  }

  // Пик обязан быть громче брейка.
  const peak = sections.find((section) => section.kind === 'peak' || section.kind === 'drop');
  const brk = sections.find((section) => section.kind === 'break');
  if (peak && brk && peak.energy <= brk.energy) {
    findings.push({
      code: 'peak-not-above-break',
      severity: 'warning',
      params: { peak: peak.energy, break: brk.energy },
      message: `Пик (${peak.energy}) не громче брейка (${brk.energy}) — арка не читается.`,
      suggestedTransforms: [
        { transform: 'boostSection', sectionId: peak.id, delta: 0.2 },
        { transform: 'boostSection', sectionId: brk.id, delta: -0.15 },
      ],
    });
  }

  // --- мотив ---
  if (!metrics.motifRecurrence.hook) {
    const returns = metrics.motifRecurrence.count >= 3 && metrics.motifRecurrence.sectionCount >= 2;
    findings.push({
      code: returns ? 'hook-without-variation' : 'no-hook',
      severity: 'warning',
      params: {
        count: metrics.motifRecurrence.count,
        sections: metrics.motifRecurrence.sectionCount,
        variations: metrics.motifRecurrence.variations,
      },
      message: returns
        ? `Мотив повторяется (${metrics.motifRecurrence.count} раз), но всегда одинаково — ` +
          'нет вариации, трек звучит как зацикленная петля.'
        : 'Мотив не возвращается: рисунок звучит ' +
          `${metrics.motifRecurrence.count} раз в ${metrics.motifRecurrence.sectionCount} секциях.`,
      suggestedTransforms: sections.length
        ? [{ transform: 'addVariation', sectionId: sections[sections.length - 1].id }]
        : [],
    });
  }

  // --- закрытие фраз ---
  const closure = metrics.phraseClosure;
  if (closure.consequents && closure.closureRatio !== null && closure.closureRatio < LINT_THRESHOLDS.minClosureRatio) {
    findings.push({
      code: 'phrase-not-closed',
      severity: 'warning',
      params: { closureRatio: closure.closureRatio, min: LINT_THRESHOLDS.minClosureRatio },
      message:
        `Консеквенты закрываются на устойчивой ступени только в ${(closure.closureRatio * 100).toFixed(0)} % случаев.`,
      suggestedTransforms: sections.length
        ? [{ transform: 'setHarmony', sectionId: sections[sections.length - 1].id, index: 0, rn: 'I' }]
        : [],
    });
  }

  // --- грув: связка бас–кик ---
  // В жанрах, где бас по определению оффбитный (синтипоп), правило не
  // применяется: там рассинхрон — это норма жанра, а не дефект.
  if (thresholds.lock !== null && metrics.bassKickLock < thresholds.lock) {
    findings.push({
      code: 'bass-kick-uncoupled',
      severity: 'warning',
      params: { lock: metrics.bassKickLock, min: thresholds.lock },
      message:
        `Бас совпадает с киком только в ${(metrics.bassKickLock * 100).toFixed(0)} % атак — пульс плавает.`,
      suggestedTransforms: [{ transform: 'setBassRhythm', rhythm: 'x ~ x ~ x ~ x ~' }],
    });
  }

  // --- тональность ---
  if (metrics.scaleFit !== null && metrics.scaleFit < LINT_THRESHOLDS.minScaleFit) {
    const fit = bestFitMode(report);
    findings.push({
      code: 'notes-outside-scale',
      severity: 'error',
      params: { scaleFit: metrics.scaleFit, min: LINT_THRESHOLDS.minScaleFit },
      message:
        `Доля нот вне лада ${((1 - metrics.scaleFit) * 100).toFixed(0)} % — гармония рассыпается.`,
      suggestedTransforms: fit ? [{ transform: 'setMode', mode: fit.mode }] : [],
    });
  }

  // --- плотность ---
  if (metrics.density > thresholds.maxDensity) {
    findings.push({
      code: 'density-too-high',
      severity: 'error',
      params: { density: metrics.density, max: thresholds.maxDensity },
      message: `Плотность ${metrics.density.toFixed(1)} событий/с — выше ${thresholds.maxDensity}/с читается как каша.`,
      suggestedTransforms: [
        { transform: 'thin', role: 'hats', amount: 0.6 },
        { transform: 'thin', role: 'perc', amount: 0.6 },
      ],
    });
  }
  if (metrics.density < LINT_THRESHOLDS.minDensity) {
    findings.push({
      code: 'density-too-low',
      severity: 'warning',
      params: { density: metrics.density, min: LINT_THRESHOLDS.minDensity },
      message: `Плотность ${metrics.density.toFixed(2)} событий/с — трек почти пуст.`,
      suggestedTransforms: [{ transform: 'thicken', role: 'hats', amount: 0.5 }],
    });
  }

  // --- регистр ---
  const bassMax = report.registers?.bass?.max;
  if (Number.isFinite(bassMax) && bassMax > LINT_THRESHOLDS.maxBassMidi) {
    findings.push({
      code: 'bass-register-high',
      severity: 'warning',
      params: { maxMidi: bassMax, limit: LINT_THRESHOLDS.maxBassMidi },
      message: `Бас поднимается до MIDI ${bassMax} (выше c3) — уезжает в середину.`,
      suggestedTransforms: [{ transform: 'shiftRegister', role: 'bass', steps: -1 }],
    });
  }

  // --- механический тайминг ---
  // Ни одного смещения от сетки: трек «квадратный». Раньше здесь стояла
  // проверка одинаковой динамики, но она никогда не срабатывала: в шаблонах
  // грува динамика всегда разная, и мёртвое правило вводило в заблуждение.
  const std = metrics.microtiming?.stdMs ?? 0;
  if ((metrics.microtiming?.count ?? 0) > 0 && std < 0.5) {
    findings.push({
      code: 'timing-mechanical',
      severity: 'warning',
      params: { stdMs: std },
      message: 'Ни одного смещения от сетки: трек звучит механически, без микротайминга.',
      suggestedTransforms: [{ transform: 'setGroove', template: 'swing', options: { swing: 0.56 } }],
    });
  }

  return findings;
}

/** Секция, энергия которой дальше всего от целевой. */
function worstSectionByEnergy(metrics, sections) {
  if (!sections.length) return null;
  let worst = null;
  let worstGap = -1;
  for (const section of sections) {
    const measured = meanEnergyOfSection(metrics, section);
    const gap = Math.abs(measured - (section.energy ?? 0.5));
    if (gap > worstGap) {
      worstGap = gap;
      worst = section;
    }
  }
  return worst;
}

/** Средняя измеренная энергия секции по профилю по тактам. */
function meanEnergyOfSection(metrics, section) {
  const profile = metrics.energyProfile || [];
  const slice = profile.slice(section.startBar, section.endBar);
  if (!slice.length) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Лад, в который ноты трека попадают лучше всего.
 * Нужен линтеру: «ноты вне лада» — это не только вина тональности, иногда
 * лад выбран не тот.
 */
function bestFitMode(report) {
  const pitches = report.pitches || [];
  if (!pitches.length) return null;
  const counts = new Array(12).fill(0);
  for (const midi of pitches) counts[((midi % 12) + 12) % 12] += 1;
  let best = null;
  for (const [mode, intervals] of Object.entries(SCALES)) {
    for (let root = 0; root < 12; root += 1) {
      let hit = 0;
      for (let pc = 0; pc < 12; pc += 1) {
        if (intervals.includes((pc - root + 12) % 12)) hit += counts[pc];
      }
      const ratio = hit / pitches.length;
      if (!best || ratio > best.ratio + 1e-9) best = { mode, ratio };
    }
  }
  return best && best.ratio > 0.8 ? best : null;
}

/** Счёт: сколько ошибок, предупреждений и замечаний. */
export function lintSummary(findings) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
    total: findings.length,
  };
}
