// Измерительный рефайн поверх compose — «Учитель» (D-111).
//
// ЗАЧЕМ. Глубокие разборы треков учили только человека, читающего отчёт:
// измерение никуда не возвращалось, и генерация ничему не помогала. Этот
// модуль замыкает круг: спека → компиляция → рендер → измерение →
// типизированная правка → рендер → измерение.
//
// ПРАВИЛА. Решения принимает детерминированная таблица по измеренным
// дефицитам, а не модель: «код собирает компилятор, не модель». Порядок
// правил фиксирован (R1…R5), при равенстве дефицитов партии берутся по
// идентификатору (localeCompare('en'), как в listParts). В цикле LLM нет —
// значит, результат воспроизводится по seed.
//
// ЧЕСТНОСТЬ. «Нет данных» — это null, а не 0. Правило, для которого нет
// операции в реестре, не исполняется и помечается как долг (см. D-111):
// выдуманная операция сделала бы вид, что трек улучшен.
//
// ИМЯ ФАЙЛА. ТЗ называет `server/music/compose/refine.js`, но это имя уже
// занято существующим spec-level refine, контракт которого нельзя ломать.
// Поэтому модуль живёт здесь, а контракт (имена событий SSE, форма ответа)
// — как в ТЗ.

import { applyPartEdits } from '../../../src/music/part-edit.js';
import { listParts } from '../../../src/schemas/parts.js';
import { ACCEPTANCE } from '../../../src/audio/metrics-report.js';
import { compareRenders } from '../../../src/audio/render/offline.js';
import { trackTheme, voiceMotifMini, transposeMotif } from '../../../src/music/motif.js';
import { compileTrackSpec } from '../compiler/index.js';

/** Порог улучшения по нормированным метрикам: 0.01 = один процент шкалы. */
export const EPS = 0.01;

/** Допуск проекта на сравнение рендеров (D-104): не побайтово. */
export const RENDER_TOLERANCE = 1e-4;

/**
 * Коридор правила R5 (энтропия контура).
 *
 * КОРИДОР НЕ ОТКАЛИБРОВАН. Проект не содержит измеренных значений
 * энтропии контура, по которым можно было бы поставить границы, поэтому
 * правило R5 не исполняется: угадывать коридор — значит выдумывать
 * измерение. Правило включится, как только появится калибровка; долг
 * зафиксирован в D-111.
 */
export const R5_CORRIDOR = null;

/** Порог связности мотива, ниже которого тема не звучит в lead-партии. */
export const R4_COHERENCE_FLOOR = 0.5;

/**
 * Таблица правил v1. Порядок здесь — порядок исполнения.
 * @type {ReadonlyArray<{id:string, deficit:string, action:string, threshold:string, op:string|null}>}
 */
export const RULE_TABLE = Object.freeze([
  { id: 'R1', deficit: 'true peak', action: 'срезать громкость на 1 дБ', threshold: '> −1 dBTP', op: 'setGain' },
  { id: 'R2', deficit: 'громкость', action: 'поднять/опустить громкость пропорционально, шаг ≤ 1 дБ', threshold: 'LUFS-I вне −16…−12', op: 'setGain' },
  { id: 'R3', deficit: 'клиппинг', action: 'срезать на 2 дБ и перемерить', threshold: 'clipCount > 0', op: 'setGain' },
  { id: 'R4', deficit: 'связность мотива', action: 'применить тему трека к lead-партии', threshold: 'motifCoherence < 0.5', op: 'setPattern' },
  { id: 'R5', deficit: 'энтропия контура', action: 'регистровая правка lead', threshold: 'вне коридора', op: 'setPattern' },
  { id: 'R6', deficit: 'покрытие', action: 'не править, опубликовать coverage', threshold: 'покрытие неполное', op: null },
]);

