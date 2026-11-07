// Дизайн-токены jade/obsidian: палитра из спецификации и контраст WCAG AA.
// Проверка живёт в тестах, чтобы регресс по контрасту ловился сразу,
// а не «на глаз» при ревью.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cssRaw = readFileSync(join(here, '../../src/styles/tokens.css'), 'utf8');
// Комментарии вырезаем: внутри блоков они «съедали» первую переменную.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

/** Разбирает CSS на блоки селекторов → карта переменных (ключи без «--»). */
function parseBlocks(source) {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    const vars = {};
    for (const decl of m[2].split(';')) {
      const idx = decl.indexOf(':');
      if (idx < 0) continue;
      const name = decl.slice(0, idx).trim();
      if (!name.startsWith('--')) continue;
      vars[name.replace(/^--/, '')] = decl.slice(idx + 1).trim();
    }
    blocks.push({ selector: m[1].trim().replace(/\s+/g, ' '), vars });
  }
  return blocks;
}

const blocks = parseBlocks(css);

function resolveTheme(theme) {
  const root = blocks.find((b) => b.selector === ':root');
  const jade = blocks.find((b) => b.selector.includes('theme-jade'));
  const obsidian = blocks.find((b) => b.selector.includes('theme-obsidian'));
  expect(root, 'блок :root в tokens.css').toBeTruthy();
  expect(jade, 'блок темы jade').toBeTruthy();
  expect(obsidian, 'блок темы obsidian').toBeTruthy();
  // Блок jade объявлен как «:root, html.theme-jade» — значит его значения
  // действуют в обеих темах, а obsidian переопределяет часть из них.
  const base = { ...root.vars, ...jade.vars };
  return theme === 'obsidian' ? { ...base, ...obsidian.vars } : base;
}

function hex(value) {
  const m = /^#([0-9a-f]{6})$/i.exec((value || '').trim());
  if (!m) return null;
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контраст по WCAG 2.x: (L1 + 0.05) / (L2 + 0.05). */
function contrast(fg, bg) {
  const a = luminance(hex(fg));
  const b = luminance(hex(bg));
  if (a === null || b === null) return null;
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5; // обычный текст
const AA_LARGE = 3; // крупный текст / крупные элементы

// Палитра из раздела 1.1 спецификации: эти переменные обязаны существовать.
const REQUIRED = [
  'bg-0',
  'bg-1',
  'bg-2',
  'bg-grad',
  'surface',
  'border',
  'jade',
  'jade-bright',
  'mint',
  'text',
  'text-dim',
  'note',
  'note-glow',
  'danger',
  'warn',
  'radius',
  'shadow',
  'font-mono',
];

// Пары «текст на фоне», которые реально встречаются в интерфейсе.
const PAIRS = {
  jade: [
    ['text', 'bg-1'],
    ['text', 'bg-2'],
    ['text', 'bg-0'],
    ['text-dim', 'bg-1'],
    ['text-dim', 'bg-2'],
    ['mint', 'bg-1'],
    ['mint', 'bg-2'],
    ['jade-bright', 'bg-1'],
    ['jade-bright', 'bg-2'],
    ['danger-text', 'bg-0'],
    ['danger-text', 'bg-1'],
    ['danger-text', 'bg-2'],
    ['warn', 'bg-1'],
    ['warn', 'bg-2'],
    ['note', 'bg-2'],
    ['ink-on-jade', 'jade'],
    ['ink-on-jade', 'jade-bright'],
  ],
  obsidian: [
    ['text', 'bg-1'],
    ['text', 'bg-2'],
    ['text-dim', 'bg-1'],
    ['text-dim', 'bg-2'],
    ['mint', 'bg-1'],
    ['mint', 'bg-2'],
    ['jade-bright', 'bg-1'],
    ['danger-text', 'bg-1'],
    ['danger-text', 'bg-2'],
    ['warn', 'bg-1'],
    ['note', 'bg-2'],
    ['ink-on-jade', 'jade'],
  ],
};

describe('дизайн-токены', () => {
  it.each(['jade', 'obsidian'])('тема %s содержит всю палитру из спецификации', (theme) => {
    const vars = resolveTheme(theme);
    for (const name of REQUIRED) {
      expect(vars[name], `${theme}: --${name}`).toBeTruthy();
    }
  });

  it.each(Object.entries(PAIRS))(
    'тема %s: контраст текста не ниже WCAG AA',
    (theme, pairs) => {
      const vars = resolveTheme(theme);
      for (const [fg, bg] of pairs) {
        const ratio = contrast(vars[fg], vars[bg]);
        expect(ratio, `${theme}: --${fg} на --${bg} (значения ${vars[fg]} / ${vars[bg]})`).not.toBeNull();
        expect(
          ratio,
          `${theme}: --${fg} на --${bg} = ${ratio.toFixed(2)}:1, нужно ≥ ${AA}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    },
  );

  it('крупные акценты (jade на тёмном фоне) держат AA для крупного текста', () => {
    const vars = resolveTheme('jade');
    const ratio = contrast(vars.jade, vars['bg-1']);
    expect(ratio).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it('вне tokens.css нет сырых цветов — всё через переменные', () => {
    const stylesDir = join(here, '../../src/styles');
    const files = ['layout.css', 'components.css', 'animations.css'];
    for (const name of files) {
      const source = readFileSync(join(stylesDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const literals = source.match(/rgba?\((?!var\()[^)]*\)|#[0-9a-fA-F]{3,8}\b/g) || [];
      expect(literals, `${name}: цвета должны быть в tokens.css`).toEqual([]);
    }
  });
});
