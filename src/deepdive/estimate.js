// Честная оценка времени разбора.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Оценку считают и сервер, и браузер: сервер — чтобы
// отдать её в потоке событий, браузер — чтобы показать её ДО первого ответа
// сервера (по длительности файла). Оба берут числа отсюда, чтобы оценка в
// интерфейсе и в отчёте не расходились.
//
// ЦИФРЫ — ИЗМЕРЕНИЯ на боевом стенде (2 vCPU, 3.8 ГБ RAM, GPU нет,
// docs/SESSION_REPORT.md §4):
//
//   htdemucs     60 с аудио → 207 / 341 / 396 с  (3.45× / 5.7× / 6.6× realtime)
//   htdemucs    240 с аудио → 1356 с             (5.65× realtime)
//   htdemucs_ft  60 с аудио → 1336 с             (22.3× realtime)
//
// Разброс по двум ядрам — в 1.9 раза. Поэтому планируем по ХУДШЕМУ замеру
// (6.6×), а не по лучшему: обещать быстрее, чем выходит, — это то же самое,
// что врать.
//
// ЧЕСТНОСТЬ. Ни одно обещание качества здесь не делается: оценка — про ВРЕМЯ,
// и только про время. «Стемы за 15 минут» — это обещание, которое на этом
// железе не сдерживается, поэтому его в интерфейсе нет.

/** Модели разделения и их измеренная цена во времени. */
export const SEPARATION_MODELS = {
  htdemucs: {
    id: 'htdemucs',
    label: 'Стандартное разделение',
    // Нижняя граница — лучший замер, верхняя — худший. Планируем по верхней.
    factorMin: 3.45,
    factorMax: 6.6,
    measured: 'замер: 60 с аудио → 207–396 с, 240 с аудио → 1356 с (2 vCPU)',
  },
  htdemucs_ft: {
    id: 'htdemucs_ft',
    label: 'Высокое качество (ночной режим)',
    // Один замер — диапазон не выдумываем: показываем ровно измеренное.
    factorMin: 22.3,
    factorMax: 22.3,
    measured: 'замер: 60 с аудио → 1336 с (2 vCPU), один прогон',
  },
};

export const DEFAULT_SEPARATION_MODEL = 'htdemucs';

/**
 * Разделение без стемов (паспорт + двойник по миксу).
 *
 * Замер на проде: трек 125 с — полный разбор 59–73 с. Отсюда модель:
 * база + доля от длительности аудио. Для длинных треков оценка растёт.
 */
const NO_STEMS_BASE_MIN_S = 40;
const NO_STEMS_BASE_MAX_S = 70;
const NO_STEMS_PER_SEC_S = 0.25;

function clampDuration(durationS) {
  const n = Number(durationS);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/** Модель разделения по имени; неизвестное имя — обычная модель. */
export function resolveModel(model) {
  const key = String(model || DEFAULT_SEPARATION_MODEL);
  return SEPARATION_MODELS[key] ?? SEPARATION_MODELS[DEFAULT_SEPARATION_MODEL];
}

/** Имя модели приходит из формы — приводим к белому списку. */
export function isKnownModel(model) {
  return Object.hasOwn(SEPARATION_MODELS, String(model || ''));
}

/**
 * Оценка времени разбора.
 *
 * @param {{durationS?:number, separate?:boolean, model?:string}} params
 * @returns {{
 *   separate: boolean, model: string, durationS: number,
 *   secondsMin: number, secondsMax: number,
 *   minutesMin: number, minutesMax: number,
 *   factorMax: number|null, basis: string
 * }}
 */
export function estimateDeepDive({ durationS = 0, separate = false, model = DEFAULT_SEPARATION_MODEL } = {}) {
  const duration = clampDuration(durationS);
  const resolved = resolveModel(model);

  if (!separate) {
    const secondsMin = NO_STEMS_BASE_MIN_S + NO_STEMS_PER_SEC_S * duration;
    const secondsMax = NO_STEMS_BASE_MAX_S + NO_STEMS_PER_SEC_S * duration;
    return {
      separate: false,
      model: resolved.id,
      durationS: duration,
      secondsMin,
      secondsMax,
      minutesMin: Math.ceil(secondsMin / 60),
      minutesMax: Math.ceil(secondsMax / 60),
      factorMax: null,
      basis: 'замер: трек 125 с без разделения — полный разбор 59–73 с',
    };
  }

  const secondsMin = duration * resolved.factorMin;
  const secondsMax = duration * resolved.factorMax;
  return {
    separate: true,
    model: resolved.id,
    durationS: duration,
    secondsMin,
    secondsMax,
    minutesMin: Math.ceil(secondsMin / 60),
    minutesMax: Math.ceil(secondsMax / 60),
    factorMax: resolved.factorMax,
    basis: resolved.measured,
  };
}

/** «2–3 мин» — если границы совпали, одна цифра. */
export function formatMinutes(minutesMin, minutesMax) {
  const min = Math.max(0, Math.round(Number(minutesMin) || 0));
  const max = Math.max(0, Math.round(Number(minutesMax) || 0));
  if (max <= min) return `${min} мин`;
  return `${min}–${max} мин`;
}

/** Готовая строка оценки по объекту estimateDeepDive. */
export function formatEstimate(estimate) {
  if (!estimate) return '—';
  return formatMinutes(estimate.minutesMin, estimate.minutesMax);
}

/** «осталось ~12 мин» — по остатку в секундах. */
export function formatRemaining(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 60) return 'осталось меньше минуты';
  return `осталось ~${Math.ceil(n / 60)} мин`;
}

/**
 * Остаток по факту: сколько секунд ещё ждать, если известно, сколько
 * этап идёт и сколько он должен занять в худшем случае.
 */
export function remainingSeconds({ elapsedS = 0, secondsMax = 0 } = {}) {
  const left = Number(secondsMax) - Number(elapsedS);
  return Number.isFinite(left) && left > 0 ? left : 0;
}