/**
 * Приводит результат измерения к единой форме.
 * Всё, чего нет, — null. Ноль и «нет данных» — разные вещи.
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeMeasure(raw) {
  const source = raw ?? {};
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const pick = (...keys) => {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };
  const l0Raw = pick('l0');
  const l1Raw = pick('l1');
  const l0 = l0Raw && typeof l0Raw === 'object' ? num(l0Raw.score) : num(l0Raw);
  const l1 = l1Raw && typeof l1Raw === 'object' ? num(l1Raw.score) : num(l1Raw);
  return {
    l0,
    l1,
    coverage: pick('coverage') ?? null,
    truePeakDbtp: num(pick('truePeakDbtp', 'truePeakDbTP', 'truePeak')),
    lufsI: num(pick('lufsI', 'lufs')),
    clipCount: num(pick('clipCount', 'clipping')),
    motifCoherence: num(pick('motifCoherence')),
    contourEntropy: num(pick('contourEntropy')),
    notes: Array.isArray(source.notes) ? source.notes.slice() : [],
  };
}

/**
 * Разность двух измерений в нормированном виде (0..1).
 * @param {object} before
 * @param {object} after
 * @returns {object}
 */
export function measureDeltas(before, after) {
  const norm = (value) => (Number.isFinite(value) ? value / 100 : null);
  const delta = (a, b) => {
    const left = norm(a);
    const right = norm(b);
    if (left === null || right === null) return null;
    return Number((right - left).toFixed(6));
  };
  const out = {
    l0: delta(before?.l0 ?? null, after?.l0 ?? null),
    l1: delta(before?.l1 ?? null, after?.l1 ?? null),
  };
  const peak = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Number((b - a).toFixed(6));
  };
  out.truePeakDbtp = peak(before?.truePeakDbtp ?? null, after?.truePeakDbtp ?? null);
  out.lufsI = peak(before?.lufsI ?? null, after?.lufsI ?? null);
  out.clipCount = peak(before?.clipCount ?? null, after?.clipCount ?? null);
  return out;
}

/**
 * Техническое состояние в нормированном виде (0..1).
 *
 * Зачем не только «зелёный/не зелёный»: грубый признак не видит
 * прогресса. Пик 0.79 dBTP и пик −0.2 dBTP — оба «красные», но второй
 * ближе к норме, и цикл должен видеть, что движется в правильную сторону.
 * Поэтому три составляющие считаются раздельно и усредняются.
 *
 * Чего не измерили — того не считаем: неизвестная величина не входит в
 * среднее (иначе «нет данных» улучшало бы оценку).
 *
 * @param {object} measurement
 * @returns {number|null}
 */
export function technicalScore(measurement) {
  const m = measurement ?? {};
  const parts = [];
  const [low, high] = ACCEPTANCE.lufsCorridor;

  if (Number.isFinite(m.truePeakDbtp)) {
    const over = m.truePeakDbtp - ACCEPTANCE.truePeakCeilingDbtp;
    parts.push(over <= 0 ? 1 : Math.max(0, 1 - over / 6));
  }
  if (Number.isFinite(m.clipCount)) {
    parts.push(m.clipCount === 0 ? 1 : Math.max(0, 1 - m.clipCount / 1000));
  }
  if (Number.isFinite(m.lufsI)) {
    const distance = m.lufsI < low ? low - m.lufsI : m.lufsI > high ? m.lufsI - high : 0;
    parts.push(distance === 0 ? 1 : Math.max(0, 1 - distance / 6));
  }
  if (!parts.length) return null;
  return Number((parts.reduce((sum, value) => sum + value, 0) / parts.length).toFixed(6));
}

/**
 * L0 зелёный? Технические требования: пик в потолке, без клиппинга,
 * громкость в коридоре. Чего не измерили — того не требуем.
 *
 * @param {object} measurement
 * @returns {boolean}
 */
export function isL0Green(measurement) {
  const m = measurement ?? {};
  if (Number.isFinite(m.truePeakDbtp) && m.truePeakDbtp > ACCEPTANCE.truePeakCeilingDbtp) return false;
  if (Number.isFinite(m.clipCount) && m.clipCount > 0) return false;
  if (Number.isFinite(m.lufsI)) {
    const [low, high] = ACCEPTANCE.lufsCorridor;
    if (m.lufsI < low || m.lufsI > high) return false;
  }
  if (Number.isFinite(m.l0) && m.l0 < 80) return false;
  return true;
}

