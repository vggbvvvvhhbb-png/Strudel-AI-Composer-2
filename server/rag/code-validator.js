// Валидатор сгенерированного Strudel-кода (D-139, фаза F).
// Классы ошибок: syntax, runtime, empty-part, scale (нота вне лада,
// с тактом), unknown-sound (выдуманный сэмпл/пресет). Ошибки структурные —
// годятся для фидбека модели в петле self-correction. Проверяется то,
// что звучит (queryArc), а не текст.

import { staticValidate, parseErrorLocation } from '../../src/core/validator.js';
import { checkRules } from '../../src/core/rules.js';
import { runStrudel } from '../music/strudel-runtime.mjs';
import { normalizeTonic, pitchClassOfNote, scalePitchClasses } from './music-check.js';
import { getKey } from '../../src/core/code-model.js';
import { loadVoiceRules } from './prompt.js';

const MODE_ALIASES = { harmonicminor: 'harmonic-minor', 'harmonic minor': 'harmonic-minor', aeolian: 'minor', ionian: 'major' };

/** Разбор key="tonic:mode" из кода в нормализованную пару или null. */
export function parseKeyCode(code) {
  const key = getKey(code);
  if (!key || !key.includes(':')) return null;
  const [tonicRaw, modeRaw] = key.split(':');
  const tonic = normalizeTonic(tonicRaw);
  const mode = MODE_ALIASES[modeRaw.trim().toLowerCase()] || modeRaw.trim().toLowerCase();
  if (!tonic || !scalePitchClasses(tonic, mode)) return null;
  return { tonic, mode };
}

/** Имена звуков из .s("...") с очисткой mini-синтаксиса. */
export function extractSoundNames(code) {
  const names = new Set();
  for (const m of String(code).matchAll(/(?<![A-Za-z0-9_])\.?s\(\s*"([^"]+)"\s*\)/g)) {
    for (const token of m[1].match(/[A-Za-z0-9_]+/g) || []) {
      if (/^\d+$/.test(token)) continue; // числа mini-нотации (hh*8, cp(3,8))
      names.add(token);
    }
  }
  return [...names];
}

/**
 * Полная валидация кода.
 * @param {string} code
 * @param {{catalog: object, voice?: object, cycles?: number, key?: {tonic: string, mode: string}}} opts
 * @returns {Promise<{ok: boolean, errors: object[], warnings: object[], stats: object}>}
 */
export async function validateGeneratedCode(code, { catalog, voice = loadVoiceRules(), cycles = 8, key = null }) {
  const errors = [];
  const warnings = [];
  const stat = staticValidate(code);
  if (!stat.ok) {
    errors.push({ class: 'syntax', line: stat.error?.line ?? 0, message: stat.error?.message || 'синтаксическая ошибка' });
    return { ok: false, errors, warnings, stats: { parts: 0, events: 0 } };
  }

  const run = await runStrudel(code, { cycles });
  if (!run.ok) {
    const loc = parseErrorLocation(run.error, code);
    errors.push({ class: 'runtime', line: loc.line, message: loc.message });
    return { ok: false, errors, warnings, stats: { parts: run.order.length, events: 0 } };
  }

  let events = 0;
  for (const part of run.order) {
    const n = run.parts[part].length;
    events += n;
    if (n === 0) errors.push({ class: 'empty-part', part, message: `партия ${part} не даёт событий` });
  }

  // Правила линтера R1–R7: ловят «тихие пустоты» — код исполняется, а звука нет.
  // Ошибка правила = код чинить; предупреждение = код играет не так, как читается.
  const rules = checkRules(code);
  for (const finding of rules.errors) {
    errors.push({ class: 'rule', id: finding.id, line: finding.line, message: finding.message });
  }
  for (const finding of rules.warnings) {
    warnings.push({ class: 'rule', id: finding.id, line: finding.line, message: finding.message });
  }

  // Принадлежность ладу: по звучащим высотам, с номером такта.
  const keyPair = key || parseKeyCode(code);
  if (keyPair) {
    const scale = new Set(scalePitchClasses(keyPair.tonic, keyPair.mode));
    for (const [part, haps] of Object.entries(run.parts)) {
      for (const hap of haps) {
        const value = hap.value;
        const note = value && typeof value === 'object' ? value.note : (typeof value === 'string' ? value : null);
        const pc = pitchClassOfNote(note);
        if (pc === null || scale.has(pc)) continue;
        const bar = Math.floor(Number(hap.whole?.begin ?? 0)) + 1;
        errors.push({
          class: 'scale', part, bar,
          message: `нота ${note} не входит в ${keyPair.tonic} ${keyPair.mode} (такт ${bar}, партия ${part})`,
        });
      }
    }
  }

  // Реальность звуков: tp_* — только из каталога, остальные — белый список.
  const aliases = new Set(Object.values(catalog.presets || {}).map((p) => p.strudelAlias));
  const known = new Set([...voice.samples, ...voice.synths]);
  for (const name of extractSoundNames(code)) {
    if (name.startsWith('tp_')) {
      if (!aliases.has(name)) {
        errors.push({ class: 'unknown-sound', message: `пресет «${name}» отсутствует в каталоге Timbre Palette — не выдумывай пресеты` });
      }
    } else if (!known.has(name)) {
      errors.push({ class: 'unknown-sound', message: `звук «${name}» не из белого списка — сэмпл без файла молчит` });
    }
  }

  return { ok: errors.length === 0, errors, warnings, stats: { parts: run.order.length, events, cycles } };
}

/** Структурный фидбек модели по ошибкам валидации (русский, с тактами). */
export function feedbackFromErrors(errors) {
  const lines = errors.map((e) => `- [${e.class}] ${e.message}`);
  return [
    'Валидатор отклонил код. Исправь ТОЛЬКО перечисленные ошибки и верни полный код в том же формате',
    '(обоснование + блок ```strudel). Остальное сохрани без изменений:',
    ...lines,
  ].join('\n');
}