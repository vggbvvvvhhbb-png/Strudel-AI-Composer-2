#!/usr/bin/env node
// CI-гейт для скил-карт: `npm run check:skills`.
//
// Спека: docs/SKILLS.md, раздел «CI check:skills». Проверки:
//
//   1. frontmatter валиден (Zod), id уникальны, refs существуют;
//   2. все обязательные секции тела на месте;
//   3. COMPACT ≤ 400 токенов;
//   4. каждый ```js из EXAMPLES проходит dry-parse (headless Strudel, без звука)
//      и линтер примеров: лад, guardrails, запрещённые конструкции;
//   5. guardrails paramRanges: bpm 40..200; |offset| ≤ 20 мс;
//      lufsTarget −24..−8; delayfeedback < 1; gain ≤ 1.2; duckdepth ≤ 1;
//   6. изменение тела без bump version → fail (замок в skills/lock.json);
//   7. scoreHistory: у каждой записи есть method и n ≥ 1.
//
// Флаги:
//   --update  перезаписать skills/lock.json (после осознанного bump version);
//   --json     вывести только JSON.
//
// Код возврата: 0 — все проверки пройдены, 1 — есть ошибки.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSkills, skillIndex, skillsVersion } from '../server/skills/loader.js';
import { estimateTokens, TOKEN_BUDGET, resolveGenre } from '../server/skills/compile.js';
import { lintExample } from '../server/skills/lint.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const skillsDir = join(root, 'skills');
const lockFile = join(skillsDir, 'lock.json');
const evidenceFile = join(root, 'docs', 'evidence', 'skills', 'check-skills.json');

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const JSON_ONLY = args.includes('--json');

/**
 * Пределы из docs/SKILLS.md и из самих карт.
 * Диапазон карты обязан лежать внутри предела; ключи без предела — только
 * проверка порядка границ (min ≤ max), они попадают в список «без предела».
 */
const RANGE_GUARDRAILS = {
  // docs/SKILLS.md, раздел «CI check:skills»
  bpm: { min: 40, max: 200 },
  lufsTarget: { min: -24, max: -8 },
  offsetMs: { min: -20, max: 20 },
  delayfeedback: { max: 1, exclusive: true },
  gain: { max: 1.2, exclusive: false },
  duckdepth: { max: 1, exclusive: false },
  // пределы, зафиксированные в картах и в схеме IR
  density: { max: 20, exclusive: false },      // emotion-map: «плотность > 20/с — каша»
  swingRatio: { min: 0.5, max: 0.68 },        // схема IR: swing 0.5…0.68
  velocity: { max: 1, exclusive: false },
  energy: { min: 0, max: 1 },
  sections: { min: 3, max: 16 },               // §4.2: не меньше трёх секций
  llmCallsCompose: { max: 2, exclusive: false },   // §10: бюджет LLM
  refineIterations: { max: 3, exclusive: false },  // §5.4: не больше трёх итераций
};

/** Предел COMPACT в токенах (docs/SKILLS.md). */
const COMPACT_TOKEN_LIMIT = 400;

const errors = [];
const warnings = [];
const info = [];

/**
 * @param {string} where где найдено
 * @param {string} code код проблемы
 * @param {string} message что не так
 */
function fail(where, code, message) {
  errors.push({ where, code, message });
}

/**
 * @param {string} where
 * @param {string} code
 * @param {string} message
 */
function warn(where, code, message) {
  warnings.push({ where, code, message });
}

// ─── 1. Загрузка и структура ──────────────────────────────────────────────

let cards = [];
try {
  cards = loadSkills({ dir: skillsDir });
} catch (err) {
  fail('skills/', 'parse', `карты не разобрались: ${err.message}`);
}

