// Регресс на два CRLF-дефекта, найденных этапом 0 (17.11.2026, отчёт §20.2).
//
// 1. Shebang в local/*.mjs: vite SSR-трансформ поднимает импорты наверх,
//    и при CRLF shebang оказывается в середине кода → SyntaxError у vitest.
//    На LF (Linux/CI) дефект не виден, поэтому страж нужен кроссплатформенный.
// 2. sync-pool-licenses: сравнение LF-секции с CRLF-файлом давало ложное
//    «раздел устарел» на Windows-чекауте. Стиль переносов файла обязан
//    сохраняться, а идентичное содержимое — считаться актуальным.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applySection, START, END } from '../../scripts/sync-pool-licenses.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('local-модули без shebang (vite SSR + CRLF)', () => {
  it('ни один .mjs в local/ не начинается с #!', () => {
    const dir = path.join(root, 'local');
    const files = readdirSync(dir).filter((name) => name.endsWith('.mjs'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const head = readFileSync(path.join(dir, name), 'utf8').slice(0, 2);
      expect(head, `${name}: shebang ломает vitest на CRLF-чекауте`).not.toBe('#!');
    }
  });
});

describe('sync-pool-licenses: стиль переносов файла сохраняется', () => {
  const sectionLf = [START, '## Раздел', '', '| a | b |', END].join('\n');

  it('CRLF-файл с идентичным содержимым считается актуальным', () => {
    const source = `до\r\n${sectionLf.replace(/\n/g, '\r\n')}\r\nпосле\r\n`;
    const result = applySection(source, sectionLf);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.next).toBe(source);
  });

  it('LF-файл с идентичным содержимым считается актуальным', () => {
    const source = `до\n${sectionLf}\nпосле\n`;
    const result = applySection(source, sectionLf);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
  });

  it('изменение содержимого переписывает секцию в стиле файла', () => {
    const source = `до\r\n${START}\r\nстарое\r\n${END}\r\nпосле\r\n`;
    const result = applySection(source, sectionLf);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.next).toContain('## Раздел');
    expect(result.next).not.toContain('старое');
    expect(result.next.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true);
    expect(result.next.startsWith('до\r\n')).toBe(true);
    expect(result.next.endsWith('после\r\n')).toBe(true);
  });

  it('файл без маркеров — честный отказ, а не тихая порча', () => {
    const result = applySection('нет маркеров', sectionLf);
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
  });
});