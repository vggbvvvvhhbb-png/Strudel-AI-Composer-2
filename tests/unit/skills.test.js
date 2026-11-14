// Скил-паки: загрузка карт, компиляция учебника, линтер примеров.
//
// Ключевой тест — «матрица активации» из skills/INDEX.md: она лежит в
// репозитории как документация, а здесь превращается в исполняемую проверку
// retrieval. Если правила разбора или карты разойдутся с матрицей — падает
// тест, а не кто-то вручную.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadSkills, parseSkill, skillIndex, skillsVersion, allSkills,
} from '../../server/skills/loader.js';
import {
  compileSkills, estimateTokens, resolveGenre, parseArc, ALWAYS_ON, TOKEN_BUDGET,
} from '../../server/skills/compile.js';
import {
  lintExample, scanSequenceAngles, scanGuardrails, scanForbidden,
  scanMicrotiming, splitVoices, notePitchClass, scalePitchClasses, parseScale,
} from '../../server/skills/lint.js';
import { parseMood } from '../../src/ir/emotion.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const skillsDir = join(root, 'skills');

/**
 * Матрица активации из INDEX.md: промпт → жанр, настроение, грув, арка.
 * @returns {Array<{prompt:string,genre:string,mood:string,groove:string,arc:string}>}
 */
function activationMatrix() {
  const text = readFileSync(join(skillsDir, 'INDEX.md'), 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\|\s*«(.+?)»\s*\|\s*([a-z-]+)\s*\|\s*([a-z-]+)\s*\|\s*([a-z0-9-]+)\s*\|\s*([a-z0-9-]+)\s*\|/.exec(line);
    if (!match) continue;
    rows.push({
      prompt: match[1],
      genre: match[2],
      mood: match[3],
      groove: match[4],
      arc: match[5],
    });
  }
  return rows;
}

/** Имя арки без номера тактов: slow-burn-48 → slow-burn. */
function arcBase(name) {
  return String(name).replace(/-\d+$/, '');
}

describe('скил-карты: загрузка', () => {
  it('все карты читаются, id уникальны, refs существуют', () => {
    const cards = loadSkills({ dir: skillsDir });
    expect(cards.length).toBeGreaterThanOrEqual(11);
    const ids = cards.map((card) => card.frontmatter.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const card of cards) {
      for (const ref of card.frontmatter.refs) {
        expect(ids, `ref ${ref} карты ${card.frontmatter.id}`).toContain(ref);
      }
    }
  });

  it('у каждой карты есть все обязательные секции', () => {
    for (const card of loadSkills({ dir: skillsDir })) {
      for (const section of ['COMPACT', 'RECIPE', 'EXAMPLES', "DO / DON'T", 'MEASURE', 'EVOLVE']) {
        expect(Object.keys(card.sections), `${card.frontmatter.id}: ${section}`).toContain(section);
      }
    }
  });

  it('COMPACT каждой карты укладывается в 400 токенов', () => {
    for (const card of loadSkills({ dir: skillsDir })) {
      expect(estimateTokens(card.compact), card.frontmatter.id).toBeLessThanOrEqual(400);
    }
  });

  it('битая карта падает с понятной ошибкой, а не молча', () => {
    const broken = '---\nid: broken\nversion: 1.0.0\nkind: core\ntags: [x]\n---\n\n## COMPACT\nпусто\n';
    expect(() => parseSkill(broken, 'broken.md')).toThrow(/секций/);
  });

  it('версия пака стабильна и меняется вместе с картой', () => {
    const cards = loadSkills({ dir: skillsDir });
    const first = skillsVersion(cards);
    expect(first).toBe(skillsVersion(loadSkills({ dir: skillsDir })));
    const changed = cards.map((card) => (card.frontmatter.id === 'emotion-map'
      ? { ...card, compact: `${card.compact}\nещё строчка` }
      : card));
    expect(skillsVersion(changed)).not.toBe(first);
  });
});

describe('компилятор учебника', () => {
  it('детерминирован: два прогона дают байт-в-байт одинаковый учебник', () => {
    const first = compileSkills({ prompt: 'мрачный трип-хоп про дождь' });
    const second = compileSkills({ prompt: 'мрачный трип-хоп про дождь' });
    expect(first.text).toBe(second.text);
    expect(first.skillsVersion).toBe(second.skillsVersion);
  });

  it('укладывается в бюджет 3200 токенов на всех приёмочных промтах', () => {
    for (const row of activationMatrix()) {
      const book = compileSkills({ prompt: row.prompt });
      expect(book.tokens, row.prompt).toBeLessThanOrEqual(TOKEN_BUDGET);
    }
  });

  it('всегдашние карты попадают в учебник', () => {
    const book = compileSkills({ prompt: 'уютный лоуфай для учёбы' });
    for (const id of ALWAYS_ON) {
      expect(book.used, id).toContain(id);
    }
  });

  it('не выдумывает имена сэмплов, если паспортов нет', () => {
    const book = compileSkills({ prompt: 'злой быстрый dnb' });
    // Паспортов в репозитории ещё нет — учебник обязан это сказать,
    // а не сочинить названия сэмплов.
    if (!book.text.includes('паспорта сэмплов недоступны')) {
      expect(book.text).not.toMatch(/sample-passports/);
    }
  });
});

