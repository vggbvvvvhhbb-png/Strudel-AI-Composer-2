// Детектор высоты тона по автокорреляции (YIN-подход).
//
// ЗАЧЕМ. Слой «бас» в разборе двойника сравнивал ноты оригинала с нотами
// оригинала же: обе стороны брались из питч-трека исходного трека, поэтому
// совпадение всегда было 100 %, а вес слоя — 30 % общей оценки. Метрика
// была постоянной величиной, то есть украшением.
//
// Теперь сторону двойника можно измерить по ЕГО стему: стем баса
// отрендерен, из него снимается питч-трек, и ноты сравниваются с
// измеренными нотами оригинала. Если питч снять не удалось — слой не
// публикуется вовсе («нет данных»), а не заменяется единицей.
//
// МЕТОД. Разностная функция d(τ) и нормированная кумулятивная d'(τ)
// (de Cheveigné & Kawahara, 2002, «YIN»), затем порог и параболическая
// интерполяция. Для баса сигнал сначала прореживается: частоты выше
// 500 Гц нам не нужны, а счётчик на низкой частоте считается в разы быстрее.

/** Порог нормированной разности: меньше — увереннее голос. */
const DEFAULT_THRESHOLD = 0.15;

/**
 * Свести каналы в один.
 * @param {Float64Array[]} channels
 * @returns {Float64Array}
 */
export function toMono(channels) {
  if (!channels?.length) return new Float64Array(0);
  const length = channels[0].length;
  const out = new Float64Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) out[i] += channel[i] ?? 0;
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i += 1) out[i] *= scale;
  return out;
}

/**
 * Прореживание сигнала: скользящее среднее + взятие каждого factor-го
 * отсчёта. Для низких частот этого достаточно — алиасинг на слух не слышен,
 * потому что всё, что выше 500 Гц, нам не нужно.
 * @param {Float64Array} signal
 * @param {number} factor
 * @returns {Float64Array}
 */
export function decimate(signal, factor) {
  if (factor <= 1) return signal;
  const outLength = Math.floor(signal.length / factor);
  const out = new Float64Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    let sum = 0;
    const start = i * factor;
    for (let j = 0; j < factor; j += 1) sum += signal[start + j] ?? 0;
    out[i] = sum / factor;
  }
  return out;
}

/**
 * Снять питч-трек с моно-сигнала.
 *
 * @param {Float64Array} mono моно-сигнал
 * @param {number} sampleRate частота дискретизации сигнала
 * @param {object} [options]
 * @param {number} [options.minFreq] нижняя граница поиска, Гц
 * @param {number} [options.maxFreq] верхняя граница поиска, Гц
 * @param {number} [options.threshold] порог уверенности (YIN)
 * @param {number} [options.frameMs] длина окна, мс
 * @param {number} [options.hopMs] шаг окна, мс
 * @returns {Array<{time_s:number, hz:number|null, confidence:number}>}
 */
export function detectF0Track(mono, sampleRate, options = {}) {
  const minFreq = options.minFreq ?? 35;
  const maxFreq = options.maxFreq ?? 500;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const frameMs = options.frameMs ?? 45;
  const hopMs = options.hopMs ?? 15;

  const frameSize = Math.max(8, Math.round((sampleRate * frameMs) / 1000));
  const hopSize = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(frameSize - 2, Math.floor(sampleRate / minFreq));
  if (maxLag <= minLag || mono.length < frameSize) return [];

  const difference = new Float64Array(maxLag + 1);
  const cmnd = new Float64Array(maxLag + 1);
  const frames = [];

  for (let start = 0; start + frameSize <= mono.length; start += hopSize) {
    difference[0] = 0;
    let runningSum = 0;
    for (let tau = 1; tau <= maxLag; tau += 1) {
      let sum = 0;
      for (let j = 0; j < frameSize - tau; j += 1) {
        const delta = mono[start + j] - mono[start + j + tau];
        sum += delta * delta;
      }
      difference[tau] = sum;
      runningSum += sum;
      cmnd[tau] = runningSum === 0 ? 1 : (sum * tau) / runningSum;
    }
    cmnd[0] = 1;

    // Абсолютный порог: первый локальный минимум ниже порога.
    let chosen = -1;
    for (let tau = minLag; tau < maxLag; tau += 1) {
      if (cmnd[tau] < threshold && cmnd[tau] <= cmnd[tau + 1]) {
        chosen = tau;
        break;
      }
    }
    if (chosen < 0) {
      // Порог не пройден — ищем глобальный минимум и проверяем его.
      let best = minLag;
      for (let tau = minLag + 1; tau < maxLag; tau += 1) {
        if (cmnd[tau] < cmnd[best]) best = tau;
      }
      chosen = cmnd[best] < threshold ? best : -1;
    }
    if (chosen < 0) {
      frames.push({ time_s: start / sampleRate, hz: null, confidence: 0 });
      continue;
    }

    // Параболическая интерполяция вокруг найденного минимума.
    const x0 = chosen > 0 ? cmnd[chosen - 1] : cmnd[chosen];
    const x1 = cmnd[chosen];
    const x2 = chosen < maxLag ? cmnd[chosen + 1] : cmnd[chosen];
    const denominator = 2 * (2 * x1 - x2 - x0);
    const shift = denominator === 0 ? 0 : (x2 - x0) / denominator;
    const refined = chosen + (Math.abs(shift) < 1 ? shift : 0);
    const hz = sampleRate / refined;
    frames.push({
      time_s: start / sampleRate,
      hz: hz >= minFreq && hz <= maxFreq ? Number(hz.toFixed(2)) : null,
      confidence: Number(Math.max(0, Math.min(1, 1 - x1)).toFixed(4)),
    });
  }

  return frames;
}

