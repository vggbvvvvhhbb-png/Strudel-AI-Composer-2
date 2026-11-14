// Символы, которые tonal в Strudel НЕ понимает: ищем рабочие записи.
//
// Измерено: `sus4`, `sus2`, `dim`, `m9b5`, `maj7` дают «unknown chord» и
// ПУСТОЙ аккорд — тихая поломка. Ищем, чем их заменить.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const SYMBOLS = [
  'Csus', 'Csus4', 'Csus2', 'C(no3)', 'C(no5)', 'C^7(no3)',
  'Cdim7', 'Cdim', 'C°', 'C-', 'Cm7b5', 'Cø', 'Caug', 'C+',
  'C5', 'C^5', 'C^7sus4', 'C7sus4',
  'C^9', 'C^13', 'C7b9', 'C7#9', 'C7b13', 'C9',
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
    `${symbol.padEnd(10)} ${String(events.length).padStart(2)} голос(ов): ${notes.join(' ') || '— (ПУСТО!)'}`,
  );
}
