// Audio QA — приёмка рендера и машинночитаемые замечания.
//
// Каждое замечание имеет вид:
//   { code, severity, label, hint, params, suggestedCommands }
// где suggestedCommands — заготовки команд командной шины ({ type, payload }).
// Кнопка «Применить совет» и ассистент потребляют их напрямую, не разбирая
// текст: поэтому у замечания обязателен код и параметры.
//
// Проверки идут по MetricsReport (src/audio/metrics-report.js) — то есть по
// тому же, что увидит человек и по чему считается приёмка.

import { ACCEPTANCE } from './metrics-report.js';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

export const QA_CODES = {
  REPEATABILITY_FAILED: 'repeatability-failed',
  REPEATABILITY_UNKNOWN: 'repeatability-unknown',
  TRUE_PEAK_OVER: 'true-peak-over',
  CLIPPING: 'clipping',
  LUFS_ABOVE_CORRIDOR: 'lufs-above-corridor',
  LUFS_BELOW_CORRIDOR: 'lufs-below-corridor',
  SILENCE_HEAD: 'silence-head',
  SILENCE_TAIL: 'silence-tail',
  SILENCE_INTERNAL: 'silence-internal',
  PART_TOO_LOUD: 'part-too-loud',
  PART_SILENT: 'part-silent',
  CREST_LOW: 'crest-low',
  BAND_SKEW: 'band-skew',
};

const round = (x, n = 2) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(n)) : x);

/** Самая громкая партия по пику. */
function loudestPart(parts) {
  let best = null;
  for (const [id, part] of Object.entries(parts || {})) {
    if (!part || typeof part.peakDbfs !== 'number') continue;
    if (!best || part.peakDbfs > best.part.peakDbfs) best = { id, part };
  }
  return best;
}

/**
 * Проверяет отчёт и возвращает список замечаний.
 *
 * @param {object} report MetricsReport
 * @param {object} [options]
 * @param {object} [options.acceptance] коридоры приёмки
 * @param {object} [options.bandProfile] измеренные коридоры полос { [band]: [minDb, maxDb] }
 * @returns {Array<object>} замечания
 */
