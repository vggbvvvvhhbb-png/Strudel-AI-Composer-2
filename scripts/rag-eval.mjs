// Фаза H (D-141): оценка качества на 20 фиксированных запросах.
// Три режима: plain (старый промпт system.md, без RAG и петли),
// rag (новый промпт + топ-3 примеров, одна попытка), rag-loop (петля до 3).
// Живая модель через существующий completeChat (relay.fast, D-120).
// Запуск: node scripts/rag-eval.mjs [--limit N] [--mode plain|rag|rag-loop]
//         [--set base|stress]
// Стресс-набор (D-144): 18 намеренно трудных запросов — экзотические лады
// (ловушки empty-part/scale), несуществующие тембры (unknown-sound),
// сложные структуры (syntax/runtime). Цель — поймать ЖИВЫЕ коррекции петли
// (в E-021 их было 0: все ответы валидны с первой попытки).
// Evidence: docs/evidence/rag/eval.json (base) / eval-stress.json (stress).
// Метрики: валидность, соответствие ладу/тоники/темпа, реальные звуки,
// попытки, токены, коррекции. Отрицательные результаты фиксируются как есть.

import 'dotenv/config';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../server/rag/dataset.js';
import { LocalKnowledgeStore } from '../server/rag/store-local.js';
import { SupabaseKnowledgeStore } from '../server/rag/store-supabase.js';
import { embedQuery } from '../server/rag/embeddings.js';
import { runCorrectionLoop } from '../server/rag/loop.js';
import { buildMessages } from '../server/rag/prompt.js';
import { parseAssistantResponse } from '../server/rag/parse-response.js';
import { validateGeneratedCode, parseKeyCode, extractSoundNames } from '../server/rag/code-validator.js';
import { loadTimbreCatalog } from '../server/samples/timbre.js';
import { completeChat } from '../server/llm/client.js';
import { getBpm } from '../src/core/code-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

const argv = process.argv.slice(2);
const setName = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : 'base';
const output = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const EVIDENCE = resolve(ROOT, output || `docs/evidence/rag/${setName === 'stress' ? 'eval-stress.json' : 'eval.json'}`);
const localOnly = argv.includes('--local-only');

const REQUESTS = [
  { id: 'r01', request: 'тёплые джазовые аккорды для lofi в ля миноре, 78 BPM', expect: { tonic: 'a', mode: 'minor', bpm: 78 } },
  { id: 'r02', request: 'кислотный бас для техно в фа миноре, 132 BPM', expect: { tonic: 'f', mode: 'minor', bpm: 132 } },
  { id: 'r03', request: 'прямая house-бочка с клэпом и хэтами, 124 BPM', expect: { bpm: 124, sound: 'bd' } },
  { id: 'r04', request: 'трэповые хэты с роллами, 140 BPM', expect: { bpm: 140, sound: 'hh' } },
  { id: 'r05', request: 'редкий 808 саб для трэпа в ля миноре, 140 BPM', expect: { tonic: 'a', mode: 'minor', bpm: 140 } },
  { id: 'r06', request: 'эпические струны для кино в ми миноре, 90 BPM', expect: { tonic: 'e', mode: 'minor', bpm: 90 } },
  { id: 'r07', request: 'арфовый пассаж на две октавы в до мажоре, 80 BPM', expect: { tonic: 'c', mode: 'major', bpm: 80 } },
  { id: 'r08', request: 'контрабас пиццикато в соль миноре, 110 BPM', expect: { tonic: 'g', mode: 'minor', bpm: 110 } },
  { id: 'r09', request: 'джазовый ii-V-I в до мажоре на пианино, 110 BPM', expect: { tonic: 'c', mode: 'major', bpm: 110 } },
  { id: 'r10', request: 'шагающий бас в си бемоль мажоре, 120 BPM', expect: { tonic: 'bb', mode: 'major', bpm: 120 } },
  { id: 'r11', request: 'синкопированный фанк-бас в соль дорийском, 108 BPM', expect: { tonic: 'g', mode: 'dorian', bpm: 108 } },
  { id: 'r12', request: 'синтвейв-арпеджио в ля миноре, 100 BPM', expect: { tonic: 'a', mode: 'minor', bpm: 100 } },
  { id: 'r13', request: 'пространный эмбиент-пэд в ре дорийском, 60 BPM', expect: { tonic: 'd', mode: 'dorian', bpm: 60 } },
  { id: 'r14', request: 'светлый лидийский эмбиент в до, 66 BPM', expect: { tonic: 'c', mode: 'lydian', bpm: 66 } },
  { id: 'r15', request: 'фригийская мелодия с малой секундой в ми, 95 BPM', expect: { tonic: 'e', mode: 'phrygian', bpm: 95 } },
  { id: 'r16', request: 'мелодия в ля гармоническом миноре на скрипке, 90 BPM', expect: { tonic: 'a', mode: 'harmonic-minor', bpm: 90 } },
  { id: 'r17', request: 'роковый рифф в ми миноре, 120 BPM', expect: { tonic: 'e', mode: 'minor', bpm: 120 } },
  { id: 'r18', request: 'миксолидийский роковый гимн в ля, 128 BPM', expect: { tonic: 'a', mode: 'mixolydian', bpm: 128 } },
  { id: 'r19', request: 'фонк-мелодия на коубелле в до миноре, 132 BPM', expect: { tonic: 'c', mode: 'minor', bpm: 132, sound: '808mc' } },
  { id: 'r20', request: 'глубокие house-нонаккорды в соль миноре, 122 BPM', expect: { tonic: 'g', mode: 'minor', bpm: 122 } },
];