/**
 * Партии, которые реально звучат: с непустым списком секций.
 * Порядок детерминированный — по идентификатору.
 *
 * @param {object} spec
 * @returns {Array<{id:string, role:string|null}>}
 */
export function activeParts(spec) {
  return listParts(spec?.parts ?? {}).filter((item) => {
    const activeIn = item.part?.activeIn;
    return Array.isArray(activeIn) && activeIn.length > 0;
  });
}

/**
 * Lead-партия: роль lead, иначе первая тональная партия по идентификатору.
 * @param {object} spec
 * @returns {{id:string, role:string|null}|null}
 */
export function leadPart(spec) {
  const parts = listParts(spec?.parts ?? {});
  return parts.find((item) => item.role === 'lead')
    ?? parts.find((item) => item.role && !['kick', 'snare', 'hats', 'perc', 'fx'].includes(item.role))
    ?? null;
}

/**
 * Амплитуда партии, когда эффект gain не задан.
 *
 * ИЗМЕРЕНО 16.11.2026 (рендер одной партии, RMS, движок проекта):
 *   без gain      → −19.55 дБ
 *   .gain(1)      → −17.61 дБ
 *   .gain(0.7943) → −19.61 дБ
 *
 * То есть «без gain» — это амплитуда ≈ 0.7943 (−2 дБ), а .gain(x) задаёт
 * амплитуду буквально. Отсюда: шаг правила в дБ считается от 0.7943, а не
 * от единицы. Иначе первый шаг оказывается на 2 дБ громче задуманного, и
 * на замере это выглядело как «правка не помогает».
 */
export const DEFAULT_PART_GAIN = 0.7943;

/**
 * Текущая громкость партии в дБ.
 *
 * Операция setGain задаёт громкость АБСОЛЮТНО (в дБ), поэтому шаг правила
 * («срезать на 1 дБ») нужно считать от текущего значения, а не от нуля.
 * Без этого вторая итерация просто переписывала бы первую тем же числом —
 * цикл вращался, а звук не менялся (измерено 16.11.2026: пик 0.79 → 0.16
 * dBTP за две итерации вместо ожидаемых −2 dБ).
 *
 * @param {object} part
 * @returns {number} громкость в дБ
 */
export function currentGainDb(part) {
  const effect = (part?.effects ?? []).find((item) => item.name === 'gain');
  const linear = Number(effect?.params?.[0]);
  if (!Number.isFinite(linear) || linear <= 0) {
    return Number((20 * Math.log10(DEFAULT_PART_GAIN)).toFixed(4));
  }
  return Number((20 * Math.log10(linear)).toFixed(4));
}

/**
 * Операция «изменить громкость на N дБ» для всех активных партий.
 * Это эквивалент правки мастер-шины: в TrackSpec отдельного мастера нет,
 * а микс — это сумма партий, поэтому ровная добавка по всем активным
 * партиям меняет микс ровно на столько же, сколько мастер-трим.
 *
 * @param {object} spec
 * @param {number} deltaDb изменение в дБ (отрицательное — тише)
 * @returns {Array<object>}
 */
function gainOps(spec, deltaDb) {
  return activeParts(spec).map((item) => {
    const target = currentGainDb(item.part) + Number(deltaDb);
    return {
      id: item.id,
      op: 'setGain',
      params: { gainDb: Number(target.toFixed(2)) },
    };
  });
}

/**
 * Тема трека → мини-нотация для lead-партии.
 * @param {{seed:number, style:string}} options
 * @returns {string}
 */
function leadThemePattern({ seed, style }) {
  const theme = trackTheme({ seed, style });
  return voiceMotifMini({ group: 'lead', seed, style, voiceIndex: 0, variantIndex: 0, theme });
}

/**
 * Регистровая правка lead: тема, сдвинутая на полутон.
 * @param {{seed:number, style:string}} options
 * @param {number} delta
 * @returns {string}
 */
