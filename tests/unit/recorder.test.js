import { describe, expect, it } from 'vitest';
import { encodeWav } from '../../src/core/wav.js';

describe('encodeWav', () => {
  it('заголовок RIFF/WAVE: частота, каналы, размер данных', () => {
    const sr = 48000;
    const l = new Float32Array(sr); const r = new Float32Array(sr);
    const buf = encodeWav([l, r], sr);
    const view = new DataView(buf);
    const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(str(36, 4)).toBe('data');
    expect(view.getUint32(24, true)).toBe(sr);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(40, true)).toBe(sr * 2 * 2);
    expect(buf.byteLength).toBe(44 + sr * 2 * 2);
  });

  it('значения сэмплов пишутся верно и клиппинг не переполняет int16', () => {
    const data = new Float32Array([0, 0.5, -0.5, 2, -2]);
    const view = new DataView(encodeWav([data], 44100));
    const at = (i) => view.getInt16(44 + i * 2, true);
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(16383); // 0.5*0x7fff = 16383.5, усечение при записи int16
    expect(at(3)).toBe(0x7fff); // +2 зажат в максимум
    expect(at(4)).toBe(-0x8000);
  });
});