const seenIds = new Set();
for (const card of cards) {
  const front = card.frontmatter;
  const where = `skills/${front.id}`;
  if (seenIds.has(front.id)) fail(where, 'duplicate-id', `id «${front.id}» повторяется`);
  seenIds.add(front.id);

  for (const ref of front.refs) {
    if (!seenIds.has(ref) && ref !== front.id) {
      // refs могут указывать на карты, которые читаются позже — проверяем после цикла.
    }
  }

  const tokens = estimateTokens(card.compact);
  if (tokens > COMPACT_TOKEN_LIMIT) {
    fail(where, 'compact-too-long', `COMPACT ${tokens} токенов > ${COMPACT_TOKEN_LIMIT}`);
  }
  if (!card.examples.length) {
    warn(where, 'no-examples', 'в EXAMPLES нет ни одного ```js-блока');
  }
  for (const [index, entry] of Object.entries(front.scoreHistory)) {
    if (!entry.method) fail(where, 'score-history-method', `scoreHistory[${index}] без метода`);
    if (!Number.isFinite(entry.n) || entry.n < 1) {
      fail(where, 'score-history-n', `scoreHistory[${index}]: n должен быть ≥ 1`);
    }
  }
}

// refs существуют
for (const card of cards) {
  for (const ref of card.frontmatter.refs) {
    if (!seenIds.has(ref)) {
      fail(`skills/${card.frontmatter.id}`, 'broken-ref', `ref «${ref}» не существует`);
    }
  }
}

// ─── 2. Реестр INDEX.md ───────────────────────────────────────────────────

const indexFile = join(skillsDir, 'INDEX.md');
if (!existsSync(indexFile)) {
  fail('skills/INDEX.md', 'missing', 'реестр карт не найден');
} else {
  const indexText = readFileSync(indexFile, 'utf8');
  const registry = indexText.split('\n').filter((line) => /^\|\s*[a-z0-9-]+\s*\|/.test(line));
  const registryIds = new Set();
  for (const line of registry) {
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const [id, kind, version] = cells;
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    registryIds.add(id);
    const card = cards.find((item) => item.frontmatter.id === id);
    if (!card) {
      fail('skills/INDEX.md', 'registry-unknown', `карта «${id}» указана в реестре, но файла нет`);
      continue;
    }
    if (card.frontmatter.kind !== kind) {
      fail('skills/INDEX.md', 'registry-kind', `«${id}»: в реестре kind=${kind}, в карте ${card.frontmatter.kind}`);
    }
    if (card.frontmatter.version !== version) {
      fail('skills/INDEX.md', 'registry-version', `«${id}»: в реестре ${version}, в карте ${card.frontmatter.version}`);
    }
  }
  for (const card of cards) {
    if (!registryIds.has(card.frontmatter.id)) {
      fail('skills/INDEX.md', 'registry-missing', `карта «${card.frontmatter.id}» не в реестре`);
    }
  }
}

// ─── 3. Guardrails paramRanges ────────────────────────────────────────────

for (const card of cards) {
  const where = `skills/${card.frontmatter.id}`;
  for (const [key, range] of Object.entries(card.frontmatter.paramRanges)) {
    if (!Array.isArray(range) || range.length !== 2) {
      fail(where, 'param-range-shape', `paramRanges.${key}: ожидается пара чисел`);
      continue;
    }
    const [min, max] = range;
    if (!(min <= max)) {
      fail(where, 'param-range-order', `paramRanges.${key}: ${min} > ${max}`);
      continue;
    }
    const guard = RANGE_GUARDRAILS[key];
    if (!guard) {
      info.push({ where, code: 'param-range-unbounded', message: `paramRanges.${key}: предел не описан — проверен только порядок границ` });
      continue;
    }
    if (guard.min !== undefined && (min < guard.min || max > guard.max)) {
      fail(where, 'param-range-guard', `paramRanges.${key}: [${min}, ${max}] выходит за ${guard.min}..${guard.max}`);
    }
    if (guard.max !== undefined) {
      const bad = guard.exclusive ? max >= guard.max : max > guard.max;
      if (bad) {
        fail(where, 'param-range-guard', `paramRanges.${key}: максимум ${max} нарушает предел ${guard.max}`);
      }
    }
  }
}

// ─── 4. Примеры: dry-parse + линтер ───────────────────────────────────────

const exampleResults = [];
for (const card of cards) {
  const where = `skills/${card.frontmatter.id}`;
  for (const [index, code] of card.examples.entries()) {
    const result = await lintExample(code);
    exampleResults.push({
      id: card.frontmatter.id,
      index,
      ok: result.ok,
      errors: result.errors,
      voices: result.voices,
      events: result.events,
    });
    for (const finding of result.errors) {
      fail(`${where}#${index}`, finding.code, finding.message);
    }
  }
}