function shiftedLeadPattern({ seed, style }, delta) {
  const theme = transposeMotif(trackTheme({ seed, style }), delta);
  return voiceMotifMini({ group: 'lead', seed, style, voiceIndex: 0, variantIndex: 0, theme });
}

/**
 * Решение: какое правило срабатывает и что именно делать.
 * Возвращает null, если ни одно правило не применимо.
 *
 * @param {object} options
 * @returns {{rule:string, op:object|Array, reason:string, targetId:string|null}|null}
 */
export function decideEdit({ spec, measurement, seed, style, appliedRules = {} }) {
  const m = measurement ?? {};
  const context = { seed: Number(seed ?? 1), style: String(style ?? 'cinematic') };

  // R1 — пик выше потолка. Повторять правило можно не больше двух раз.
  if (Number.isFinite(m.truePeakDbtp) && m.truePeakDbtp > ACCEPTANCE.truePeakCeilingDbtp
    && (appliedRules.R1 ?? 0) < 2) {
    return {
      rule: 'R1',
      op: gainOps(spec, -1),
      reason: `пик ${m.truePeakDbtp} dBTP выше потолка ${ACCEPTANCE.truePeakCeilingDbtp} dBTP`,
      targetId: null,
    };
  }

  // R2 — громкость вне коридора. Шаг не больше 1 дБ, знак — в сторону
  // цели приёмки, а не ближайшего края коридора: иначе трек остаётся
  // ровно на границе (−16.004 вместо −16) и правило снова срабатывает.
  if (Number.isFinite(m.lufsI)) {
    const [low, high] = ACCEPTANCE.lufsCorridor;
    if (m.lufsI < low || m.lufsI > high) {
      const toward = ACCEPTANCE.targetLufs - m.lufsI;
      const step = Math.max(-1, Math.min(1, toward));
      return {
        rule: 'R2',
        op: gainOps(spec, step),
        reason: `громкость ${m.lufsI} LUFS-I вне коридора ${low}…${high}`,
        targetId: null,
      };
    }
  }

  // R3 — клиппинг: правило обязательное, после него обязателен перезамер.
  if (Number.isFinite(m.clipCount) && m.clipCount > 0) {
    return {
      rule: 'R3',
      op: gainOps(spec, -2),
      reason: `клиппинг: ${m.clipCount} сэмплов`,
      targetId: null,
    };
  }

  // R4 — lead не несёт тему трека.
  if (Number.isFinite(m.motifCoherence) && m.motifCoherence < R4_COHERENCE_FLOOR) {
    const lead = leadPart(spec);
    if (lead) {
      return {
        rule: 'R4',
        op: [{ id: lead.id, op: 'setPattern', params: { pattern: leadThemePattern(context) } }],
        reason: `связность мотива ${m.motifCoherence} ниже ${R4_COHERENCE_FLOOR} — тема не звучит в lead`,
        targetId: lead.id,
      };
    }
  }

  // R5 — энтропия контура вне коридора. Коридор не откалиброван: правило
  // не исполняется, чтобы не выдумывать измерение (долг в D-111).
  if (Number.isFinite(m.contourEntropy) && R5_CORRIDOR) {
    const [low, high] = R5_CORRIDOR;
    if (m.contourEntropy < low || m.contourEntropy > high) {
      const lead = leadPart(spec);
      if (lead) {
        const delta = m.contourEntropy > high ? -2 : 2;
        return {
          rule: 'R5',
          op: [{ id: lead.id, op: 'setPattern', params: { pattern: shiftedLeadPattern(context, delta) } }],
          reason: `энтропия контура ${m.contourEntropy} вне коридора ${low}…${high}`,
          targetId: lead.id,
        };
      }
    }
  }

  return null;
}

/**
 * Стандартное применение операции: типизированные правки по id из реестра
 * D-105/D-106 (src/music/part-edit.js). Вне реестра операция отвергается.
 *
 * @param {object} spec
 * @param {object|Array} op
 * @returns {object|null} новая спека или null, если правка отвергнута
 */
