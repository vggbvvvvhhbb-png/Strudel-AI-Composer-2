// Сборка золотого корпуса: много треков → отбор самых разных.
//
//   node scripts/build-corpus.mjs [--count 60] [--keep 18] [--out corpus/candidates] [--dry]
//
// Что делает:
//   1. Генерирует ≥ 60 треков из форм и прогрессий библиотеки (без LLM —
//      это детерминированный черновик, а не финальные примеры).
//   2. Оставляет только валидные (код исполняется) и с высоким скором.
//   3. Из них выбирает 15–20 максимально разных — по отпечатку спеки:
//      форма + прогрессия + рецепты ролей.
//   4. Кладёт их в corpus/candidates/.
//
// ВАЖНО: few-shot примеры для модели берутся из этого корпуса только
// после того, как человек их прослушал и отметил. Скрипт сам этого
// не делает — он лишь готовит кандидатов.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from '../server/music/compiler/index.js';
import { checkSpec } from '../server/music/spec/check.js';
import { fallbackSpec, detectSpecStyle, SPEC_STYLES } from '../server/music/compose/pipeline.js';
import { analyzeTrack } from '../server/music/features.js';
import { scoreTrack } from '../server/music/score.js';
import { resolveProfile } from '../server/music/references.js';
import { runStrudel } from '../server/music/strudel-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function parseArgs(argv) {
  const args = { count: 60, keep: 18, out: join(root, 'corpus', 'candidates'), dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--count') args.count = Number(argv[i + 1]) || args.count;
    else if (arg === '--keep') args.keep = Number(argv[i + 1]) || args.keep;
    else if (arg === '--out') args.out = resolve(argv[i + 1]);
    else if (arg === '--dry') args.dry = true;
  }
  return args;
}

/**
 * Отпечаток спеки: форма + прогрессия + рецепты ролей.
 *
 * Треки с одинаковым отпечатком звучат одинаково, каким бы разным ни
 * выглядел код. Поэтому именно отпечаток решает, что «разные».
 */
export function fingerprint(spec) {
  const sections = spec.structure.sections;
  const roles = Object.entries(spec.parts.roles).sort(([a], [b]) => a.localeCompare(b));
  // Четыре компонента остаются публичным контрактом distanceBetween.
  // JSON экранирует разделитель, даже если он встречается в mini-нотации.
  const encode = (value) => JSON.stringify(value).replaceAll('|', '\\u007c');
  return [
    sections.map(({ name, cycles, energy }) => ({ name, cycles, energy })),
    sections.map(({ harmony }) => harmony),
    roles.map(([role, part]) => [role, [...part.activeIn].sort()]),
    roles.map(([role, { pattern, sound, effects }]) => [role, pattern, sound, effects || []]),
  ].map(encode).join('|');
}

/** Библиотечный план строится тем же каноническим генератором, что приложение. */
export function specFromForm(style, index) {
  const canonicalStyle = SPEC_STYLES.includes(style) ? style : detectSpecStyle(style);
  return fallbackSpec(canonicalStyle, index);
}

/**
 * Жадный отбор максимально разных: берём по очереди самый далёкий
 * от уже выбранных.
 *
 * @param {Array<{spec:object, print:object}>} items
 * @param {number} keep сколько оставить
 */
export function selectDiverse(items, keep) {
  if (items.length <= keep) return items;
  const selected = [items[0]];
  const pool = items.slice(1);

  while (selected.length < keep && pool.length) {
    let bestIndex = 0;
    let bestDistance = -1;
    for (let i = 0; i < pool.length; i += 1) {
      const distance = Math.min(
        ...selected.map((s) => distanceBetween(s.print, pool[i].print)),
      );
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    selected.push(pool[bestIndex]);
    pool.splice(bestIndex, 1);
  }
  return selected;
}

/**
 * Расстояние между отпечатками: доля различающихся частей.
 * Части: форма, гармония, роли, рецепты.
 */
export function distanceBetween(a, b) {
  const parts = (print) => print.split('|');
  const [aForm, aHarmony, aRoles, aRecipes] = parts(a);
  const [bForm, bHarmony, bRoles, bRecipes] = parts(b);
  let diff = 0;
  if (aForm !== bForm) diff += 1;
  if (aHarmony !== bHarmony) diff += 1;
  if (aRoles !== bRoles) diff += 1;
  if (aRecipes !== bRecipes) diff += 1;
  return diff / 4;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const styles = SPEC_STYLES;
  console.log(`Стилей: ${styles.length}, целевой объём: ${args.count}, оставить: ${args.keep}`);

  // 1. Генерация кандидатов.
  const candidates = [];
  let index = 0;
  while (candidates.length < args.count) {
    const style = styles[index % styles.length];
    const spec = specFromForm(style, index);
    index += 1;
    if (!spec) continue;
    const check = checkSpec(spec);
    if (!check.ok) continue;
    candidates.push({ spec: check.spec, style });
    if (index > args.count * 20) break; // защита от бесконечного цикла
  }
  console.log(`Сгенерировано кандидатов: ${candidates.length}`);

  // 2. Фильтр: валидность по исполнению + скор.
  const valid = [];
  for (const candidate of candidates) {
    const compiled = compile(candidate.spec);
    const run = await runStrudel(compiled.code, { cycles: 32 });
    if (!run.ok) continue;

    const analysis = analyzeTrack(compiled.code);
    const profile = resolveProfile(candidate.style);
    const score = scoreTrack(analysis, profile);
    if (score.total < 55) continue; // низкий скор — не в корпус

    valid.push({
      spec: candidate.spec,
      style: candidate.style,
      code: compiled.code,
      score: score.total,
      grade: score.grade,
      bars: candidate.spec.structure.sections.reduce((sum, s) => sum + s.cycles, 0),
      sections: candidate.spec.structure.sections.length,
      print: fingerprint(candidate.spec),
    });
  }
  console.log(`Прошли проверку и порог скора: ${valid.length}`);

  // 3. Отбор разных.
  valid.sort((a, b) => b.score - a.score);
  const diverse = selectDiverse(valid, args.keep);
  console.log(`Отобрано разных: ${diverse.length}`);

  // 4. Запись.
  await mkdir(args.out, { recursive: true });
  for (const file of ['index.json']) {
    const target = join(args.out, file);
    if (existsSync(target)) await rm(target);
  }

  const indexPayload = {
    createdAt: new Date().toISOString(),
    count: diverse.length,
    // Человек слушает и помечает лучшие — только они станут few-shot.
    note: 'Кандидаты. Few-shot примеры берутся из отмеченных человеком.',
    candidates: diverse.map((item, i) => ({
      id: `corpus-${String(i + 1).padStart(2, '0')}`,
      style: item.style,
      score: item.score,
      grade: item.grade,
      bars: item.bars,
      sections: item.sections,
      fingerprint: item.print,
      code: item.code,
      spec: item.spec,
      humanPick: null,
    })),
  };
  await writeFile(join(args.out, 'index.json'), JSON.stringify(indexPayload, null, 2), 'utf8');

  // Отдельные файлы с кодом — их удобно слушать и править.
  for (const item of indexPayload.candidates) {
    await writeFile(join(args.out, `${item.id}.js`), item.code, 'utf8');
  }

  console.log(`Готово: ${args.out}`);
  console.log('Следующий шаг: человек слушает кандидатов, ставит humanPick в index.json,');
  console.log('и только отобранные примеры идут в few-shot.');
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}


