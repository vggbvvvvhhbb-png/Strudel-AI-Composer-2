// Замер времени разбора на проде: когда приходит паспорт и что с оценкой.
//
// ЗАЧЕМ. Отделить «красивый интерфейс» от честного: нужно увидеть, что
// измерения (темп, лад, громкость) приходят ЗАДО тяжёлого разделения на
// стемы, и что оценка времени совпадает с измеренным.
//
// ЗАПУСК:
//   node tests/spike/demo-track.probe.mjs .scratch/demo-4min.wav
//   node tests/spike/deepdive-timing.probe.mjs .scratch/demo-4min.wav \
//        https://music.34.88.114.146.sslip.io 1
//
// Аргументы: файл, базовый URL, separate (0|1).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const file = process.argv[2] || '.scratch/demo-4min.wav';
const base = (process.argv[3] || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const separate = (process.argv[4] ?? '1') === '1';

const buffer = await readFile(file);
const name = path.basename(file);
const started = Date.now();
const at = () => ((Date.now() - started) / 1000).toFixed(1);

const form = new FormData();
form.append('file', new Blob([buffer], { type: 'audio/wav' }), name);
form.append('separate', separate ? '1' : '0');
form.append('model', 'htdemucs');

console.log(`файл: ${name}, ${(buffer.length / 1024 / 1024).toFixed(1)} МБ, separate=${separate}`);

const res = await fetch(`${base}/api/deepdive/analyze`, { method: 'POST', body: form });
if (!res.ok || !res.body) {
  console.error('сервер ответил', res.status, await res.text());
  process.exit(1);
}

let jobId = null;
let passportAt = null;
const decoder = new TextDecoder();
let bufferText = '';

for await (const chunk of res.body) {
  bufferText += decoder.decode(chunk, { stream: true });
  const parts = bufferText.split('\n\n');
  bufferText = parts.pop() ?? '';
  for (const part of parts) {
    const line = part.split('\n').find((entry) => entry.startsWith('data:'));
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === 'job') {
      jobId = event.id;
      console.log(`t=${at()}s  job          id=${event.id}  ${event.permalink}`);
    } else if (event.type === 'stage') {
      const eta = event.eta ? `  eta=${event.eta.label} (${event.eta.seconds} с)` : '';
      console.log(`t=${at()}s  stage        ${event.stage} — ${event.label}${eta}`);
    } else if (event.type === 'passport') {
      passportAt = Number(at());
      const m = event.payload?.measurements ?? {};
      console.log(`t=${at()}s  PASSPORT     темп ${m.tempo?.bpm} BPM, лад ${m.key?.tonic} ${m.key?.mode}, `
        + `LUFS ${m.loudness?.lufs_integrated}, секций ${event.payload?.structure?.length ?? 0}`);
      console.log(`             оценка: ${event.estimate?.label} (${event.estimate?.minutesMin}–${event.estimate?.minutesMax} мин)`);
      console.log(`             основание: ${event.estimate?.basis}`);
    } else if (event.type === 'result') {
      console.log(`t=${at()}s  РЕЗУЛЬТАТ    permalink=${event.permalink ?? `/razbor/${event.payload?.track?.id}`}`);
      console.log(`             паспорт пришёл на t=${passportAt ?? '—'}s, результат на t=${at()}s`);
      console.log(`job_id=${event.payload?.track?.id ?? jobId}`);
    } else if (event.type === 'error') {
      console.log(`t=${at()}s  ОШИБКА       ${event.message}`);
      process.exitCode = 1;
    }
  }
}