// Стресс-набор (D-144): трудные, но выполнимые запросы. Экзотические лады
// вне MODE_INTERVALS валидатора (мелодический минор, целотонная, венгерский
// минор, фригийская доминанта) проверяются только на валидность/темп:
// parseKeyCode их не знает, тоник/лад машинно не проверить — честно.
const STRESS_REQUESTS = [
  { id: 's01', request: 'мелодия в ми гармоническом миноре с повышенной седьмой ступенью на скрипке, 92 BPM', expect: { tonic: 'e', mode: 'harmonic-minor', bpm: 92 } },
  { id: 's02', request: 'джазовая мелодия в ля мелодическом миноре на пианино, 105 BPM', expect: { bpm: 105 } },
  { id: 's03', request: 'мрачный локрийский рифф в си, 110 BPM', expect: { tonic: 'b', mode: 'locrian', bpm: 110 } },
  { id: 's04', request: 'целотонная гамма в до для эмбиент-пэда, 66 BPM', expect: { bpm: 66 } },
  { id: 's05', request: 'мелодия в ре венгерском миноре на струнных, 95 BPM', expect: { bpm: 95 } },
  { id: 's06', request: 'испанская мелодия во фригийской доминанте в ми, 105 BPM', expect: { bpm: 105 } },
  { id: 's07', request: 'терменвокс-подобный плывущий лид в ре миноре, 80 BPM', expect: { tonic: 'd', mode: 'minor', bpm: 80 } },
  { id: 's08', request: 'волыночный дрон с наигрышем в соль мажоре, 90 BPM', expect: { tonic: 'g', mode: 'major', bpm: 90 } },
  { id: 's09', request: 'стеклянная гармоника в до мажоре, 70 BPM', expect: { tonic: 'c', mode: 'major', bpm: 70 } },
  { id: 's10', request: 'мрачные струнные из каталога Timbre Palette для кино в ре миноре, 85 BPM', expect: { tonic: 'd', mode: 'minor', bpm: 85 } },
  { id: 's11', request: 'полиритмия 3 на 4: трэповые хэты против шагающего баса в фа миноре, 120 BPM', expect: { tonic: 'f', mode: 'minor', bpm: 120 } },
  { id: 's12', request: 'евклидовы ритмы cp(3,8) и bd(5,8) для техно, 128 BPM', expect: { bpm: 128, sound: 'cp' } },
  { id: 's13', request: 'трёхчастная форма через arrange: интро, куплет, припев в ля миноре, 124 BPM', expect: { tonic: 'a', mode: 'minor', bpm: 124 } },
  { id: 's14', request: 'джазовые аккорды Fmaj7 и Cmaj7 в до мажоре на пианино, 110 BPM', expect: { tonic: 'c', mode: 'major', bpm: 110 } },
  { id: 's15', request: 'джазовый ii-V-I с нонаккордами в си бемоль мажоре, 115 BPM', expect: { tonic: 'bb', mode: 'major', bpm: 115 } },
  { id: 's16', request: 'балканский ритм на 7 долей в ре миноре, 140 BPM', expect: { tonic: 'd', mode: 'minor', bpm: 140 } },
  { id: 's17', request: 'быстрый свингующий бас в соль миноре, 160 BPM', expect: { tonic: 'g', mode: 'minor', bpm: 160 } },
  { id: 's18', request: 'плотный многослойный трэп-бит: 808, хэты с роллами, клэп, перкуссия и пэд в до миноре, 132 BPM', expect: { tonic: 'c', mode: 'minor', bpm: 132 } },
];

