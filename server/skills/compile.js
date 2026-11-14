// Компилятор «учебника» для одного запроса.
//
// Спека: docs/SKILLS.md §«Компилятор промт».
//
// Учебник = всегдашние карты (composer-workflow + emotion-map + mix-roles)
// + COMPACT жанровой карты + по одному блоку из groove-templates,
// harmony-recipes, arrangement-arcs + палитра сэмплов.
//
// Ключевые свойства:
//   • детерминированность — ни Date.now(), ни Math.random(); при одном и том
//     же запросе учебник байт-в-байт одинаковый;
//   • бюджет ≤ 3200 токенов; при переполнении режется EXAMPLES, а COMPACT
//     не трогается никогда (это единственное, что реально нужно модели);
//   • никаких выдуманных имён сэмплов: если паспортов нет — так и пишем.
//
// Оценка длины: tokens ≈ ceil(символы / 4) — та же формула, что в CI-скрипте.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allSkills, getSkill, skillsVersion } from './loader.js';
import { GENRES, detectGenre } from '../../src/ir/intent.js';
import { MOODS, parseMood } from '../../src/ir/emotion.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/** Карты, которые попадают в учебник всегда. */
export const ALWAYS_ON = ['composer-workflow', 'emotion-map', 'mix-roles'];

/** Бюджет учебника в токенах. */
export const TOKEN_BUDGET = 3200;

/** Паспорта сэмплов (появятся позже; пока их нет — палитра пустая). */
const PASSPORTS_FILE = join(root, 'server', 'music', 'data', 'sample-passports.json');

/** Настроения, для которых harmony-recipes держит свою прогрессию. */
const HARMONY_MOODS = [
  'joy', 'euphoria', 'tender', 'hope', 'nostalgia',
  'melancholy', 'dark', 'anxiety', 'anger', 'void',
];

/**
 * Оценка числа токенов: та же формула, что в check-skills.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

/**
 * Разбирает блоки «имя: содержимое» из строк вида «- имя: текст».
 * Таблицы шаблонов грува и арок устроены именно так.
 * @param {string} text
 * @returns {Record<string,string>}
 */
function parseNamedBlocks(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*[-*]\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line);
    if (!match) continue;
    out[match[1].toLowerCase()] = match[2].trim();
  }
  return out;
}

/**
 * Ищет в тексте карты «groove: <имя>».
 * @param {string} text
 * @returns {string|null}
 */
