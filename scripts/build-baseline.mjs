#!/usr/bin/env node
// Baseline-0: замороженный корпус для честного «лучше» (спринт S0.2).
//
// Зачем: пока не зафиксировано, с чем сравнивать, любое «стало лучше» —
// мнение. Baseline-0 — это 60 промтов, по которым система phase 3 (текущая
// на момент заморозки) строит план, код и символьный разбор; всё это
// подписывается sha256 и больше не меняется.
//
//   node scripts/build-baseline.mjs [--update]
//
// Что делает:
//   1. собирает 60 промтов: 4 квадранта настроения × 5 жанров × 3 плотности;
//   2. каждому промту соответствует план по правилам (planIR) и скомпилированный
//      код — то, что система умеет сегодня;
//   3. раскладывает корпус по сплиту train/val/test (36/12/12) детерминированно
//      по sha256 id: порядок по хэшу, первые 36 — train, дальше 12 — val,
//      последние 12 — test. Тест виден только при финальной проверке;
//   4. пишет manifest.json с sha256 каждого файла.
//
// Правка корпуса ломает CI (check:baseline) — это и есть заморозка.
// Пересобрать можно только осознанно: `--update` (и тогда история меняется).

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planIR } from '../src/ir/intent.js';
import { compileIR } from '../src/ir/compiler.js';
import { symbolicReport } from '../src/oracle/report.js';
import { safeValidateIR } from '../src/ir/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dir = join(root, 'corpus', 'baseline0');

const UPDATE = process.argv.includes('--update');

/** Квадранты эмоции (бриф §4.3): 4 квадранта × 5 жанров × 3 плотности = 60. */
const QUADRANTS = [
  {
    key: 'joy',
    label: 'радость/эйфория',
    moods: [
      { key: 'joy', phrases: ['радостный', 'весёлый', 'праздничный'] },
      { key: 'euphoria', phrases: ['эйфоричный', 'на подъёме', ' танцевальный'] },
    ],
  },
  {
    key: 'tender',
    label: 'нежность/ностальгия',
    moods: [
      { key: 'tender', phrases: ['нежный', 'тихий', 'ласковый'] },
      { key: 'nostalgia', phrases: ['ностальгический', 'ретро', 'кассетный'] },
    ],
  },
  {
    key: 'dark',
    label: 'мрачность/меланхолия',
    moods: [
      { key: 'melancholy', phrases: ['меланхоличный', 'грустный', 'осенний'] },
      { key: 'dark', phrases: ['мрачный', 'тёмный', 'ночной'] },
    ],
  },
  {
    key: 'anxiety',
    label: 'тревога/злость',
    moods: [
      { key: 'anxiety', phrases: ['тревожный', 'нервный', 'напряжённый'] },
      { key: 'anger', phrases: ['злой', 'агрессивный', 'яростный'] },
    ],
  },
];

/** Пять жанров стартового набора (те же, что в скил-паке). */
const GENRES = [
  { key: 'trip-hop', phrases: ['трип-хоп', 'даунтемпо'] },
  { key: 'synthpop', phrases: ['синтипоп', 'диско'] },
  { key: 'ambient', phrases: ['эмбиент', 'дрон'] },
  { key: 'dnb', phrases: 'dnb', phrasesRu: ['dnb', 'нейрофанк'] },
  { key: 'lofi', phrases: ['лоуфай', 'чилл'] },
];

/** Три плотности: редкая, средняя, плотная. */
const DENSITIES = [
  { key: 'sparse', phrases: ['разреженно, много воздуха', 'медленно и пусто'] },
  { key: 'medium', phrases: ['умеренно', 'ровно'] },
  { key: 'dense', phrases: ['плотно', 'на всю мощность'] },
];

/**
 * Собирает 60 промтов детерминированно.
 * @returns {Array<object>}
 */
