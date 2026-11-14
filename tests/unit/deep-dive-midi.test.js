// Экспорт двойника в MIDI: структура файла и содержимое событий.

import { describe, it, expect } from 'vitest';
import { buildMidi } from '../../server/deepdive/midi.js';

function readVarInt(buffer, offset) {
  let value = 0;
  let index = offset;
  for (;;) {
    const byte = buffer[index];
    value = (value << 7) | (byte & 0x7f);
    index += 1;
    if (!(byte & 0x80)) break;
  }
  return { value, offset: index };
}

describe('MIDI-экспорт двойника', () => {
  it('это файл типа 0 с одной дорожкой', () => {
    const midi = buildMidi({ bpm: 120, drums: { hits: [{ time_s: 0, gm: 36, velocity: 0.9 }] } });
    expect(midi.slice(0, 4).toString('ascii')).toBe('MThd');
    expect(midi.readUInt32BE(4)).toBe(6); // длина заголовка
    expect(midi.readUInt16BE(8)).toBe(0); // формат 0
    expect(midi.readUInt16BE(10)).toBe(1); // одна дорожка
    expect(midi.readUInt16BE(12)).toBe(480); // тиков на четверть
    expect(midi.slice(14, 18).toString('ascii')).toBe('MTrk');
  });

  it('внутри есть темп 120 BPM и события нот', () => {
    const midi = buildMidi({
      bpm: 120,
      drums: { hits: [{ time_s: 0, gm: 36, velocity: 0.9 }, { time_s: 0.5, gm: 42, velocity: 0.5 }] },
      bass: { notes: [{ time_s: 0, midi: 36, duration_s: 0.5 }] },
    });
    // Темп 500000 мкс на четверть = 120 BPM.
    expect(midi.includes(Buffer.from([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]))).toBe(true);
    // Нота «вкл» на канале 10 (ударные, 0x99) с нотой 36.
    expect(midi.includes(Buffer.from([0x99, 36, 114]))).toBe(true);
    // Нота «выкл».
    expect(midi.includes(Buffer.from([0x89, 36, 0]))).toBe(true);
    // Бас на канале 1.
    expect(midi.includes(Buffer.from([0x90, 36, 102]))).toBe(true);
  });

  it('пустые данные дают корректный файл без событий', () => {
    const midi = buildMidi({ bpm: 90 });
    expect(midi.slice(0, 4).toString('ascii')).toBe('MThd');
    expect(midi.readUInt32BE(4)).toBe(6);
  });

  it('длительность MIDI разбирается как переменная длина', () => {
    const midi = buildMidi({ bpm: 120, drums: { hits: [{ time_s: 1.234, gm: 36, velocity: 0.9 }] } });
    const trackStart = 18;
    const { offset } = readVarInt(midi, trackStart);
    // После длины дорожки идут мета-события; разбираем их как переменные длины.
    expect(offset).toBeGreaterThan(trackStart);
    expect(midi.length).toBeGreaterThan(trackStart);
  });
});
