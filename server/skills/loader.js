// Загрузка скил-карт с диска.
//
// Формат карты: YAML-frontmatter + тело с обязательными секциями
// (docs/SKILLS.md). Карты лежат в `skills/*.md` в корне репозитория.
//
// Почему свой минимальный YAML-парсер, а не библиотека: в проекте нет
// yaml-зависимости, а добавлять её ради семи полей frontmatter не хочется.
// Поддерживается ровно то подмножество, которое реально используют карты:
//   • плоские ключи верхнего уровня (`id: composer-workflow`);
//   • скаляры: строки, числа, true/false;
//   • flow-последовательности `[a, b]`, в том числе из flow-карт;
//   • flow-карты `{k: v, k2: [0, 2]}`.
// Всё остальное (блочные вложенные карты, якоря, многострочные литералы)
// не поддерживается и приводит к понятной ошибке — молча читать неправильно
// нельзя, карта пойдёт в системный промт.
//
// Парсер детерминирован: порядок ключей сохраняется, никакой случайности.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SkillFront, SkillDocSchema, formatIssues } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/** Каталог с картами по умолчанию. */
export const SKILLS_DIR = join(root, 'skills');

/** Обязательные секции тела. */
const REQUIRED_SECTIONS = ['COMPACT', 'RECIPE', 'EXAMPLES', "DO / DON'T", 'MEASURE', 'EVOLVE'];

// ─── минимальный YAML-подмножество ───────────────────────────────────────

/**
 * Скаляр: приводит текст к строке/числу/булеву/null.
 * @param {string} raw
 */
function scalar(raw) {
  const text = String(raw).trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"') && text.length > 1)
    || (text.startsWith("'") && text.endsWith("'") && text.length > 1)) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Разбор flow-значения: `[...]`, `{...}` или скаляр.
 * Возвращает [значение, позиция после разобранного].
 * @param {string} src
 * @param {number} pos
 * @returns {[unknown, number]}
 */
function parseValue(src, pos) {
  while (pos < src.length && src[pos] === ' ') pos += 1;
  const ch = src[pos];
  if (ch === '[') {
    const list = [];
    let i = pos + 1;
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i += 1;
      if (src[i] === ']') return [list, i + 1];
      if (i >= src.length) throw new Error('не закрыта «[»');
      const [value, next] = parseValue(src, i);
      list.push(value);
      i = next;
    }
  }
  if (ch === '{') {
    const map = {};
    let i = pos + 1;
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i += 1;
      if (src[i] === '}') return [map, i + 1];
      if (i >= src.length) throw new Error('не закрыта «{»');
      const colon = src.indexOf(':', i);
      if (colon < 0) throw new Error('в flow-карте нет «:»');
      const key = String(scalar(src.slice(i, colon)));
      const [value, next] = parseValue(src, colon + 1);
      map[key] = value;
      i = next;
    }
  }
  // Скаляр до запятой/закрывающей скобки на текущем уровне.
  let i = pos;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (c === ',' && depth === 0) break;
    i += 1;
  }
  return [scalar(src.slice(pos, i)), i];
}

/**
 * Разбор frontmatter: плоские ключи верхнего уровня.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseFrontmatter(text) {
  const out = {};
  const lines = String(text ?? '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      throw new Error('вложенные блоки YAML не поддерживаются — используйте flow-стиль');
    }
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`строка frontmatter без «:» — «${line.trim()}»`);
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (!key) throw new Error('пустой ключ frontmatter');
    if (rest === '') {
      out[key] = null;
      continue;
    }
    const [value] = parseValue(rest, 0);
    out[key] = value;
  }
  return out;
}

// ─── разбор тела карты ───────────────────────────────────────────────────

/**
 * Делит тело на секции по заголовкам `## `.
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseSections(body) {
  const sections = {};
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const parts = text.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const head = (newline < 0 ? part : part.slice(0, newline)).trim();
    const content = newline < 0 ? '' : part.slice(newline + 1).trim();
    if (!head) continue;
    sections[head] = content;
  }
  return sections;
}

/**
 * Достаёт блоки ```js из секции EXAMPLES.
 * @param {string} text
 * @returns {string[]}
 */
export function extractJsBlocks(text) {
  const blocks = [];
  const re = /```js\n([\s\S]*?)```/g;
  let match = re.exec(String(text ?? ''));
  while (match) {
    blocks.push(match[1].trim());
    match = re.exec(String(text ?? ''));
  }
  return blocks;
}

