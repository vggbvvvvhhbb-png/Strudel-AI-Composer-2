import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseErrorLocation, staticValidate } from '../../src/core/validator.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('staticValidate: битый код ловится', () => {
  for (const name of readdirSync(join(here, '../fixtures/broken'))) {
    it(`фикстура ${name}`, () => {
      const code = readFileSync(join(here, '../fixtures/broken', name), 'utf8');
      const res = staticValidate(code);
      expect(res.ok).toBe(false);
      expect(res.error.message).toBeTruthy();
    });
  }
});

describe('staticValidate: валидный код проходит', () => {
  for (const name of readdirSync(join(here, '../fixtures/valid'))) {
    it(`фикстура ${name}`, () => {
      const code = readFileSync(join(here, '../fixtures/valid', name), 'utf8');
      expect(staticValidate(code).ok).toBe(true);
    });
  }
});

describe('staticValidate: маркер unsafe', () => {
  it('fetch помечается как небезопасный', () => {
    const res = staticValidate('$MEL: note("c")\nfetch("http://x")\n');
    expect(res.ok).toBe(false);
    expect(res.unsafe).toBe(true);
  });

  it('пустой код отклоняется', () => {
    expect(staticValidate('   ').ok).toBe(false);
  });
});

describe('staticValidate: точка вместо тильды в mini-нотации', () => {
  it('ловит одиночную точку на месте паузы', () => {
    const res = staticValidate('$MEL: note("c4 . e4 .")');
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/тильда|~/);
  });

  it('указывает номер строки', () => {
    const res = staticValidate('setCpm(120/4)\n$MEL: note("c4 . e4")\n');
    expect(res.error.line).toBe(2);
  });

  it('тильда как пауза проходит', () => {
    expect(staticValidate('$MEL: note("c4 ~ e4")').ok).toBe(true);
  });

  it('точка внутри слова — не пауза', () => {
    expect(staticValidate('$MEL: s("bass.wav")').ok).toBe(true);
  });

  it('числа с точкой не считаются паузой', () => {
    expect(staticValidate('$MEL: note("c4").gain(.5).lpf(1200)').ok).toBe(true);
  });
});

describe('parseErrorLocation', () => {
  it('извлекает строку из <anonymous>:L:C', () => {
    const loc = parseErrorLocation('SyntaxError: <anonymous>:2:1 Unexpected token', '$MEL:\nnote(');
    expect(loc.line).toBe(2);
    expect(loc.message).toContain('note(');
  });

  it('без локации возвращает строку как есть', () => {
    const loc = parseErrorLocation('some error');
    expect(loc.line).toBe(0);
    expect(loc.message).toBe('some error');
  });
});
