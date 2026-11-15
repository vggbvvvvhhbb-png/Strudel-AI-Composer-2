// CSP: строгая на обложке, послабленная там, где исполняется код.
//
// Проверяем ровно то, что было в разрыве из отчёта:
// «В script-src одновременно unsafe-eval и unsafe-inline — при живом
// исполнении пользовательского кода это заметно расширяет поверхность
// атаки».

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cspHeaderFor, CSP_BASE, CSP_EVAL_PATHS } from '../../server/security/csp.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

/** Разбор заголовка CSP в объект «директива → значения». */
function parse(header) {
  const out = {};
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

describe('CSP', () => {
  it('на обложке нет ни unsafe-eval, ни unsafe-inline в script-src', () => {
    const scriptSrc = parse(cspHeaderFor('/'))['script-src'];
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('в студии unsafe-eval есть — там движок исполняет код', () => {
    const scriptSrc = parse(cspHeaderFor('/studio.html'))['script-src'];
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('unsafe-inline не появляется ни на одной странице', () => {
    for (const path of ['/', '/studio.html', '/tinder.html', '/razbor/abc-123', '/api/health']) {
      const scriptSrc = parse(cspHeaderFor(path))['script-src'];
      expect(scriptSrc, `путь ${path}`).not.toContain("'unsafe-inline'");
    }
  });

  it('страница разбора получает послабление, как студия', () => {
    expect(CSP_EVAL_PATHS.test('/razbor/abc-123')).toBe(true);
    expect(parse(cspHeaderFor('/razbor/abc-123'))['script-src']).toContain("'unsafe-eval'");
  });

  it('во всех политиках остаётся то, без чего не работает звук', () => {
    for (const path of ['/', '/studio.html']) {
      const csp = parse(cspHeaderFor(path));
      expect(csp['script-src']).toContain("'wasm-unsafe-eval'");
      expect(csp['script-src']).toContain('data:');
      expect(csp['script-src']).toContain('blob:');
      expect(csp['media-src']).toContain('blob:');
      expect(csp['connect-src']).toContain('https://shabda.ndre.gr');
    }
  });

  it('страницы приложения не содержат инлайновых скриптов — иначе CSP их заблокирует', () => {
    for (const file of ['index.html', 'studio.html', 'tinder.html']) {
      const html = readFileSync(join(root, file), 'utf8');
      const inline = [...html.matchAll(/<script\b([^>]*)>/g)]
        .filter((match) => !/\bsrc=/.test(match[1]))
        .map((match) => match[0]);
      expect(inline, `${file}: есть инлайновый скрипт`).toEqual([]);
    }
  });

  it('базовая политика не содержит лишних директив', () => {
    expect(Object.keys(CSP_BASE)).toContain('default-src');
    expect(CSP_BASE['default-src']).toEqual(["'self'"]);
  });
});