export function defaultApplyOp(spec, op) {
  const edits = Array.isArray(op) ? op : [op];
  if (!edits.length) return null;
  const result = applyPartEdits(spec, edits);
  return result.ok ? result.spec : null;
}

/**
 * Сравнение двух рендеров по допуску проекта (D-104), а не побайтово.
 * @param {object} a
 * @param {object} b
 * @returns {{maxAbsDiff:number|null, changed:boolean|null}}
 */
export function compareRenderFingerprints(a, b) {
  const channelsA = a?.channels;
  const channelsB = b?.channels;
  if (Array.isArray(channelsA) && Array.isArray(channelsB)) {
    const { maxAbsDiff } = compareRenders(channelsA, channelsB);
    return { maxAbsDiff, changed: maxAbsDiff > RENDER_TOLERANCE };
  }
  const fa = a?.fingerprint ?? null;
  const fb = b?.fingerprint ?? null;
  if (!fa || !fb) return { maxAbsDiff: null, changed: null };
  const same = JSON.stringify(fa) === JSON.stringify(fb);
  return { maxAbsDiff: null, changed: !same };
}

/**
 * Измерительный рефайн поверх compose.
 *
 * @param {object} options
 * @param {object} options.spec валидная TrackSpec
 * @param {string} options.code результат компиляции спеки
 * @param {number} options.seed зерно детерминизма
 * @param {Function} options.render (code, {bars, bpm, seed}) => {wavPath, metrics, fingerprint}
 * @param {Function} options.measure (wavPath, spec) => {l0, l1, coverage}
 * @param {Function} [options.applyOp] (spec, op) => newSpec
 * @param {number} [options.maxIterations]
 * @param {number} [options.budgetMs]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onEvent] колбэк SSE-события
 * @returns {Promise<object>}
 */
