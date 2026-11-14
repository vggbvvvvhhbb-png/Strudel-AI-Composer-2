// Имена сэмплов, разрешённые промптом, должны существовать в банках.
//
// Сэмпл, которого нет в манифесте, не играет: движок пишет «sound oh not found!».
// Раньше промпт разрешал `oh` и `sh`, которых в dirt-samples нет — модель могла
// выдать партию без звука, и это было видно только на слух.
//
// Список имён банков вендорен (server/music/data/sample-banks.json),
// обновляется скриптом `npm run sync:samples`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GM_TO_SAMPLE,
  DRUM_SAMPLE_NAMES,
  sampleNameForHit,
} from '../../server/deepdive/transpiler/samples.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

const read = (relative) => readFileSync(join(root, relative), 'utf8');

const banks = JSON.parse(read('server/music/data/sample-banks.json'));
const available = new Set(Object.values(banks.banks).flatMap((bank) => bank.names));

/** Имена из строки промпта: и в бэктиках, и простым списком через запятую. */
function namesInLine(text, marker) {
  const line = text
    .split('\n')
    .find((l) => l.includes(marker));
  if (!line) throw new Error(`в промпте не найдена строка с «${marker}»`);
  // Имя сэмпла — только строчные буквы и цифры; `.bank(...)` и `samples(...)` — не имена.
  const backticked = [...line.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((n) => /^[a-z0-9]+$/.test(n));
  if (backticked.length > 0) return backticked;
  // Список без бэктиков: «bd, sd, hh, …, piano и т.п.»
  const segment = line.slice(line.indexOf(marker) + marker.length).split('и т.п.')[0];
  return [...segment.matchAll(/[a-z0-9]+/g)].map((m) => m[0]);
}

describe('доступность сэмплов из промптов', () => {
  it('банки вендорены и непусты', () => {
    expect(Object.keys(banks.banks).length).toBeGreaterThanOrEqual(2);
    expect(available.size).toBeGreaterThan(100);
    expect(available.has('bd')).toBe(true);
    expect(available.has('piano')).toBe(true);
  });

  it('все имена из system.md есть в банках', () => {
    const names = namesInLine(read('server/prompts/system.md'), 'Рабочие имена:');
    expect(names.length).toBeGreaterThan(20);
    const missing = names.filter((name) => !available.has(name));
    expect(missing, `имена без сэмплов: ${missing.join(', ')}`).toEqual([]);
  });

  it('все имена из critic.md есть в банках', () => {
    const names = namesInLine(read('server/prompts/critic.md'), 'Сэмплы — только из списка:');
    expect(names.length).toBeGreaterThan(5);
    const missing = names.filter((name) => !available.has(name));
    expect(missing, `имена без сэмплов: ${missing.join(', ')}`).toEqual([]);
  });

  it('имена, которых нет в банках, запрещены явно', () => {
    // oh и sh отсутствуют в dirt-samples — именно из-за них партия могла звучать
    // в пустоту. Если их вернут в промпт, тест выше это поймает.
    expect(available.has('oh')).toBe(false);
    expect(available.has('sh')).toBe(false);
  });
});

describe('сэмплы транспилятора разбора', () => {
  // Сэмпл, которого нет в банке, не просто молчит: движок бросает
  // «sound <имя> not found!» и рендер двойника падает целиком. Поэтому
  // справочник GM → сэмпл сверяется с реестром банков, а не «на глаз».
  it('каждое имя из GM_TO_SAMPLE есть в банках', () => {
    const missing = Object.values(GM_TO_SAMPLE).filter((name) => !available.has(name));
    expect(missing, `имён без сэмплов: ${missing.join(', ')}`).toEqual([]);
  });

  it('каждое имя из DRUM_SAMPLE_NAMES есть в банках', () => {
    const missing = [...DRUM_SAMPLE_NAMES].filter((name) => !available.has(name));
    expect(missing, `имён без сэмплов: ${missing.join(', ')}`).toEqual([]);
  });

  it('резолвер удара никогда не выдаёт имени вне банков', () => {
    const hits = [
      { gm: 36 }, { gm: 38 }, { gm: 42 }, { gm: 46 }, { gm: 49 }, { gm: 51 }, { gm: 53 },
      { gm: 999, label: 'oh' }, { gm: undefined, label: 'sh' }, { gm: 37, label: 'bd' },
      { gm: 35 }, {},
    ];
    for (const hit of hits) {
      const name = sampleNameForHit(hit);
      expect(available.has(name), `сэмпл ${name} (удар ${JSON.stringify(hit)}) есть в банках`).toBe(true);
    }
  });

  it('открытый хайхет — это 808oh, а не несуществующий oh', () => {
    expect(GM_TO_SAMPLE[46]).toBe('808oh');
    expect(sampleNameForHit({ gm: 46, label: 'oh' })).toBe('808oh');
  });
});