function parseGroove(text) {
  const match = /\bgroove\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(String(text ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/**
 * Ищет в тексте карты «arc: <имя>».
 * Поддерживается условная форма «arc: song-64 (или club-64 для «фестиваля»)»:
 * если запрос содержит указанное слово — берётся альтернативная арка.
 * @param {string} text
 * @param {string} prompt
 * @returns {string|null}
 */
function parseArc(text, prompt) {
  const source = String(text ?? '');
  const match = /\barc\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(source);
  if (!match) return null;
  const primary = match[1].toLowerCase();
  const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 120);
  const alt = /\(\s*или\s+([A-Za-z0-9_-]+)\s+для\s+«([^»]+)»\s*\)/i.exec(tail);
  if (alt && String(prompt).toLowerCase().includes(alt[2].toLowerCase())) {
    return alt[1].toLowerCase();
  }
  return primary;
}

/**
 * Роли жанровой карты: первый столбец таблицы «Палитра» в RECIPE.
 * @param {object|null} skill
 * @returns {string[]}
 */
function parseRoles(skill) {
  const recipe = skill?.recipe ?? '';
  const section = /###\s*Палитра[^\n]*\n([\s\S]*?)(?=\n###|\n##|$)/.exec(recipe);
  if (!section) return [];
  const roles = [];
  for (const line of section[1].split('\n')) {
    const match = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!name || name.toLowerCase() === 'роль' || /^-+$/.test(name)) continue;
    roles.push(name);
  }
  return roles;
}

/**
 * Блок гармонии по настроению из harmony-recipes.
 * @param {object|null} skill
 * @param {string|null} mood
 * @returns {string|null}
 */
function harmonyBlock(skill, mood) {
  if (!skill || !mood) return null;
  const compact = skill.compact ?? '';
  for (const name of HARMONY_MOODS) {
    if (name !== mood) continue;
    const re = new RegExp(`(?:^|[|\\n])\\s*${name}\\s*:\\s*([^|\\n]+)`, 'm');
    const match = re.exec(compact);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Читает паспорта сэмплов, если файл есть.
 * @returns {Array<object>|null}
 */
function loadPassports() {
  if (!existsSync(PASSPORTS_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(PASSPORTS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.roles ?? raw.passports ?? []);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/**
 * Палитра: до 8 паспортов, подходящих под роли жанра.
 * Если паспортов нет — пустой список и пометка, без выдуманных имён.
 * @param {string[]} roles
 * @returns {{items: Array<object>, note: string|null}}
 */
function paletteFor(roles) {
  const passports = loadPassports();
  if (!passports) {
    return {
      items: [],
      note: 'паспорта сэмплов недоступны (нет server/music/data/sample-passports.json) — имена сэмплов не выдумываются',
    };
  }
  const wanted = roles.map((role) => role.toLowerCase());
  const picked = passports.filter((item) => {
    const role = String(item?.role ?? '').toLowerCase();
    return wanted.some((w) => role === w || role.includes(w) || w.includes(role));
  });
  const items = (picked.length ? picked : passports).slice(0, 8);
  return {
    items,
    note: picked.length ? null : 'под роли жанра паспортов не нашлось — показан общий список',
  };
}

/**
 * Текст палитры для учебника.
 * @param {{items:Array<object>, note:string|null}} palette
 * @param {string[]} roles
 * @returns {string}
 */
function paletteText(palette, roles) {
  const lines = ['### палитра'];
  if (roles.length) lines.push(`роли жанра: ${roles.join(', ')}`);
  if (palette.note) lines.push(palette.note);
  for (const item of palette.items) {
    const name = item.name ?? item.id ?? item.ref;
    if (!name) continue;
    const role = item.role ? ` [${item.role}]` : '';
    const extra = [item.key, item.bpm, item.character].filter(Boolean).join(', ');
    lines.push(`- ${name}${role}${extra ? ` — ${extra}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Определяет жанр запроса.
 *
 * 1) явное слово жанра в промте (словарь GENRE_KEYWORDS из src/ir/intent.js);
 * 2) иначе — вывод по V/A по правилам docs/SKILLS.md:
 *    A < −0.5 → ambient, A < 0 → lofi, A > 0.3 → synthpop, иначе trip-hop.
 *
 * Уточнение к ветке «A < 0 → lofi»: lofi — тёплый жанр, поэтому при тёмной
 * валентности (V < 0) низко- arousal настроения уходят в trip-hop — это же
 * написано в самой карте («mood dark|melancholy»). Без уточнения промт
 * «меланхолия осеннего города» уезжал бы в lofi, а по матрице активации
 * (skills/INDEX.md) он должен давать trip-hop.
 *
 * @param {{prompt?:string, mood?:string|null, valence?:number|null, arousal?:number|null}} input
 * @returns {{genre:string, source:string, valence:number, arousal:number, mood:string|null}}
 */
export function resolveGenre({ prompt = '', mood = null, valence = null, arousal = null }) {
  const detected = parseMood(prompt);
  const label = mood && MOODS[mood] ? mood : (mood ?? detected.label ?? null);
  const v = Number.isFinite(valence) ? valence : (MOODS[label]?.valence ?? detected.valence ?? 0);
  const a = Number.isFinite(arousal) ? arousal : (MOODS[label]?.arousal ?? detected.arousal ?? 0);

  const explicit = detectGenre(prompt);
  if (explicit.explicit) {
    return { genre: explicit.genre, source: 'word', valence: v, arousal: a, mood: label };
  }
  let genre;
  if (a < -0.5) genre = 'ambient';
  else if (a > 0.3) genre = 'synthpop';
  else if (a < 0) genre = v < 0 ? 'trip-hop' : 'lofi';
  else genre = 'trip-hop';
  return { genre, source: 'va', valence: v, arousal: a, mood: label };
}

/**
 * Собирает учебник под запрос.
 *
 * @param {object} input
 * @param {string} [input.prompt] текст запроса
 * @param {string|null} [input.mood] настроение (joy/euphoria/…); если не задано — берётся из промта
 * @param {string|null} [input.genre] жанр; если задан — берётся приоритетно
 * @param {number|null} [input.valence]
 * @param {number|null} [input.arousal]
 * @returns {{text:string, skillsVersion:string, used:string[], tokens:number, truncated:string[]}}
 */
export function compileSkills(input = {}) {
  const { prompt = '', mood = null, genre = null, valence = null, arousal = null } = input;
  const skills = allSkills();

  // ── 1. жанр ──────────────────────────────────────────────────────────
  const resolved = resolveGenre({ prompt, mood, valence, arousal });
  const genreName = genre && GENRES[genre] ? genre : resolved.genre;
  const genreSkill = getSkill(`genre-${genreName}`);

  // ── 2. шаблон грува и арка: сначала карта жанра, потом GENRES ────────
  const cardText = genreSkill ? `${genreSkill.compact}\n${genreSkill.body}` : '';
  const fallback = GENRES[genreName] ?? null;
  const grooveName = parseGroove(cardText) ?? (fallback?.groove ?? null);
  const arcName = parseArc(cardText, prompt) ?? (fallback?.arc ?? null);

  // ── 3. блоки ─────────────────────────────────────────────────────────
  const grooveCard = getSkill('groove-templates');
  const harmonyCard = getSkill('harmony-recipes');
  const arcsCard = getSkill('arrangement-arcs');

  const grooveBlocks = parseNamedBlocks(grooveCard?.compact ?? '');
  const arcBlocks = parseNamedBlocks(arcsCard?.compact ?? '');
  const harmonyText = harmonyBlock(harmonyCard, resolved.mood);

  const roles = genreSkill ? parseRoles(genreSkill) : [];
  const palette = paletteFor(roles);

  // ── 4. сборка: обязательные (COMPACT) и необязательные блоки ─────────
  const required = [];
  const used = new Set();

  const addRequired = (skill, title) => {
    if (!skill) return;
    required.push(`### ${title}\n${skill.compact.trim()}`);
    used.add(skill.frontmatter.id);
  };

  for (const id of ALWAYS_ON) {
    const skill = getSkill(id);
    addRequired(skill, skill?.frontmatter.id ?? id);
  }
  if (genreSkill) addRequired(genreSkill, genreSkill.frontmatter.id);

  const optional = [];
  if (grooveName && grooveBlocks[grooveName]) {
    optional.push({
      key: `groove:${grooveName}`,
      text: `### groove-шаблон: ${grooveName}\n${grooveBlocks[grooveName]}`,
      skill: 'groove-templates',
    });
  }
  if (harmonyText) {
    optional.push({
      key: 'harmony',
      text: `### гармония (${resolved.mood ?? '—'})\n${harmonyText}`,
      skill: 'harmony-recipes',
    });
  }
  if (arcName && arcBlocks[arcName]) {
    optional.push({
      key: `arc:${arcName}`,
      text: `### арка: ${arcName}\n${arcBlocks[arcName]}`,
      skill: 'arrangement-arcs',
    });
  }
  optional.push({ key: 'palette', text: paletteText(palette, roles), skill: null });

  const examples = genreSkill?.examples ?? [];
  const exampleBlock = examples.length
    ? {
      key: 'examples',
      text: `### примеры\n\`\`\`js\n${examples.join('\n\n')}\n\`\`\``,
      skill: genreSkill.frontmatter.id,
    }
    : null;

  const truncated = [];
  const sections = [...required];
  let queue = [...optional, ...(exampleBlock ? [exampleBlock] : [])];

  const drop = (item, reason) => {
    truncated.push(`${item.key}${reason ? ` (${reason})` : ''}`);
    queue = queue.filter((candidate) => candidate !== item);
  };

  // Бюджет: режем EXAMPLES первым, потом необязательные блоки.
  if (estimateTokens(sections.join('\n\n')) > TOKEN_BUDGET && exampleBlock) {
    drop(exampleBlock, 'бюджет');
  }
  for (const item of queue) {
    const candidate = [...sections, item.text].join('\n\n');
    if (estimateTokens(candidate) > TOKEN_BUDGET) {
      drop(item, 'бюджет');
      continue;
    }
    sections.push(item.text);
    if (item.skill) used.add(item.skill);
  }

  const text = sections.join('\n\n');
  return {
    text,
    skillsVersion: skillsVersion(skills),
    used: [...used],
    tokens: estimateTokens(text),
    truncated,
  };
}