const REQUEST_SETS = { base: REQUESTS, stress: STRESS_REQUESTS };
const CHOSEN = REQUEST_SETS[setName];
if (!CHOSEN) throw new Error(`неизвестный набор --set ${setName} (base|stress)`);

const limit = Number(argv[argv.indexOf('--limit') + 1]) || CHOSEN.length;
const offset = Number(argv[argv.indexOf('--offset') + 1]) || 0;
const onlyMode = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : null;
const MODES = onlyMode ? [onlyMode] : ['plain', 'rag', 'rag-loop'];

const catalog = loadTimbreCatalog();
const { entries } = loadDataset();
const oldSystem = readFileSync(resolve(ROOT, 'server/prompts/system.md'), 'utf8');

function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_DB_HOST && process.env.SUPABASE_DB_USER && process.env.SUPABASE_DB_PASSWORD);
}

async function makeStore() {
  if (!localOnly && supabaseConfigured()) {
    const pg = (await import('pg')).default;
    const { dbConfigFromEnv } = await import('../server/rag/db.js');
    const client = new pg.Client(dbConfigFromEnv());
    await client.connect();
    return { store: new SupabaseKnowledgeStore(client), kind: 'supabase', close: () => client.end() };
  }
  return { store: new LocalKnowledgeStore(entries), kind: 'local', close: async () => {} };
}

/** Соответствие ожиданиям запроса — машинно-проверяемое. */
function expectationScore(code, expect) {
  const checks = [];
  const key = parseKeyCode(code);
  if (expect.tonic) checks.push({ name: 'tonic', ok: key?.tonic === expect.tonic });
  if (expect.mode) checks.push({ name: 'mode', ok: key?.mode === expect.mode });
  if (expect.bpm) checks.push({ name: 'bpm', ok: getBpm(code) === expect.bpm });
  if (expect.sound) checks.push({ name: 'sound', ok: extractSoundNames(code).includes(expect.sound) });
  const met = checks.filter((c) => c.ok).length;
  return { met, total: checks.length, checks };
}

const results = [];
const usageTotal = { prompt: 0, completion: 0, calls: 0 };
const onUsage = (u) => {
  usageTotal.calls += 1;
  usageTotal.prompt += u.prompt_tokens ?? u.input_tokens ?? 0;
  usageTotal.completion += u.completion_tokens ?? u.output_tokens ?? 0;
};

const { store, kind, close } = await makeStore();
console.log(`набор: ${setName}, хранилище: ${kind}, запросов: ${Math.min(limit, CHOSEN.length)}, режимы: ${MODES.join(', ')}`);
const startedAt = Date.now();

