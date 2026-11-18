import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, DATASET_PATH } from '../server/rag/dataset.js';
import { EDUCATION_DIRECTIONS } from '../server/rag/schema.js';
import { staticValidate } from '../src/core/validator.js';
import { runStrudel } from '../server/music/strudel-runtime.mjs';
import { checkScaleMembership } from '../server/rag/music-check.js';
import { buildTrack, fallbackSpec } from '../server/music/compose/pipeline.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { entries, errors } = loadDataset();
if (errors.length) throw new Error(JSON.stringify(errors));
const results = [];
for (const entry of entries) {
  const stat = staticValidate(entry.strudel_code);
  const run = await runStrudel(entry.strudel_code, { cycles: 4 });
  const scale = checkScaleMembership(run.parts, entry.music_tags.tonic, entry.music_tags.mode);
  const ok = stat.ok && run.ok && run.order.length > 0
    && run.order.every(p => run.parts[p].length > 0)
    && !scale.error && (entry.music_tags.chromatic ? scale.offenders.length > 0 : scale.offenders.length === 0);
  if (!ok) throw new Error(`Невалидная запись ${entry.id}`);
  results.push({ id: entry.id, events: Object.values(run.parts).reduce((sum, p) => sum + p.length, 0), pitchedEvents: scale.checked });
}
const trace = [];
const prompts = [];
let call = 0;
const built = await buildTrack({
  prompt: 'techno 132 BPM', seed: 7,
  completeChat: async ({ messages }) => {
    prompts.push({ call: call + 1, guidePresent: messages[0].content.includes('edu-guide-techno'),
      bpmFeedbackPresent: messages[1].content.includes('bpm_range') });
    const spec = fallbackSpec('techno', 7);
    spec.meta.bpm = call++ === 0 ? 110 : 132;
    return JSON.stringify(spec);
  },
  onEvent: (type, payload) => {
    if (type === 'knowledge' || type === 'genre-validation') trace.push({ type, ...payload });
  },
});
const directions = Object.fromEntries(EDUCATION_DIRECTIONS.map(d => [d, entries.filter(e => e.education?.direction === d).length]));
const originalHash = createHash('sha256').update(JSON.stringify(JSON.parse(readFileSync(DATASET_PATH, 'utf8')).slice(0, 35))).digest('hex');
const report = {
  date: new Date().toISOString(), model: 'mock; no paid calls',
  baselineRecords: 35, records: entries.length, newRecords: entries.length - 35,
  guides: entries.filter(e => e.education?.guide).length, directions,
  validation: { passed: results.length, total: entries.length, cycles: 4, entries: results },
  originalRecordsUnchanged: originalHash === '9c70eed64f80fe2af4978f472b525270e53a1b0c6e80c7afa8e7f933e1ebcf2e',
  correction: { request: 'techno 132 BPM', beforeBpm: 110, afterBpm: built.spec.meta.bpm,
    attempts: built.attempts, usedFallback: built.usedFallback, guide: built.guide, prompts, trace },
  auditoryQuality: null, auditoryReason: 'queryArc and mock corrections do not measure human listening preference',
};
const out = resolve(root, 'docs/evidence/rag/education-probe.json');
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ records: report.records, newRecords: report.newRecords, guides: report.guides, directions,
  validated: report.validation.passed, correctionAttempts: report.correction.attempts, originalRecordsUnchanged: report.originalRecordsUnchanged, evidence: out }, null, 2));
if (entries.length < 135 || Object.values(directions).some(n => n === 0)
  || !report.originalRecordsUnchanged || built.attempts !== 2 || built.usedFallback) process.exitCode = 1;
