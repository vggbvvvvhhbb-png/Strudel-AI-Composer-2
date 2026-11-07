// Guard на реальность сэмплов: Strudel ищет «bank_s» / «s» в soundMap,
// собранном из манифестов. Несуществующее имя = тишина, без ошибки в UI.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PRESETS } from '../../src/presets/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const systemPrompt = readFileSync(
  join(here, '../../server/prompts/system.md'),
  'utf8',
);

// Имена из манифестов dirt-samples + shabda:piano, которые использует приложение.
const KNOWN = new Set([
  'bd', 'sd', 'hh', 'hh27', 'cp', 'oh', 'perc', '808', '808bd', '808sd', '808oh',
  '808mc', '808ht', '808lc', '808cy', '808hc', '808lt', '909', 'bass', 'bass0',
  'bass1', 'bass2', 'bass3', 'pluck', 'stab', 'jazz', 'juno', 'moog', 'sax',
  'trump', 'sitar', 'house', 'dr', 'dr2', 'dr55', 'breaks125', 'breaks152',
  'breaks157', 'breaks165', 'realclaps', 'sh', 'rave', 'rave2', 'gab', 'gabba',
  'industrial', 'jungle', 'techno', 'piano',
]);

// Имена в s("…") — мини-нотация: bd*4, cp(3,8), ~, hh*2 …
// Именно s(..., а не .s( — последнее задаёт синтезатор (sawtooth, sine …).
function sampleNames(code) {
  const names = new Set();
  for (const match of code.matchAll(/(^|[^\w.])s\(\s*"([^"]*)"/g)) {
    for (const token of match[2].split(/[\s,]+/)) {
      // отбрасываем множитель и параметры: hh*2 → hh, cp(3,8) → cp
      const name = token.split(/[*(]/)[0].replace(/[[\]():]/g, '').trim();
      if (!name || name === '~' || name === '.') continue;
      names.add(name);
    }
  }
  return names;
}

describe('сэмплы пресетов и промпта существуют', () => {
  it('пресеты не используют .bank(...) — таких банков в манифестах нет', () => {
    for (const p of PRESETS) {
      expect(p.code, `${p.name}: .bank(...) означает тишину`).not.toMatch(/\.bank\s*\(/);
    }
  });

  it('имена сэмплов в пресетах есть в загруженных наборах', () => {
    for (const p of PRESETS) {
      for (const name of sampleNames(p.code)) {
        expect(KNOWN.has(name), `${p.name}: неизвестный сэмпл «${name}»`).toBe(true);
      }
    }
  });

  it('системный промпт не предлагает несуществующие банки', () => {
    expect(systemPrompt).not.toMatch(/RolandTR909|RolandTR808|AkaiLinn/);
    expect(systemPrompt).not.toMatch(/\.bank\("Roland/);
  });

  it('системный промпт перечисляет рабочие имена сэмплов', () => {
    for (const name of ['bd', 'sd', 'hh', 'cp', 'piano']) {
      expect(systemPrompt, `промпт должен упоминать «${name}»`).toContain(`\`${name}\``);
    }
  });
});
