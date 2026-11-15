// Детектор высоты тона: проверка на сигнале с известной частотой.
//
// Главный вопрос к этому модулю — один: «а он вообще находит правильную
// частоту?». Поэтому эталон здесь настоящий: синус заданной частоты, и
// ответ трекера должен совпасть с ней.

import { describe, expect, it } from 'vitest';
import { detectBassNotes, detectF0Track, notesFromFrames, toMono } from '../../src/audio/dsp/pitch.js';

const SAMPLE_RATE = 48000;

/** Синус заданной частоты и длительности. */
function sine(freq, seconds = 1, sampleRate = SAMPLE_RATE, amplitude = 0.5) {
  const length = Math.round(seconds * sampleRate);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return [out];
}

/** Синус с медленной амплитудной модуляцией — «живой» сигнал. */
function modulated(freq, seconds = 1, sampleRate = SAMPLE_RATE) {
  const length = Math.round(seconds * sampleRate);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const envelope = 0.5 * (1 + Math.sin(2 * Math.PI * 2 * t));
    out[i] = 0.4 * envelope * Math.sin(2 * Math.PI * freq * t);
  }
  return [out];
}

describe('детектор высоты тона', () => {
  it('находит частоту синуса 82.4 Гц (E2)', () => {
    const frames = detectF0Track(toMono(sine(82.4)), SAMPLE_RATE, { minFreq: 35, maxFreq: 500 });
    const voiced = frames.filter((frame) => frame.hz);
    expect(voiced.length).toBeGreaterThan(10);
    const average = voiced.reduce((sum, frame) => sum + frame.hz, 0) / voiced.length;
    // Допуск 1 % — это ±1.6 цента на 82.4 Гц.
    expect(Math.abs(average - 82.4) / 82.4).toBeLessThan(0.01);
  });

  it('находит частоту 55 Гц (A1) — нижний диапазон баса', () => {
    const frames = detectF0Track(toMono(sine(55)), SAMPLE_RATE, { minFreq: 35, maxFreq: 500 });
    const voiced = frames.filter((frame) => frame.hz);
    const average = voiced.reduce((sum, frame) => sum + frame.hz, 0) / voiced.length;
    expect(Math.abs(average - 55) / 55).toBeLessThan(0.02);
  });

  it('находит частоту 110 Гц (A2)', () => {
    const frames = detectF0Track(toMono(sine(110)), SAMPLE_RATE, { minFreq: 35, maxFreq: 500 });
    const voiced = frames.filter((frame) => frame.hz);
    const average = voiced.reduce((sum, frame) => sum + frame.hz, 0) / voiced.length;
    expect(Math.abs(average - 110) / 110).toBeLessThan(0.01);
  });

  it('не выдумывает частоту у тишины', () => {
    const silence = [new Float64Array(SAMPLE_RATE)];
    const frames = detectF0Track(toMono(silence), SAMPLE_RATE, { minFreq: 35, maxFreq: 500 });
    expect(frames.every((frame) => frame.hz === null)).toBe(true);
  });

  it('не выдумывает частоту у постоянного сигнала', () => {
    // Постоянный сигнал — нулевая дисперсия, корреляция не определена.
    const flat = [new Float64Array(SAMPLE_RATE).fill(0.4)];
    const frames = detectF0Track(toMono(flat), SAMPLE_RATE, { minFreq: 35, maxFreq: 500 });
    expect(frames.every((frame) => frame.hz === null)).toBe(true);
  });

  it('работает на модулированном сигнале', () => {
    const frames = detectF0Track(toMono(modulated(82.4)), SAMPLE_RATE, { minFreq: 35, maxFreq: 500 });
    const voiced = frames.filter((frame) => frame.hz);
    expect(voiced.length).toBeGreaterThan(5);
    const average = voiced.reduce((sum, frame) => sum + frame.hz, 0) / voiced.length;
    expect(Math.abs(average - 82.4) / 82.4).toBeLessThan(0.02);
  });

  it('различает соседние ноты: A2 (110 Гц) и B2 (123.47 Гц)', () => {
    const first = sine(110, 0.6);
    const second = sine(123.47, 0.6);
    const joined = new Float64Array(first[0].length + second[0].length);
    joined.set(first[0], 0);
    joined.set(second[0], first[0].length);
    const notes = detectBassNotes([joined], SAMPLE_RATE, { minFreq: 35, maxFreq: 500 });
    const midis = notes.map((note) => note.midi);
    // На стыке двух тонов окно анализа накрывает оба — трекер может дать
    // переходную ноту. Это честное поведение реального трекера, поэтому
    // проверяем главное: обе ноты опознаны, а лишняя — короткая.
    expect(midis).toContain(45); // A2
    expect(midis).toContain(47); // B2
    const transitional = notes.filter((note) => note.midi !== 45 && note.midi !== 47);
    for (const note of transitional) {
      expect(note.duration_s).toBeLessThan(0.12);
    }
  });

  it('пустой сигнал не роняет трекер', () => {
    expect(detectBassNotes([], SAMPLE_RATE)).toEqual([]);
    expect(detectBassNotes([new Float64Array(0)], SAMPLE_RATE)).toEqual([]);
  });

  it('ноты собираются из кадров с учётом уверенности', () => {
    const frames = [
      { time_s: 0, hz: 110, confidence: 0.9 },
      { time_s: 0.015, hz: 110, confidence: 0.8 },
      { time_s: 0.03, hz: null, confidence: 0 },
      { time_s: 0.045, hz: 220, confidence: 0.95 },
    ];
    // minDurationS: 0 — кадры в тесте идут с шагом 15 мс, то есть короче
    // реальной длительности ноты; фильтр длительности здесь отключён намеренно.
    const notes = notesFromFrames(frames, { minConfidence: 0.5, minFrames: 2, minDurationS: 0 });
    // Первая нота — два кадра, вторая — один (порог двух кадров её отбрасывает).
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(45);
  });
});
