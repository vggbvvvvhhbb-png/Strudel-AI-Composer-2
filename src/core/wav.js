// Чистый кодировщик 16-bit PCM WAV (без браузерных зависимостей — тестируется в Node).
export function encodeWav(channels, sampleRate) {
  const numCh = Math.max(1, channels.length);
  const len = channels[0]?.length || 0;
  const dataSize = len * numCh * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  wstr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c]?.[i] || 0;
      s = Math.max(-1, Math.min(1, s)); // клиппинг не даст переполниться int16
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return view.buffer;
}
