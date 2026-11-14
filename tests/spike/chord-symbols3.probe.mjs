// Проверка тех символов, которые ЭМИТАЕТ компилятор IR.
//
// harmony.js собирает символы по правилам:
//   minor + sus   → «Dsus»
//   minor + add9  → «Dmadd9»
//   minor + 7     → «Dm7»
//   major + sus   → «Dsus»
//   major + add9  → «Dadd9»
//   major + 7     → «D7»
//   maj7          → «D^7»
//
// «Dsus» и «Dmadd9» в предыдущих пробах НЕ проверялись. Если движок их не
// понимает, аккорд молча исчезает — а трек теряет половину гармонии.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const SYMBOLS = [
  // То, что реально эмитит компилятор.
  'Dsus', 'Dmadd9', 'Dm7', 'Dadd9', 'D7', 'D^7', 'Dm', 'D',
  'Ebadd9', 'Fmadd9', 'Gmadd9', 'Abadd9', 'Bbadd9', 'Cadd9',
  'Ebsus', 'Fmsus', 'Gmsus', 'Csus', 'Asus',
  // Альтернативы, если sus/add9 не поддержаны.
  'Dsus4', 'Dm(no5)', 'Dm9', 'D(no3)', 'Dm6',
];

for (const symbol of SYMBOLS) {
  const result = await runStrudel(`$C: chord("${symbol}").voicing().anchor("c4")`, { cycles: 1 });
  if (!result.ok) {
    console.log(`${symbol.padEnd(10)} ОШИБКА: ${result.error}`);
    continue;
  }
  const events = result.parts.C || [];
  const notes = events.map((e) => e.value?.note).filter(Boolean);
  console.log(`${symbol.padEnd(10)} ${String(events.length).padStart(2)} голос(ов): ${notes.join(' ') || '— (ПУСТО!)'}`);
}