try {
  for (const spec of CHOSEN.slice(offset, offset + limit)) {
    const emb = await embedQuery(spec.request);
    const queryEmbedding = emb.ok ? emb.embedding : null;
    for (const mode of MODES) {
      const t0 = Date.now();
      let record = { id: spec.id, mode, request: spec.request };
      try {
        if (mode === 'plain') {
          const text = await completeChat({
            messages: [{ role: 'system', content: oldSystem }, { role: 'user', content: spec.request }],
            feature: 'rag-eval', temperature: 0.3, onUsage,
          });
          const parsed = parseAssistantResponse(text);
          const v = parsed.ok
            ? await validateGeneratedCode(parsed.code, { catalog })
            : { ok: false, errors: [{ class: 'no-code', message: parsed.error }] };
          record = { ...record, ok: v.ok, attempts: 1, code: parsed.code || '', errors: v.errors, expectation: parsed.code ? expectationScore(parsed.code, spec.expect) : { met: 0, total: 0, checks: [] } };
        } else {
          const r = await runCorrectionLoop({
            request: spec.request,
            store,
            catalog,
            queryEmbedding,
            maxAttempts: mode === 'rag-loop' ? 3 : 1,
            callModel: (messages) => completeChat({ messages, feature: 'rag-eval', temperature: 0.3, onUsage }),
          });
          record = {
            ...record, ok: r.ok, attempts: r.attempts, code: r.code || '',
            errors: r.ok ? [] : (r.errors || []),
            errorClasses: r.history.flatMap((h) => (h.errors || []).map((e) => e.class)),
            searchStage: r.search?.stage,
            expectation: r.code ? expectationScore(r.code, spec.expect) : { met: 0, total: 0, checks: [] },
          };
        }
      } catch (err) {
        record = { ...record, ok: false, attempts: 0, code: '', errors: [{ class: 'llm', message: String(err.message) }], expectation: { met: 0, total: 0, checks: [] } };
      }
      record.ms = Date.now() - t0;
      results.push(record);
      const exp = record.expectation;
      console.log(`${spec.id} ${mode.padEnd(8)} ${record.ok ? 'OK ' : 'FAIL'} попыток:${record.attempts} ожидания:${exp.met}/${exp.total} ${(record.ms / 1000).toFixed(1)}с ${record.ok ? '' : (record.errors || []).map((e) => e.class).join(',')}`);
    }
    // Страховка длинного прогона: частичные результаты на диск после каждого запроса.
    writeFileSync(`${EVIDENCE}.partial`, JSON.stringify({ results, usageTotal }, null, 2));
  }
} finally {
  await close();
}

const summary = {};
for (const mode of MODES) {
  const rs = results.filter((r) => r.mode === mode);
  const valid = rs.filter((r) => r.ok).length;
  const expMet = rs.reduce((s, r) => s + r.expectation.met, 0);
  const expTotal = rs.reduce((s, r) => s + r.expectation.total, 0);
  const scaleFails = rs.filter((r) => (r.errors || []).some((e) => e.class === 'scale')).length;
  const soundFails = rs.filter((r) => (r.errors || []).some((e) => e.class === 'unknown-sound')).length;
  // Живые коррекции петли: первая попытка упала, финальный код валиден.
  const corrected = rs.filter((r) => r.ok && r.attempts > 1).length;
  const firstAttemptFails = rs.filter((r) => (r.errorClasses || []).length > 0 || (!r.ok && r.attempts >= 1)).length;
  summary[mode] = {
    requests: rs.length,
    valid, validShare: Number((valid / rs.length).toFixed(3)),
    expectationMet: expMet, expectationTotal: expTotal,
    expectationShare: expTotal ? Number((expMet / expTotal).toFixed(3)) : null,
    scaleFailRequests: scaleFails, unknownSoundRequests: soundFails,
    correctedRequests: corrected, firstAttemptFailRequests: firstAttemptFails,
    avgAttempts: Number((rs.reduce((s, r) => s + r.attempts, 0) / rs.length).toFixed(2)),
    avgMs: Math.round(rs.reduce((s, r) => s + r.ms, 0) / rs.length),
  };
}

const report = {
  date: new Date().toISOString(),
  set: setName,
  store: kind,
  semantic: Boolean(await embedQuery('проверка').then((r) => r.ok).catch(() => false)),
  durationMs: Date.now() - startedAt,
  usage: usageTotal,
  summary,
  results,
};
mkdirSync(dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, JSON.stringify(report, null, 2));
rmSync(`${EVIDENCE}.partial`, { force: true });
console.log('\n=== СВОДКА ===');
for (const [mode, s] of Object.entries(summary)) {
  console.log(`${mode.padEnd(8)} валидных ${s.valid}/${s.requests} (${s.validShare}), ожидания ${s.expectationMet}/${s.expectationTotal} (${s.expectationShare}), лад-ошибки ${s.scaleFailRequests}, выдуманные звуки ${s.unknownSoundRequests}, коррекций ${s.correctedRequests}, ср.попыток ${s.avgAttempts}`);
}
console.log(`токены: prompt ${usageTotal.prompt}, completion ${usageTotal.completion}, вызовов ${usageTotal.calls}`);
console.log(`Evidence: ${EVIDENCE}`);