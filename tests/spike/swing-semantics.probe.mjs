// Спайк: точная семантика swingBy.
//
// Измерение нужно, потому что скил-карты предписывают `.swingBy(.12, 8)`
// для хэтов, а первые пробы показали, что число событий меняется.
// Если свинг дублирует удары, карты нас обманут — и это надо зафиксировать.

import { runStrudel } from '../../server/music/strudel-runtime.mjs';

async function times(code, cycles = 1) {
  const result = await runStrudel(code, { cycles });
  if (!result.ok) return { error: result.error };
  const part = Object.values(result.parts)[0] || [];
  return {
    count: part.length,
    times: part.map((e) => Number(e.whole?.begin ?? 0)).sort((a, b) => a - b),
  };
}

const grid = '$H: s("hh*16")';
const variants = [
  ['без свинга', grid],
  ['swingBy(.12, 8)', `${grid}.swingBy(.12, 8)`],
  ['swingBy(.12, 4)', `${grid}.swingBy(.12, 4)`],
  ['swingBy(.12, 16)', `${grid}.swingBy(.12, 16)`],
  ['swing(.12)', `${grid}.swing(.12)`],
  ['swingBy(1/3, 8)', `${grid}.swingBy(1 / 3, 8)`],
  ['8-е: s("hh*8") без свинга', '$H: s("hh*8")'],
  ['8-е: swingBy(.12, 4)', '$H: s("hh*8").swingBy(.12, 4)'],
  ['16-е со своей сеткой: beat("0,2,4,6,8,10,12,14",16)', '$H: s("hh").beat("0,2,4,6,8,10,12,14",16)'],
  ['16-е со своей сеткой + swingBy(.12,8)', '$H: s("hh").beat("0,2,4,6,8,10,12,14",16).swingBy(.12, 8)'],
];

for (const [name, code] of variants) {
  const result = await times(code);
  console.log(`\n=== ${name}  →  ${code}`);
  if (result.error) {
    console.log(`  ОШИБКА: ${result.error}`);
    continue;
  }
  console.log(`  событий за такт: ${result.count}`);
  console.log(`  времена: ${result.times.map((t) => t.toFixed(4)).join(' ')}`);
}