export async function refineComposed({
  spec,
  code,
  seed = 1,
  render,
  measure,
  applyOp = defaultApplyOp,
  maxIterations = 2,
  budgetMs = 120_000,
  signal,
  onEvent,
  bars = 16,
  bpm = null,
} = {}) {
  const startedAt = Date.now();
  const emit = (type, payload) => {
    if (typeof onEvent === 'function') onEvent(type, payload);
  };

  const style = String(spec?.meta?.style ?? 'cinematic');
  let currentSpec = spec;
  let currentCode = code;

  emit('refine_start', { seed, bars, bpm: bpm ?? spec?.meta?.bpm ?? null, style });

  const renderAndMeasure = async (currentSpecValue, currentCodeValue, label) => {
    const rendered = await render(currentCodeValue, { bars, bpm, seed });
    emit(label === 'first' ? 'rendered' : 'rerendered', {
      label,
      fingerprint: rendered?.fingerprint ?? null,
      wavPath: rendered?.wavPath ?? null,
    });
    const measured = normalizeMeasure(await measure(rendered?.wavPath ?? null, currentSpecValue));
    emit('measured', { label, ...measured });
    return { rendered, measured };
  };

  const first = await renderAndMeasure(currentSpec, currentCode, 'first');
  const before = first.measured;
  const fingerprintBefore = first.rendered?.fingerprint ?? null;
  const technicalBefore = technicalScore(before);

  const iterations = [];
  const appliedRules = {};
  let stoppedBy = 'already-green';
  let after = before;
  let fingerprintAfter = fingerprintBefore;
  let consecutiveWithoutGain = 0;

  const goalReached = (base, current) => {
    if (!isL0Green(current)) return false;
    if (!Number.isFinite(base?.l1) || !Number.isFinite(current?.l1)) return true;
    return current.l1 >= base.l1;
  };
  if (!goalReached(before, before)) {
    stoppedBy = 'max-iterations';
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (signal?.aborted) {
        stoppedBy = 'abort';
        break;
      }
      if (Date.now() - startedAt >= budgetMs) {
        stoppedBy = 'budget';
        break;
      }

      const decision = decideEdit({
        spec: currentSpec,
        measurement: after,
        seed,
        style,
        appliedRules,
      });
      if (!decision) {
        stoppedBy = 'no-rule';
        break;
      }

      const nextSpec = applyOp(currentSpec, decision.op);
      if (!nextSpec) {
        iterations.push({ iteration, rule: decision.rule, applied: false, reason: 'операция отвергнута реестром' });
        stoppedBy = 'rejected-op';
        break;
      }

      const nextCode = compileSpecSafely(nextSpec);
      if (!nextCode) {
        iterations.push({ iteration, rule: decision.rule, applied: false, reason: 'исправленная спека не компилируется' });
        stoppedBy = 'rejected-op';
        break;
      }

      appliedRules[decision.rule] = (appliedRules[decision.rule] ?? 0) + 1;
      emit('edit_applied', {
        op: decision.rule,
        targetId: decision.targetId,
        params: Array.isArray(decision.op) ? decision.op : [decision.op],
        reason: decision.reason,
      });

      const step = await renderAndMeasure(nextSpec, nextCode, 'again');
      const deltas = measureDeltas(after, step.measured);
      const technicalBefore = technicalScore(after);
      const technicalAfter = technicalScore(step.measured);
      // Улучшение — по техническому состоянию: оно видно даже тогда, когда
      // грубый признак «зелёный/красный» ещё не сменился.
      const improved = technicalBefore !== null && technicalAfter !== null
        ? Number((technicalAfter - technicalBefore).toFixed(6))
        : null;

      iterations.push({
        iteration,
        rule: decision.rule,
        applied: true,
        reason: decision.reason,
        deltas,
      });

      // Правка не должна оставлять трек хуже, чем было: если стало хуже,
      // возвращаемся к предыдущей версии и останавливаемся. Иначе цикл
      // мог бы «улучшить» звук до худшего состояния.
      if (improved !== null && improved < 0) {
        iterations[iterations.length - 1].reverted = true;
        stoppedBy = 'worse';
        break;
      }

      currentSpec = nextSpec;
      currentCode = nextCode;
      after = step.measured;
      fingerprintAfter = step.rendered?.fingerprint ?? fingerprintAfter;

      if (improved !== null && improved >= EPS) {
        consecutiveWithoutGain = 0;
      } else {
        consecutiveWithoutGain += 1;
      }
      if (goalReached(before, after)) {
        stoppedBy = 'goal';
        break;
      }
      // Противоречие требований: пик и громкость тянут громкость в разные
      // стороны. Так бывает у материала с большим crest factor: пик в норме
      // достижим только при громкости ниже коридора (измерено 16.11.2026:
      // у библиотечного техно crest ≈ 19.7 дБ — потолок пика и коридор
      // LUFS недостижимы общей регулировкой). Тогда правила будут ходить
      // туда-обратно, и честнее сказать об этом, чем крутить цикл.
      if (appliedRules.R1 && appliedRules.R2) {
        stoppedBy = 'conflicting-constraints';
        break;
      }
      if (consecutiveWithoutGain >= 2) {
        stoppedBy = 'plateau';
        break;
      }
    }
  }

  const deltas = measureDeltas(before, after);
  const technicalAfter = technicalScore(after);
  deltas.technical = technicalBefore === null || technicalAfter === null
    ? null
    : Number((technicalAfter - technicalBefore).toFixed(6));
  const sound = compareRenderFingerprints(
    { fingerprint: fingerprintBefore },
    { fingerprint: fingerprintAfter },
  );

  const result = {
    spec: currentSpec,
    code: currentCode,
    iterations,
    before,
    after,
    deltas,
    stoppedBy,
    fingerprintBefore,
    fingerprintAfter,
    soundChanged: sound.changed,
    coverage: after?.coverage ?? null,
  };

  emit('refine_done', {
    before,
    after,
    deltas,
    iterations: iterations.length,
    stoppedBy,
  });

  return result;
}

/**
 * Компиляция спеки с честной ошибкой: некомпилируемая спека — это отказ
 * правки, а не исключение цикла.
 * @param {object} spec
 * @returns {string|null}
 */
function compileSpecSafely(spec) {
  try {
    return compileTrackSpec(spec);
  } catch {
    return null;
  }
}
