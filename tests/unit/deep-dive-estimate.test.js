// Честная оценка времени разбора.
//
// Проверяем не «число красивое», а ровно то, что обещано интерфейсу:
//   * верхняя граница считается по ХУДШЕМУ замеру (6.6 × realtime), а не по
//     лучшему — обещать быстрее, чем выходит, нельзя;
//   * для 4-минутного трека это 27 минут, а не «~15 минут»;
//   * округление вверх, до целых минут;
//   * «высокое качество» — отдельная оценка (22.3 × realtime), и она честно
//     помечена как один замер.

import { describe, it, expect } from 'vitest';

import {
  estimateDeepDive,
  formatEstimate,
  formatEstimateScope,
  formatStageRemaining,
  formatMinutes,
  formatRemaining,
  isKnownModel,
  resolveModel,
  remainingSeconds,
  SEPARATION_MODELS,
} from '../../src/deepdive/estimate.js';

describe('Оценка времени разбора', () => {
  it('для 4-минутного трека со стемами даёт 14–27 минут, а не «~15 минут»', () => {
    const estimate = estimateDeepDive({ durationS: 240, separate: true, model: 'htdemucs' });
    // 240 с × 6.6 = 1584 с = 26.4 мин → округление вверх до 27.
    expect(estimate.minutesMax).toBe(27);
    // 240 с × 3.45 = 828 с = 13.8 мин → 14.
    expect(estimate.minutesMin).toBe(14);
    expect(formatEstimate(estimate)).toBe('14–27 мин');
  });

  it('верхняя граница равна худшему замеру, а не среднему', () => {
    const estimate = estimateDeepDive({ durationS: 60, separate: true, model: 'htdemucs' });
    // Замеры: 207 / 341 / 396 с на 60 с аудио (3.45× / 5.7× / 6.6×).
    expect(estimate.secondsMax).toBeCloseTo(396, 6);
    expect(estimate.minutesMax).toBe(7);
    expect(estimate.factorMax).toBe(6.6);
  });

  it('округляет минуты вверх, а не вниз', () => {
    // 100 с аудио × 6.6 = 660 с = 11 мин ровно; берём трек, где дробь есть.
    const estimate = estimateDeepDive({ durationS: 101, separate: true, model: 'htdemucs' });
    expect(estimate.secondsMax).toBeCloseTo(666.6, 3);
    expect(estimate.minutesMax).toBe(12); // 11.11 мин → 12, не 11
  });

  it('«высокое качество» оценивается отдельно: ~90 минут на 4-минутный трек', () => {
    const estimate = estimateDeepDive({ durationS: 240, separate: true, model: 'htdemucs_ft' });
    expect(estimate.minutesMax).toBe(90); // 22.3 × 240 с = 89.2 мин → 90
    expect(formatEstimate(estimate)).toBe('90 мин');
    expect(estimate.basis).toContain('один прогон');
  });

  it('без разделения на стемы оценка мала и опирается на замер', () => {
    const estimate = estimateDeepDive({ durationS: 125, separate: false });
    expect(estimate.minutesMax).toBeLessThanOrEqual(2);
    expect(estimate.basis).toContain('59–73');
    expect(estimate.factorMax).toBeNull();
  });

  it('неизвестная длительность не даёт выдуманной оценки', () => {
    const estimate = estimateDeepDive({ durationS: 0, separate: true });
    expect(estimate.minutesMax).toBe(0);
    expect(estimate.secondsMax).toBe(0);
  });

  it('форматирование диапазона: одинаковые границы — одна цифра', () => {
    expect(formatMinutes(27, 27)).toBe('27 мин');
    expect(formatMinutes(14, 27)).toBe('14–27 мин');
    expect(formatMinutes(0, 0)).toBe('0 мин');
  });

  it('остаток считается от худшей оценки и не уходит в минус', () => {
    expect(remainingSeconds({ elapsedS: 60, secondsMax: 1584 })).toBe(1524);
    expect(remainingSeconds({ elapsedS: 2000, secondsMax: 1584 })).toBe(0);
    expect(formatRemaining(1524)).toBe('осталось ~26 мин');
    expect(formatRemaining(20)).toBe('осталось меньше минуты');
    expect(formatRemaining(0)).toBe('');
  });

  it('не называет время сепарации временем готового двойника', () => {
    const text = formatEstimateScope(estimateDeepDive({ durationS: 240, separate: true }));
    expect(text).toContain('Время сепарации: 14–27 мин');
    expect(text).toContain('без очереди и рендера двойника');
    expect(text).toContain('Полный результат: нет данных');
  });

  it('без стемов явно обозначает область экстраполяции', () => {
    const text = formatEstimateScope(estimateDeepDive({ durationS: 240 }));
    expect(text).toContain('экстраполяция замера 125 с');
    expect(text).toContain('время длинного двойника не гарантировано');
  });

  it.each([0, -1, -120])('при просроченной оценке %i не обещает меньше минуты', seconds => {
    expect(formatStageRemaining('Разделение', seconds)).toBe('Разделение — оценка превышена, этап продолжается');
  });

  it('неистёкшая оценка показывает текущий остаток', () => {
    expect(formatStageRemaining('Разделение', 20)).toBe('Разделение — осталось меньше минуты');
    expect(formatStageRemaining('Разделение', 120)).toBe('Разделение — осталось ~2 мин');
  });

  it('модель разделения ограничена белым списком', () => {
    expect(isKnownModel('htdemucs')).toBe(true);
    expect(isKnownModel('htdemucs_ft')).toBe(true);
    expect(isKnownModel('htdemucs_6s')).toBe(false);
    expect(isKnownModel('../../etc/passwd')).toBe(false);
    // Неизвестное имя не ломает расчёт: берётся обычная модель.
    expect(resolveModel('htdemucs_6s').id).toBe('htdemucs');
    expect(Object.keys(SEPARATION_MODELS)).toEqual(['htdemucs', 'htdemucs_ft']);
  });
});
