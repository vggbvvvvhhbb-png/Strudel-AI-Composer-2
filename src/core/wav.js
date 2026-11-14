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

/**
 * Декодер 16-bit PCM WAV — обратная операция к encodeWav.
 *
 * Нужен режиму «Разбор»: сервер получает WAV из рендер-воркера и должен
 * считать по нему метрики тем же DSP, что и браузер (src/audio/dsp/*).
 *
 * Поддерживается только то, что мы сами кодируем: PCM 16-bit, 1 или 2 канала.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{channels: Float64Array[], sampleRate: number, frames: number}}
 */
export function decodeWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readTag = (offset) => String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
  if (readTag(0) !== 'RIFF' || readTag(8) !== 'WAVE') {
    throw new Error('Это не WAV-файл');
  }
  let offset = 12;
  let sampleRate = 44100;
  let numCh = 2;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const tag = readTag(offset);
    const size = view.getUint32(offset + 4, true);
    if (tag === 'fmt ') {
      numCh = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (tag === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(size, bytes.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('В WAV нет блока data');
  if (bitsPerSample !== 16) throw new Error('Поддерживается только PCM 16-bit, а не ' + bitsPerSample + ' бит');
  const bytesPerFrame = numCh * 2;
  const frames = Math.floor(dataSize / bytesPerFrame);
  const channels = [];
  for (let c = 0; c < numCh; c += 1) channels.push(new Float64Array(frames));
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const raw = view.getInt16(dataOffset + i * bytesPerFrame + c * 2, true);
      channels[c][i] = raw < 0 ? raw / 0x8000 : raw / 0x7fff;
    }
  }
  return { channels, sampleRate, frames };
}