export function runAudioQa(report, { acceptance = ACCEPTANCE, bandProfile = null } = {}) {
  const findings = [];
  if (!report) return findings;

  // 1. Повторяемость: без неё автоматическая приёмка невозможна.
  if (report.repeatability && report.repeatability.passed === false) {
    findings.push({
      code: QA_CODES.REPEATABILITY_FAILED,
      severity: SEVERITY.ERROR,
      label: 'Рендер не повторяется',
      hint:
        `Два рендера разошлись на ${round(report.repeatability.lufsDeltaDb)} LU ` +
        `(порог ${acceptance.repeatabilityLufsDeltaDb}). Автоматический микс и приёмка по метрикам отключены — ` +
        'проверьте, нет ли в проекте недетерминированных элементов.',
      params: { lufsDeltaDb: report.repeatability.lufsDeltaDb, runs: report.repeatability.runs },
      suggestedCommands: [],
    });
  } else if (!report.repeatability) {
    // Рендер был один — повторяемость не измерена. Это не ошибка, но и не
    // основание считать трек принятым по метрикам.
    findings.push({
      code: QA_CODES.REPEATABILITY_UNKNOWN,
      severity: SEVERITY.WARNING,
      label: 'Повторяемость не измерена',
      hint:
        'Отчёт сделан по одному рендеру. Для автоматического микса и приёмки ' +
        'нужно два рендера и расхождение не больше ' +
        `${acceptance.repeatabilityLufsDeltaDb} LU.`,
      params: { runs: 1 },
      suggestedCommands: [],
    });
  }

  // 2. True peak выше потолка.
  if (typeof report.truePeakDbtp === 'number' && report.truePeakDbtp > acceptance.truePeakCeilingDbtp) {
    const over = round(report.truePeakDbtp - acceptance.truePeakCeilingDbtp);
    const loud = loudestPart(report.parts);
    const commands = [];
    if (loud) {
      commands.push({
        type: 'setMix',
        payload: { id: loud.id, patch: { gainDb: -Math.min(over, 6) } },
      });
    }
    commands.push({ type: 'setMaster', payload: { patch: { limiter: { ceilingDbtp: -1.5 } } } });
    findings.push({
      code: QA_CODES.TRUE_PEAK_OVER,
      severity: SEVERITY.ERROR,
      label: 'True peak выше потолка',
      hint:
        `True peak ${round(report.truePeakDbtp)} dBTP при потолке ${acceptance.truePeakCeilingDbtp} dBTP ` +
        `(превышение ${over} дБ).`,
      params: { truePeakDbtp: report.truePeakDbtp, overDb: over, ceilingDbtp: acceptance.truePeakCeilingDbtp },
      suggestedCommands: commands,
    });
  }

  // 3. Клиппинг.
  if (report.clipCount > 0) {
    const loud = loudestPart(report.parts);
    findings.push({
      code: QA_CODES.CLIPPING,
      severity: SEVERITY.ERROR,
      label: 'Клиппинг',
      hint: `${report.clipCount} отсчётов достигли полной шкалы.`,
      params: { clipCount: report.clipCount },
      suggestedCommands: loud
        ? [{ type: 'setMix', payload: { id: loud.id, patch: { gainDb: -3 } } }]
        : [],
    });
  }

  // 4. Интегральная громкость вне коридора.
  const [low, high] = acceptance.lufsCorridor;
  if (typeof report.lufsI === 'number' && report.lufsI > high) {
    const delta = round(report.lufsI - high);
    const loud = loudestPart(report.parts);
    findings.push({
      code: QA_CODES.LUFS_ABOVE_CORRIDOR,
      severity: SEVERITY.WARNING,
      label: 'Громкость выше коридора',
      hint: `LUFS-I ${round(report.lufsI)} при коридоре ${low}…${high}. Цель — ${acceptance.targetLufs} LUFS.`,
      params: { lufsI: report.lufsI, corridor: acceptance.lufsCorridor, deltaDb: delta },
      suggestedCommands: loud
        ? [{ type: 'setMix', payload: { id: loud.id, patch: { gainDb: -Math.min(delta, 6) } } }]
        : [],
    });
  }
  if (typeof report.lufsI === 'number' && report.lufsI < low) {
    const delta = round(low - report.lufsI);
    const loud = loudestPart(report.parts);
    findings.push({
      code: QA_CODES.LUFS_BELOW_CORRIDOR,
      severity: SEVERITY.WARNING,
      label: 'Громкость ниже коридора',
      hint: `LUFS-I ${round(report.lufsI)} при коридоре ${low}…${high}. Цель — ${acceptance.targetLufs} LUFS.`,
      params: { lufsI: report.lufsI, corridor: acceptance.lufsCorridor, deltaDb: delta },
      suggestedCommands: loud
        ? [{ type: 'setMix', payload: { id: loud.id, patch: { gainDb: Math.min(delta, 6) } } }]
        : [],
    });
  }

  // 5. Тишина.
  const silence = report.silence || {};
  if (silence.head > 0.5) {
    findings.push({
      code: QA_CODES.SILENCE_HEAD,
      severity: SEVERITY.WARNING,
      label: 'Тишина в начале',
      hint: `Первые ${round(silence.head)} с тихие — слушатель может решить, что трек не запустился.`,
      params: { seconds: silence.head },
      suggestedCommands: [],
    });
  }
  if (silence.tail > 0.5) {
    findings.push({
      code: QA_CODES.SILENCE_TAIL,
      severity: SEVERITY.WARNING,
      label: 'Тишина в конце',
      hint: `Последние ${round(silence.tail)} с тихие.`,
      params: { seconds: silence.tail },
      suggestedCommands: [],
    });
  }
  if (silence.internal > 1) {
    findings.push({
      code: QA_CODES.SILENCE_INTERNAL,
      severity: SEVERITY.WARNING,
      label: 'Тишина внутри трека',
      hint: `Внутри трека ${round(silence.internal)} с тишины подряд — больше одного такта.`,
      params: { seconds: silence.internal },
      suggestedCommands: [],
    });
  }

  // 6. Отдельные партии.
  for (const [id, part] of Object.entries(report.parts || {})) {
    if (!part) continue;
    if (typeof part.peakDbfs === 'number' && part.peakDbfs > acceptance.voicePeakDbfs) {
      const delta = round(part.peakDbfs - acceptance.voicePeakDbfs);
      findings.push({
        code: QA_CODES.PART_TOO_LOUD,
        severity: SEVERITY.WARNING,
        label: `Партия «${id}» слишком громкая`,
        hint: `Пик ${round(part.peakDbfs)} dBFS при ориентире ${acceptance.voicePeakDbfs} dBFS.`,
        params: { role: id, peakDbfs: part.peakDbfs, deltaDb: delta },
        suggestedCommands: [{ type: 'setMix', payload: { id, patch: { gainDb: -Math.min(delta, 6) } } }],
      });
    }
    if (part.lufsI === null || (typeof part.lufsI === 'number' && part.lufsI < -60)) {
      findings.push({
        code: QA_CODES.PART_SILENT,
        severity: SEVERITY.WARNING,
        label: `Партия «${id}» молчит`,
        hint: 'Партия не даёт звука в рендере.',
        params: { role: id },
        suggestedCommands: [],
      });
    }
  }

  // 7. Сжатость: слишком низкий crest — признак пересжатия.
  if (typeof report.crestDb === 'number' && report.crestDb < 6) {
    findings.push({
      code: QA_CODES.CREST_LOW,
      severity: SEVERITY.WARNING,
      label: 'Трек слишком сжат',
      hint: `Crest ${round(report.crestDb)} дБ — динамика почти выбрана.`,
      params: { crestDb: report.crestDb },
      suggestedCommands: [
        { type: 'setMaster', payload: { patch: { comp: { ratio: 2, thresholdDb: -22 } } } },
      ],
    });
  }

  // 8. Полосы вне измеренного профиля стиля (профиль появляется в фазе 4).
  if (bandProfile) {
    for (const [band, corridor] of Object.entries(bandProfile)) {
      const value = report.bands?.[band];
      if (typeof value !== 'number' || !Array.isArray(corridor)) continue;
      if (value < corridor[0] || value > corridor[1]) {
        findings.push({
          code: QA_CODES.BAND_SKEW,
          severity: SEVERITY.WARNING,
          label: `Полоса «${band}» вне профиля`,
          hint: `${round(value)} дБ при коридоре ${round(corridor[0])}…${round(corridor[1])} дБ.`,
          params: { band, valueDb: value, corridor },
          suggestedCommands: [],
        });
      }
    }
  }

  return findings;
}

/** Замечания, которые мешают приёмке (error), отдельно от предупреждений. */
export function splitFindings(findings) {
  const errors = findings.filter((f) => f.severity === SEVERITY.ERROR);
  const warnings = findings.filter((f) => f.severity !== SEVERITY.ERROR);
  return { errors, warnings };
}

/**
 * Годен ли рендер к приёмке.
 * @param {object} report
 * @returns {{passed:boolean, errors:Array<object>}}
 */
export function acceptancePassed(report, options = {}) {
  const { errors } = splitFindings(runAudioQa(report, options));
  return { passed: errors.length === 0, errors };
}
