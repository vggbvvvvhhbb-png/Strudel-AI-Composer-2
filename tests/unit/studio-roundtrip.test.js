// Фаза 1: round-trip проекта через заголовок @project.
import { describe, it, expect } from 'vitest';
import {
  embedProjectHeader, extractProject, stripProjectHeader,
  projectHash, codeHash, CHUNK_LIMIT, PROJECT_HEADER_PREFIX,
} from '../../src/studio/roundtrip.js';
import { projectFromSpec, canonicalJson } from '../../src/studio/model.js';
import { compileProject } from '../../src/studio/compile.js';
import { SPEC } from '../fixtures/studio-spec.js';

const model = () => projectFromSpec(SPEC, { id: 'demo' });

describe('round-trip @project', () => {
  it('модель восстанавливается из кода без потерь', () => {
    const source = model();
    const { code } = compileProject(source);
    const withHeader = embedProjectHeader(code, source);
    const parsed = extractProject(withHeader);
    expect(parsed.mode).toBe('project');
    expect(canonicalJson(parsed.model)).toBe(canonicalJson(source));
  });

  it('хеш модели не меняется при round-trip', () => {
    const source = model();
    const { code } = compileProject(source);
    const parsed = extractProject(embedProjectHeader(code, source));
    expect(parsed.hash).toBe(projectHash(source));
  });

  it('код без заголовка — режим «Свободный код» с объяснением', () => {
    const parsed = extractProject('setCpm(120/4)\n$KICK: s("bd")');
    expect(parsed.mode).toBe('free');
    expect(parsed.reason).toMatch(/Свободный код/);
  });

  it('повреждённый заголовок не ломает разбор — тоже свободный код', () => {
    const parsed = extractProject(`${PROJECT_HEADER_PREFIX}не-дефlate\n$KICK: s("bd")`);
    expect(parsed.mode).toBe('free');
  });

  it('несовпадение хеша обнаруживается', () => {
    const source = model();
    const { code } = compileProject(source);
    const withHeader = embedProjectHeader(code, source).replace(
      /@project-hash sha256:[0-9a-f]+/,
      '@project-hash sha256:0000000000000000000000000000000000000000000000000000000000000000',
    );
    const parsed = extractProject(withHeader);
    expect(parsed.mode).toBe('free');
    expect(parsed.hashMismatch).toBe(true);
  });

  it('чанк заголовка не длиннее 2000 символов', () => {
    const big = model();
    // Несжимаемые данные: иначе lz-string упакует «xxxx…» в пару байт
    // и проверка чанков ничего не проверяла бы.
    let state = 12345;
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let noise = '';
    for (let i = 0; i < 6000; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      noise += alphabet[state % alphabet.length];
    }
    big.spec.parts.roles.kick.variants = [{ id: 'kick-notes', kind: 'notes', value: noise }];
    const { code } = compileProject(big);
    const withHeader = embedProjectHeader(code, big);
    const headerLines = withHeader.split('\n').filter((line) => line.startsWith(PROJECT_HEADER_PREFIX));
    expect(headerLines.length).toBeGreaterThan(1);
    for (const line of headerLines) {
      expect(line.length - PROJECT_HEADER_PREFIX.length).toBeLessThanOrEqual(CHUNK_LIMIT);
    }
    const parsed = extractProject(withHeader);
    expect(parsed.mode).toBe('project');
    expect(parsed.model.spec.parts.roles.kick.variants[0].value.length).toBe(6000);
  });

  it('заголовок не мешает исполнению кода — это комментарии', () => {
    const source = model();
    const { code } = compileProject(source);
    const withHeader = embedProjectHeader(code, source);
    const headerLines = withHeader.split('\n')
      .filter((line) => line.startsWith(PROJECT_HEADER_PREFIX) || line.startsWith('@project-hash') || line.includes('@project-hash'));
    expect(headerLines.length).toBeGreaterThan(0);
    for (const line of headerLines) expect(line.trimStart().startsWith('//')).toBe(true);
    expect(stripProjectHeader(withHeader).trim()).toBe(code.trim());
  });

  it('хеш кода стабилен и меняется при правке', () => {
    const source = model();
    const a = compileProject(source);
    source.mix.parts.kick.gainDb = -3;
    const b = compileProject(source);
    expect(a.hash).not.toBe(b.hash);
    expect(codeHash(a.code)).toBe(a.hash);
  });
});
