// Проверка аккордовых символов tonal: какие суффиксы движок понимает.
//
// Карты гармонии используют обозначения `^7`, `^9`, `m9`, `7b13`, `13`,
// `6`, `add9`. Если хоть одно из них движок не разбирает, аккорд молча
// превратится в ноту — а это тихая поломка жанра. Проверяем списком.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const SYMBOLS = [
  'C', 'Dm', 'Bb', 'Gm', 'A', 'Eb', 'Cm', 'Ab', 'F', 'G',
  'Dm9', 'Bb^7', 'Gm7', 'A7b13', 'Eb^9', 'Cm9', 'Ab^9', 'Bb13',
  'C^9', 'F^9', 'Am9', 'Gadd9', 'G13', 'Am7', 'F^7', 'C^7', 'G6',
  'Fm9', 'Db^9', 'Eb9', 'Cadd9', 'Dsus4', 'Csus2', 'Bdim', 'Ddim',
  'Eb^9/2', 'Dm9b5', 'Cmaj7', 'CM7', 'C^7b9',
];

for (const symbol of SYMBOLS) {
  const code = `$C: chord("${symbol}").voicing().anchor("c4")`;
  const result = await runStrudel(code, { cycles: 1 });
  if (!result.ok) {
    console.log(`${symbol.padEnd(10)} ОШИБКА: ${result.error}`);
    continue;
  }
  const events = result.parts.C || [];
  const notes = events.map((e) => e.value?.note).filter(Boolean);
  console.log(
    `${symbol.padEnd(10)} ${events.length} голос(ов): ${notes.join(' ') || '— (ПУСТО!)'}`,
  );
}
