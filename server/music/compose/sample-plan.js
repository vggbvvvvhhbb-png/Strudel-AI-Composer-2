// Паспорт звука → план трека (фаза E, D-119).
//
// ЗАЧЕМ. «Охотник» находит редкий звук и измеряет его (паспорт, D-115).
// Но композитор строил бит вокруг НАЗВАНИЯ звука, а не вокруг измеренных
// признаков. Здесь измеренное становится музыкальным решением:
//   тон (f0)        → тональность трека;
//   темп атак       → BPM (только при достаточной уверенности);
//   плотность атак  → ритмический рисунок партии сэмпла;
//   центроид        → характер (яркий/тёмный) — в текст плана для модели.
//
// ЧЕСТНОСТЬ. Каждый признак может быть «нет данных»: низкая уверенность
// темпа или малая доля тональных кадров НЕ превращаются в выдуманное
// число. Причина отказа видна в sources и уходит в панель агента.

import { PITCH_NAMES } from '../notes.js';

/** Ниже этой уверенности темп не считается измеренным (D-119). */
export const TEMPO_CONFIDENCE_MIN = 0.3;
/** Ниже этой доли тональных кадров тон не считается надёжным (D-119). */
export const VOICED_RATIO_MIN = 0.3;

/** Имя сэмпла пула в коде: только слова/цифры/подчёркивание (требование компилятора). */
export function sampleSoundName(id) {
  const clean = String(id ?? '').replace(/[^\w]/g, '_');
  return `hunter_${clean}`;
}

/** Атак на такт из измеренной плотности при данном темпе (4/4). */
export function attacksFromDensity(densityPerSec, bpm) {
  if (!Number.isFinite(densityPerSec) || densityPerSec <= 0) return null;
  const secondsPerBar = 240 / (Number.isFinite(bpm) && bpm > 0 ? bpm : 120);
  return Math.min(16, Math.max(1, Math.round(densityPerSec * secondsPerBar)));
}

/**
 * Измеренные признаки паспорта → музыкальные подсказки.
 *
 * @param {object|null} passport
 * @returns {{key:string|null, bpm:number|null, attacksPerBar:number|null,
 *            character:string[], centroidHz:number|null, sources:object}}
 */
export function passportHints(passport) {
  const p = passport ?? {};
  const sources = {};

  let key = null;
  const note = p.tonal?.note;
  const voiced = p.tonal?.voicedRatio;
  if (typeof note === 'string' && /^[A-G]#?$/.test(note) && Number.isFinite(voiced) && voiced >= VOICED_RATIO_MIN) {
    // Лад из одного тона не измерить: минор — осознанное допущение, не замер.
    key = `${note}min`;
    sources.key = `измеренный тон ${note} (f0 ${p.tonal?.f0Hz ?? '?'} Гц, тональных кадров ${(voiced * 100).toFixed(0)}%); лад min — допущение`;
  } else {
    sources.key = typeof note === 'string' && Number.isFinite(voiced)
      ? `нет данных: тон ${note} ненадёжен (тональных кадров ${(voiced * 100).toFixed(0)}% < ${VOICED_RATIO_MIN * 100}%)`
      : 'нет данных: тон не измерен';
  }

  let bpm = null;
  const rawBpm = p.tempo?.bpm;
  const confidence = p.tempo?.confidence;
  if (Number.isFinite(rawBpm) && Number.isFinite(confidence) && confidence >= TEMPO_CONFIDENCE_MIN) {
    let folded = rawBpm;
    while (folded < 60) folded *= 2;
    while (folded > 180) folded /= 2;
    bpm = Math.round(folded);
    sources.bpm = `измеренный темп атак ${rawBpm} BPM (уверенность ${confidence})`;
  } else {
    sources.bpm = Number.isFinite(rawBpm)
      ? `нет данных: темп ${rawBpm} BPM не уверен (уверенность ${confidence ?? '—'} < ${TEMPO_CONFIDENCE_MIN})`
      : 'нет данных: темп не измерен';
  }

  const density = p.transients?.densityPerSec;
  const attacksPerBar = attacksFromDensity(density, bpm);
  if (attacksPerBar !== null) {
    sources.rhythm = `измеренная плотность атак ${density}/с → ${attacksPerBar} атак на такт при ${bpm ?? 120} BPM${bpm ? '' : ' (темп по умолчанию, не замер)'}`;
  } else {
    sources.rhythm = 'нет данных: атаки не измерены';
  }

  return {
    key,
    bpm,
    attacksPerBar,
    character: Array.isArray(p.character) ? p.character : [],
    centroidHz: Number.isFinite(p.spectral?.centroidHz) ? p.spectral.centroidHz : null,
    sources,
  };
}

/**
 * Ритмический рисунок партии сэмпла: N атак равномерно по 16-долевой сетке.
 *
 * @param {string} sound имя сэмпла
 * @param {number|null} attacksPerBar
 * @returns {string} mini-нотация
 */
export function rhythmPattern(sound, attacksPerBar) {
  const n = Math.min(16, Math.max(1, Math.round(attacksPerBar ?? 4)));
  const slots = new Array(16).fill('~');
  for (let i = 0; i < n; i += 1) {
    slots[Math.round((i * 16) / n) % 16] = sound;
  }
  return slots.join(' ');
}