/**
 * Питч-трек → список нот.
 *
 * Соседние кадры с одной и той же высотой (в пределах полутона) объединяются
 * в ноту. Кадры без голоса (hz = null) разрывают ноту.
 *
 * Два фильтра против артефактов на границах нот:
 *   • нота короче minDurationS отбрасывается — на стыке двух нот окно
 *     анализа накрывает обе, и трекер может «услышать» третью;
 *   • высота ноты — МЕДИАНА частот её кадров, а не округление средней:
 *     округление до полутона добавляло бы до ±50 центов ошибки к
 *     измерению, а допуск сравнения нот как раз ±50 центов.
 *
 * @param {Array<{time_s:number, hz:number|null, confidence:number}>} frames
 * @param {object} [options]
 * @param {number} [options.minConfidence] минимальная уверенность кадра
 * @param {number} [options.minFrames] сколько кадров нужно, чтобы считать ноту
 * @param {number} [options.minDurationS] минимальная длительность ноты, с
 * @returns {Array<{time_s:number, midi:number, hz:number, confidence:number, duration_s:number}>}
 */
export function notesFromFrames(frames, options = {}) {
  const minConfidence = options.minConfidence ?? 0.6;
  const minFrames = options.minFrames ?? 2;
  const minDurationS = options.minDurationS ?? 0.06;
  const notes = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const duration = current.end - current.start;
    if (current.frames.length >= minFrames && duration >= minDurationS) {
      const frequencies = current.frames.map((frame) => frame.hz).sort((a, b) => a - b);
      const median = frequencies[Math.floor(frequencies.length / 2)];
      const confidences = current.frames.map((frame) => frame.confidence);
      notes.push({
        time_s: current.start,
        midi: Math.round(69 + 12 * Math.log2(median / 440)),
        hz: Number(median.toFixed(2)),
        confidence: Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(4)),
        duration_s: Number(duration.toFixed(3)),
      });
    }
    current = null;
  };

  for (const frame of frames) {
    if (!frame.hz || frame.confidence < minConfidence) {
      flush();
      continue;
    }
    const midi = Math.round(69 + 12 * Math.log2(frame.hz / 440));
    if (current && current.midi === midi) {
      current.frames.push(frame);
      current.end = frame.time_s;
    } else {
      flush();
      current = { midi, frames: [frame], start: frame.time_s, end: frame.time_s };
    }
  }
  flush();
  return mergeTails(notes, minDurationS);
}

/**
 * Склейка «хвостов» ноты.
 *
 * Затухание ноты тянется дольше самой ноты, и на малом сигнале трекер
 * слышит в хвосте чуть другую высоту: нота распадается на несколько
 * коротких кусков (например, A1 → хвост «A♭» через 0.2 с). Это не
 * отдельные ноты, это затухание той же.
 *
 * Правило: короткий кусок, отстоящий от предыдущей ноты не дальше чем
 * на два полутона и не дальше 0.4 с после неё, — часть предыдущей ноты.
 *
 * @param {Array<object>} notes ноты после группировки
 * @param {number} minDurationS порог «короткой» ноты
 * @returns {Array<object>}
 */
function mergeTails(notes, minDurationS) {
  const merged = [];
  for (const note of notes) {
    const previous = merged[merged.length - 1];
    const gap = previous ? note.time_s - (previous.time_s + previous.duration_s) : Infinity;
    if (
      previous
      && note.duration_s <= minDurationS + 0.005
      && Math.abs(note.midi - previous.midi) <= 2
      && gap >= 0
      && gap < 0.4
    ) {
      previous.duration_s = Number((note.time_s + note.duration_s - previous.time_s).toFixed(3));
      continue;
    }
    merged.push({ ...note });
  }
  return merged;
}

/**
 * Снять ноты с аудио слоя.
 *
 * @param {Float64Array[]} channels
 * @param {number} sampleRate
 * @param {object} [options] параметры detectF0Track и notesFromFrames
 * @returns {Array<{time_s:number, midi:number, confidence:number, duration_s:number}>}
 */
export function detectBassNotes(channels, sampleRate, options = {}) {
  if (!channels?.length || !sampleRate) return [];
  const targetRate = options.targetRate ?? 8000;
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  const mono = decimate(toMono(channels), factor);
  const frames = detectF0Track(mono, sampleRate / factor, options);
  return notesFromFrames(frames, options);
}