function buildPrompts() {
  const prompts = [];
  let index = 0;
  for (const quadrant of QUADRANTS) {
    for (const genre of GENRES) {
      for (const density of DENSITIES) {
        const mood = quadrant.moods[index % quadrant.moods.length];
        const moodPhrase = mood.phrases[index % mood.phrases.length];
        const genrePhrase = genre.phrasesRu
          ? genre.phrasesRu[index % genre.phrasesRu.length]
          : genre.phrases[index % genre.phrases.length];
        const densityPhrase = density.phrases[index % density.phrases.length];
        index += 1;
        prompts.push({
          id: `b0-${String(index).padStart(2, '0')}`,
          prompt: `${moodPhrase} ${genrePhrase}, ${densityPhrase}`,
          quadrant: quadrant.key,
          quadrantLabel: quadrant.label,
          mood: mood.key,
          genre: genre.key,
          density: density.key,
          seed: 1000 + index,
        });
      }
    }
  }
  return prompts;
}

/**
 * Сплит по хэшу: порядок по sha256(id), первые 36 — train, 12 — val, 12 — test.
 * @param {Array<{id:string}>} prompts
 * @returns {{train:string[], val:string[], test:string[]}}
 */
function splitByHash(prompts) {
  const ordered = [...prompts].sort((a, b) => {
    const ha = createHash('sha256').update(a.id, 'utf8').digest('hex');
    const hb = createHash('sha256').update(b.id, 'utf8').digest('hex');
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  const ids = ordered.map((item) => item.id);
  return {
    train: ids.slice(0, 36),
    val: ids.slice(36, 48),
    test: ids.slice(48, 60),
  };
}

/** sha256 файла. */
function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const prompts = buildPrompts();
if (prompts.length !== 60) {
  console.error(`Ожидалось 60 промтов, получилось ${prompts.length}`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });

const promptsFile = join(dir, 'prompts.json');
const rendersFile = join(dir, 'renders.json');
const manifestFile = join(dir, 'manifest.json');

const promptsDoc = {
  version: 'baseline-0.1.0',
  createdAt: new Date().toISOString(),
  note: 'Baseline-0: 60 промтов (4 квадранта × 5 жанров × 3 плотности). Заморожен: правка ломает check:baseline.',
  prompts,
};

const renders = prompts.map((item) => {
  const ir = planIR(item.prompt, { seed: item.seed });
  const validation = safeValidateIR(ir);
  const compiled = compileIR(validation.data);
  const report = symbolicReport(validation.data);
  return {
    id: item.id,
    seed: item.seed,
    valid: validation.ok,
    bpm: report.bpm,
    key: report.key,
    genre: report.genre,
    sections: report.sections.length,
    bars: report.bars,
    score: report.score.total,
    lintErrors: report.lintSummary.errors,
    irHash: createHash('sha256').update(JSON.stringify(validation.data)).digest('hex'),
    codeHash: createHash('sha256').update(compiled.code, 'utf8').digest('hex'),
    code: compiled.code,
  };
});

const splits = splitByHash(prompts);

writeFileSync(promptsFile, `${JSON.stringify(promptsDoc, null, 2)}\n`, 'utf8');
writeFileSync(rendersFile, `${JSON.stringify({ version: promptsDoc.version, renders }, null, 2)}\n`, 'utf8');

const manifest = {
  version: promptsDoc.version,
  createdAt: promptsDoc.createdAt,
  files: {
    'prompts.json': fileHash(promptsFile),
    'renders.json': fileHash(rendersFile),
  },
  counts: { total: prompts.length, train: 36, val: 12, test: 12 },
  splits,
  note: 'Baseline-0 заморожен. Любая правка файлов корпуса ломает check:baseline — это намеренно.',
};

writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Baseline-0 собран: ${prompts.length} промтов`);
console.log(`  сплит: train ${splits.train.length} / val ${splits.val.length} / test ${splits.test.length}`);
console.log(`  промтов с lint-ошибками: ${renders.filter((item) => item.lintErrors > 0).length}`);
console.log(`  средний символьный скор: ${(renders.reduce((sum, item) => sum + item.score, 0) / renders.length).toFixed(1)}`);
console.log(`  manifest: corpus/baseline0/manifest.json`);
if (!UPDATE && existsSync(manifestFile)) {
  console.log('  (использован --update: контрольная сумма зафиксирована заново)');
}