/**
 * Разбирает одну карту: frontmatter + тело.
 * Бросает понятную ошибку, если карта битая.
 * @param {string} source содержимое файла
 * @param {string} [file] имя файла для сообщений
 */
export function parseSkill(source, file = '<skill>') {
  const text = String(source ?? '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    throw new Error(`${file}: нет frontmatter (ожидается «---» в первой строке)`);
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) throw new Error(`${file}: frontmatter не закрыт`);
  const frontText = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, '');

  let frontRaw;
  try {
    frontRaw = parseFrontmatter(frontText);
  } catch (error) {
    throw new Error(`${file}: frontmatter не разобран — ${error.message}`);
  }

  const parsedFront = SkillFront.safeParse(frontRaw);
  if (!parsedFront.success) {
    throw new Error(`${file}: frontmatter невалиден — ${formatIssues(parsedFront.error)}`);
  }

  const sections = parseSections(body);
  const missing = REQUIRED_SECTIONS.filter((name) => !(name in sections));
  if (missing.length) {
    throw new Error(`${file}: нет обязательных секций — ${missing.join(', ')}`);
  }

  const doc = {
    frontmatter: parsedFront.data,
    body,
    compact: sections.COMPACT,
    recipe: sections.RECIPE,
    examples: extractJsBlocks(sections.EXAMPLES),
    sections,
  };

  const parsedDoc = SkillDocSchema.safeParse(doc);
  if (!parsedDoc.success) {
    throw new Error(`${file}: карта невалидна — ${formatIssues(parsedDoc.error)}`);
  }
  return parsedDoc.data;
}

// ─── загрузка с диска ────────────────────────────────────────────────────

/**
 * Читает все карты из каталога.
 * @param {{dir?: string}} [options] каталог с картами (по умолчанию skills/)
 * @returns {Array<object>} карты, отсортированные по id
 */
export function loadSkills({ dir = SKILLS_DIR } = {}) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'INDEX.md')
    .sort();
  const skills = files.map((name) => parseSkill(readFileSync(join(dir, name), 'utf8'), name));
  skills.sort((a, b) => (a.frontmatter.id < b.frontmatter.id ? -1 : 1));
  return skills;
}

let cache = null;

/**
 * Карты с кэшированием (для серверных запросов).
 * @param {{dir?: string, reload?: boolean}} [options]
 */
export function allSkills({ dir = SKILLS_DIR, reload = false } = {}) {
  if (!cache || reload || cache.dir !== dir) cache = { dir, skills: loadSkills({ dir }) };
  return cache.skills;
}

/**
 * Карта по id.
 * @param {string} id
 * @returns {object|null}
 */
export function getSkill(id) {
  const found = allSkills().find((skill) => skill.frontmatter.id === id);
  return found || null;
}

/**
 * Краткий список карт (id, kind, версия).
 * @returns {Array<{id:string,kind:string,version:string,tags:string[]}>}
 */
export function listSkills() {
  return allSkills().map((skill) => ({
    id: skill.frontmatter.id,
    kind: skill.frontmatter.kind,
    version: skill.frontmatter.version,
    tags: skill.frontmatter.tags,
  }));
}

/**
 * Индекс карт: id → метаданные (kind, версия, refs, теги).
 * @returns {Record<string, object>}
 */
export function skillIndex() {
  const index = {};
  for (const skill of allSkills()) {
    const front = skill.frontmatter;
    index[front.id] = {
      id: front.id,
      kind: front.kind,
      version: front.version,
      tags: front.tags,
      refs: front.refs,
    };
  }
  return index;
}

/**
 * Версия скил-пака: sha256 по frontmatter + COMPACT всех карт.
 * Порядок карт — по id, поэтому хэш не зависит от порядка файлов в каталоге.
 * @param {Array<object>} [skills] набор карт (по умолчанию — с диска)
 * @returns {string}
 */
export function skillsVersion(skills = allSkills()) {
  const ordered = [...skills].sort((a, b) => (
    a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0
  ));
  const parts = ordered.map((skill) => {
    const front = skill.frontmatter;
    const meta = [
      front.id, front.version, front.kind,
      [...front.tags].sort().join(','),
      [...front.refs].sort().join(','),
      JSON.stringify(front.paramRanges),
      String(front.compact),
    ].join('|');
    return `${meta}\n${skill.compact}`;
  });
  return createHash('sha256').update(parts.join('\n---\n'), 'utf8').digest('hex');
}