// ─── 5. Замок версий: тело меняется → растёт версия ──────────────────────

const bodyHash = (card) => createHash('sha256').update(card.body, 'utf8').digest('hex');

let lock = { cards: {} };
if (existsSync(lockFile)) {
  try {
    lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch (err) {
    fail('skills/lock.json', 'lock-parse', `замок не разобран: ${err.message}`);
  }
}
const lockCards = lock.cards ?? {};

const nextLock = { version: 1, cards: {} };
let lockChanged = false;

for (const card of cards) {
  const id = card.frontmatter.id;
  const hash = bodyHash(card);
  const previous = lockCards[id];
  nextLock.cards[id] = { version: card.frontmatter.version, bodyHash: hash };
  if (!previous) {
    // В режиме обновления замка это не ошибка, а то, ради чего запустили.
    if (UPDATE) {
      info.push({ where: `skills/${id}`, code: 'lock-missing', message: 'карты не было в замке — добавлена' });
    } else {
      fail(`skills/${id}`, 'lock-missing', 'карты нет в замке — запусти `npm run check:skills -- --update`');
    }
    lockChanged = true;
    continue;
  }
  if (previous.bodyHash !== hash && previous.version === card.frontmatter.version) {
    fail(
      `skills/${id}`,
      'version-not-bumped',
      `тело изменено, версия осталась ${card.frontmatter.version} — подними версию и обнови замок`,
    );
    lockChanged = true;
  }
  if (previous.version !== card.frontmatter.version && previous.bodyHash === hash) {
    warn(`skills/${id}`, 'version-bump-without-change', `версия ${card.frontmatter.version}, тело не менялось`);
  }
}

for (const id of Object.keys(lockCards)) {
  if (!seenIds.has(id)) {
    fail(`skills/${id}`, 'lock-orphan', 'карта удалена, но осталась в замке');
    lockChanged = true;
  }
}

if (UPDATE && lockChanged) {
  writeFileSync(lockFile, `${JSON.stringify(nextLock, null, 2)}\n`, 'utf8');
}

// ─── 6. Сводка ────────────────────────────────────────────────────────────

const index = skillIndex();
const summary = {
  checkedAt: new Date().toISOString(),
  cards: cards.length,
  skillsVersion: skillsVersion(cards),
  compactTokens: Object.fromEntries(cards.map((card) => [card.frontmatter.id, estimateTokens(card.compact)])),
  examples: exampleResults.length,
  examplesOk: exampleResults.filter((item) => item.ok).length,
  errors: errors.length,
  warnings: warnings.length,
  info: info.length,
  errorList: errors,
  warningList: warnings,
  infoList: info,
  genreForPrompt: resolveGenre({ prompt: 'мрачный трип-хоп про дождь' }).genre,
  index: Object.keys(index).length,
};

mkdirSync(dirname(evidenceFile), { recursive: true });
writeFileSync(evidenceFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

if (JSON_ONLY) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Скил-карты: ${summary.cards}, версия пака ${summary.skillsVersion.slice(0, 12)}`);
  console.log(`Примеры: ${summary.examplesOk}/${summary.examples} прошли dry-parse и линтер`);
  for (const [id, tokens] of Object.entries(summary.compactTokens)) {
    console.log(`  ${id.padEnd(22)} COMPACT ${String(tokens).padStart(3)} токенов`);
  }
  if (warnings.length) {
    console.log(`\nПредупреждения (${warnings.length}):`);
    for (const item of warnings) console.log(`  ! ${item.where}: ${item.message}`);
  }
  if (errors.length) {
    console.log(`\nОшибки (${errors.length}):`);
    for (const item of errors) console.log(`  ✗ ${item.where} [${item.code}]: ${item.message}`);
  } else {
    console.log('\nВсе проверки пройдены.');
  }
  console.log(`\nДоказательство: docs/evidence/skills/check-skills.json`);
}

if (errors.length) process.exit(1);
if (UPDATE && lockChanged) console.log('Замок обновлён: skills/lock.json');