const CHORD_RE = /^([A-G][#b]?)(.*)$/;
const NOTE_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

/**
 * Переносит прогрессию в тональность сэмпла: корни сдвигаются так, чтобы
 * первый аккорд стал тоникой новой тональности, качества аккордов сохраняются.
 *
 * @param {string} harmony например «Cm Fm Gm Cm»
 * @param {string} key например «A#min»
 * @returns {string}
 */
export function rerootHarmony(harmony, key) {
  // Ключ спеки — формат «A#min» (без двоеточия): берём только тонику.
  const keyMatch = typeof key === 'string' ? key.trim().match(/^([A-G][#b]?)/) : null;
  if (!keyMatch || !(keyMatch[1] in NOTE_PC) || typeof harmony !== 'string' || !harmony.trim()) return harmony;
  const tokens = harmony.trim().split(/\s+/);
  const first = tokens[0]?.match(CHORD_RE);
  if (!first || !(first[1] in NOTE_PC)) return harmony;
  const shift = (NOTE_PC[keyMatch[1]] - NOTE_PC[first[1]] + 12) % 12;
  if (!shift) return harmony;
  return tokens.map((token) => {
    const match = token.match(CHORD_RE);
    if (!match || !(match[1] in NOTE_PC)) return token;
    return PITCH_NAMES[(NOTE_PC[match[1]] + shift) % 12] + match[2];
  }).join(' ');
}

/**
 * Встраивает сэмпл пула и измеренные признаки в спеку.
 *
 * Детерминированно: мета (тональность/темп) переопределяется только там,
 * где признак измерен; гармония переносится в новую тональность; партия
 * HUNTER_1 играет сам сэмпл рисунком из измеренной плотности атак.
 *
 * @param {object} spec валидная спека
 * @param {{entry:object, hints?:object}} options
 * @returns {{spec:object, applied:object}}
 */
export function applySamplePlan(spec, { entry, hints }) {
  const h = hints ?? passportHints(entry?.passport);
  const sound = sampleSoundName(entry?.id);
  const applied = { sound, key: null, bpm: null, attacksPerBar: h.attacksPerBar, harmonyRerooted: false };

  const meta = { ...spec.meta };
  if (h.key) {
    meta.key = h.key;
    applied.key = h.key;
  }
  if (h.bpm) {
    meta.bpm = h.bpm;
    applied.bpm = h.bpm;
  }

  // Плотность атак пересчитывается под ИТОГОВЫЙ темп трека, а не под
  // темп по умолчанию из passportHints.
  const density = entry?.passport?.transients?.densityPerSec;
  const attacks = attacksFromDensity(density, meta.bpm);
  if (attacks !== null) applied.attacksPerBar = attacks;

  const sections = (spec.structure?.sections ?? []).map((section) => ({ ...section }));
  if (applied.key) {
    for (const section of sections) {
      const next = rerootHarmony(section.harmony, applied.key);
      if (next !== section.harmony) {
        section.harmony = next;
        applied.harmonyRerooted = true;
      }
    }
  }

  const roles = { ...(spec.parts?.roles ?? {}) };
  roles.HUNTER_1 = {
    role: 'perc',
    sound,
    pattern: rhythmPattern(sound, applied.attacksPerBar),
    // Имена секций могут повторяться (два «drop»): activeIn — без дублей.
    activeIn: [...new Set(sections.map((section) => section.name))],
  };

  const sources = { ...h.sources };
  if (attacks !== null) {
    sources.rhythm = `измеренная плотность атак ${density}/с → ${attacks} атак на такт при ${meta.bpm} BPM`;
  }

  return {
    spec: {
      ...spec,
      meta,
      structure: { ...spec.structure, sections },
      parts: { ...spec.parts, roles },
      reasoning: [
        spec.reasoning ?? '',
        `Паспорт сэмпла «${entry?.name ?? entry?.id}»: ${Object.values(sources).join('; ')}.`,
      ].filter(Boolean).join(' '),
    },
    applied,
  };
}

/**
 * Текстовый блок измеренных признаков для промпта композитора.
 * Модель должна планировать вокруг измеренного, а не вокруг названия.
 */
export function sampleDigest(entry, hints) {
  const h = hints ?? passportHints(entry?.passport);
  const lines = [
    `Трек строится вокруг сэмпла «${entry?.name ?? entry?.id}» из локального пула (лицензия ${entry?.licenseId ?? '—'}).`,
    `Партия HUNTER_1 (роль perc, sound ${sampleSoundName(entry?.id)}) добавляется детерминированно — не дублируй её.`,
    `Измеренные признаки: ${Object.values(h.sources).join('; ')}.`,
  ];
  if (h.character.length) lines.push(`Характер звука: ${h.character.join(', ')}${h.centroidHz ? ` (центроид ${h.centroidHz} Гц)` : ''}.`);
  if (h.key) lines.push(`Тональность трека задана измеренным тоном: ${h.key} — гармония должна быть в ней.`);
  if (h.bpm) lines.push(`Темп трека задан измеренными атаками: ${h.bpm} BPM.`);
  return lines.join('\n');
}