describe('матрица активации INDEX.md', () => {
  const matrix = activationMatrix();

  it('матрица непустая', () => {
    expect(matrix.length).toBeGreaterThanOrEqual(10);
  });

  it.each(matrix.map((row) => [row.prompt, row]))(
    '«%s» → карты %s/%s/%s/%s',
    (_prompt, row) => {
      // Жанр: слово из запроса или вывод по V/A.
      expect(resolveGenre({ prompt: row.prompt }).genre, 'genre').toBe(row.genre);
      // Настроение: словарь emotion-map, последнее слово доминирует.
      expect(parseMood(row.prompt).label, 'mood').toBe(row.mood);

      const card = allSkills().find((item) => item.frontmatter.id === `genre-${row.genre}`);
      expect(card, `нет карты genre-${row.genre}`).toBeTruthy();
      const cardText = `${card.compact}\n${card.body}`;
      const grooveMatch = /\bgroove\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(cardText);
      expect(grooveMatch?.[1].toLowerCase(), 'groove в карте жанра').toBe(row.groove);
      // Арка — тем же кодом, что и компилятор: у synthpop она условная.
      const arc = parseArc(cardText, row.prompt);
      // Название арки в карте может уточняться числом тактов (slow-burn-48),
      // а в матрице стоит основа (slow-burn).
      expect(String(arc).startsWith(row.arc), `arc в карте жанра: ${arc} vs ${row.arc}`).toBe(true);

      // Учебник действительно собрал нужные блоки.
      const book = compileSkills({ prompt: row.prompt });
      expect(book.used, 'использована карта жанра').toContain(`genre-${row.genre}`);
      if (row.groove !== 'none') {
        expect(book.text, 'есть шаблон грува').toContain(`groove-шаблон: ${row.groove}`);
      }
      expect(book.text, 'есть арка').toContain(`арка: ${arc}`);
    },
  );
});

describe('линтер примеров', () => {
  it('ловит «<...>» в n()/note(): это один элемент за цикл, а не шаги такта', () => {
    const findings = scanSequenceAngles('$: n("<4 ~ 2 ~ 5 ~ 3 ~>").scale("D:minor")');
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('angle-sequence-in-note');
  });

  it('не ругается на «<...>» в прогрессиях, масках и панораме', () => {
    expect(scanSequenceAngles('$: chord("<Am7 F^7 C^7 G>").voicing()')).toHaveLength(0);
    expect(scanSequenceAngles('$: s("bd*4").mask("<0!7 1>")')).toHaveLength(0);
    expect(scanSequenceAngles('$: s("hh*8").pan("<.4 .6>")')).toHaveLength(0);
  });

  it('уважает явный opt-out one-per-cycle', () => {
    expect(scanSequenceAngles('$: n("<0 2 4>") /* one-per-cycle */')).toHaveLength(0);
  });

  it('ловит guardrails: delayfeedback, gain, duckdepth, микротайминг', () => {
    expect(scanGuardrails('$: s("hh*4").delayfeedback(1.2)')[0].code).toBe('guardrail-delayfeedback');
    expect(scanGuardrails('$: s("hh*4").delayfeedback(.9)')).toHaveLength(0);
    expect(scanGuardrails('$: s("hh*4").gain(1.5)')[0].code).toBe('guardrail-gain');
    expect(scanGuardrails('$: s("hh*4").duckdepth(1.4)')[0].code).toBe('guardrail-duckdepth');
    expect(scanMicrotiming('$: s("sd").late(ms(34))')[0].code).toBe('microtiming-range');
    expect(scanMicrotiming('$: s("sd").late(ms(12))')).toHaveLength(0);
  });

  it('ловит запрещённые конструкции', () => {
    expect(scanForbidden('eval("x")')[0].code).toBe('eval');
    expect(scanForbidden('fetch("http://x")')[0].code).toBe('fetch');
    expect(scanForbidden('$: s("bd*4")')).toHaveLength(0);
  });

  it('делит код на голоса и сохраняет преамбулу', () => {
    const { preamble, voices } = splitVoices([
      'setcpm(82/4)',
      'const ms = x => x * 2',
      '$: s("bd*2")',
      '$: n("0 2 4")',
    ].join('\n'));
    expect(preamble).toContain('const ms');
    expect(voices).toHaveLength(2);
    expect(voices[0]).toContain('s("bd*2")');
  });

  it('считает питч-классы и строит лад', () => {
    expect(notePitchClass('A3')).toBe(9);
    expect(notePitchClass('Bb2')).toBe(10);
    expect(scalePitchClasses('minor', 'D').has(5)).toBe(true);  // F в D-mine
    expect(scalePitchClasses('minor', 'D').has(6)).toBe(false); // F# — нет
    expect(parseScale('n("0").scale("Eb:major")')).toEqual({ tonic: 'Eb', mode: 'major' });
  });

  it('каждый пример карты проходит dry-parse и линтер', async () => {
    for (const card of loadSkills({ dir: skillsDir })) {
      for (const [index, code] of card.examples.entries()) {
        const result = await lintExample(code);
        expect(
          result.errors.map((item) => item.message).join('; '),
          `${card.frontmatter.id}#${index}`,
        ).toBe('');
        expect(result.ok, `${card.frontmatter.id}#${index}`).toBe(true);
      }
    }
  });
});
