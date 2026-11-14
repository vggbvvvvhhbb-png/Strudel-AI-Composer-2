// Транспайлер режима «Разбор»: дескрипторы измерений → TrackSpec → Strudel-код.
//
// Здесь собрана главная функция (descriptorsToSpec), определение стиля по
// измерениям (detectStyle) и код для одного слоя (roleToCode). Всё остальное
// разнесено по смыслу:
//   ./notes.js  — MIDI ↔ имя ноты, темп, лад, токены гармонии;
//   ./grid.js   — сетка шагов и раскладка измеренных ударов;
//   ./roles.js  — секции, активность слоёв и сборка ролей;
//   ./samples.js — справочники ударных (имя сэмпла и роль по нотам GM).
//
// ГРАФ ЗАВИСИМОСТЕЙ. Справочники лежат в самом низу (./samples.js) и не
// зависят ни от чего: поэтому сетка и сборка ролей пользуются одной и той же
// таблицей, а циклических импортов не возникает.

import { validateTrackSpec } from '../../../src/schemas/track-spec.schema.js';
import { compileTrackSpec } from '../../music/compiler/index.js';
import { chooseKey, chooseTempo } from './notes.js';
import { stepsPerBar } from './grid.js';
import { applySectionHarmony, buildRoles, buildSections, buildSpecRoles } from './roles.js';

// Публичные помощники транспайлера живут в ./notes.js — переэкспортируем их
// отсюда, чтобы публичный API модуля был в одном месте.
export { midiToNoteName, noteNameToMidi, chooseTempo, chooseKey } from './notes.js';

/**
 * Подставляет запасной ритм вместо отсутствующего стема ударных.
 *
 * Слой ударных мог не разделиться — тогда атаки берутся из самого микса
 * (см. pipeline/stems.js). Это НЕ измерение стема: в контракте такого слоя
 * нет, а честность обеспечивает пайплайн — оговоркой в отчёте.
 *
 * @param {object} measuredStems измеренные стемы
 * @param {object|null} rhythm запасной ритм из микса
 */
function withFallbackRhythm(measuredStems, rhythm) {
  if (measuredStems.drums || !rhythm?.onsets) return measuredStems;
  return {
    ...measuredStems,
    drums: { onsets: rhythm.onsets, activity: rhythm.activity ?? {} },
  };
}

/**
 * Основная функция: дескрипторы → план (TrackSpec) + отчёт о решениях.
 *
 * @param {object} descriptors результат анализа по контракту deep-dive.schema.json
 * @returns {{spec: object, code: string, report: object}}
 */
export function descriptorsToSpec(descriptors) {
  const measurements = descriptors?.measurements ?? {};
  const stems = withFallbackRhythm(
    descriptors?.stem_descriptors ?? {},
    descriptors?.rhythm ?? null,
  );
  const report = { warnings: [], caveats: [], decisions: {} };

  const tempo = chooseTempo(measurements.tempo);
  const key = chooseKey(measurements.key);
  report.decisions.tempo = tempo;
  report.decisions.key = key;

  const bpm = tempo.bpm;
  const barSec = 240 / bpm; // один такт = 4 доли
  const stepSec = barSec / 16;

  // ---- секции -------------------------------------------------------------
  const sections = buildSections(descriptors, stems, barSec, report);

  // ---- гармония секций: из аккордов стема other ---------------------------
  const chords = stems.other?.chords ?? [];
  applySectionHarmony(sections, chords, key);

  // ---- роли ---------------------------------------------------------------
  const drums = stems.drums;
  const hits = drums?.onsets?.hits ?? [];
  const gridSteps = stepsPerBar(drums?.onsets?.grid?.step);
  const roles = buildRoles({ stems, sections, barSec, chords, hits, gridSteps });

  // ---- сборка TrackSpec ----------------------------------------------------
  const specSections = sections.map((section) => ({
    name: section.name,
    cycles: section.cycles,
    energy: Number(section.energy.toFixed(3)),
    harmony: section.harmony,
  }));

  const specRoles = buildSpecRoles(roles, sections, stems);
  // Партия, не активная ни в одной секции, обрывала сборку плана ещё в
  // исходном монолите (там стоял `return` из descriptorsToSpec). Поведение
  // сохранено как есть: план не собирается вовсе.
  if (specRoles === null) return undefined;

  // Форма должна быть 16..96 тактов (server/music/spec/check.js).
  let totalBars = specSections.reduce((sum, section) => sum + section.cycles, 0);
  if (totalBars < 16) {
    report.caveats.push(`трек короче минимальной формы: ${totalBars} тактов — форма повторена до 16`);
    while (totalBars < 16) {
      const template = specSections.map((section) => ({ ...section }));
      for (const section of template) {
        if (totalBars >= 16) break;
        specSections.push({ ...section });
        totalBars += section.cycles;
      }
      if (!template.length) break;
    }
  }
  if (totalBars > 96) {
    report.caveats.push(`трек длиннее максимальной формы: ${totalBars} тактов — оставлено 96`);
    let overflow = totalBars - 96;
    while (overflow > 0 && specSections.length > 1) {
      const last = specSections[specSections.length - 1];
      const cut = Math.min(overflow, last.cycles - 1);
      if (cut <= 0) {
        specSections.pop();
        overflow = totalBars - specSections.reduce((sum, s) => sum + s.cycles, 0);
        continue;
      }
      last.cycles -= cut;
      overflow -= cut;
      totalBars -= cut;
    }
  }

  const style = detectStyle(descriptors, report);

  const spec = validateTrackSpec({
    meta: {
      style,
      bpm,
      key: key.key,
      schemaVersion: '0.1',
    },
    structure: { sections: specSections },
    parts: { roles: specRoles },
    reasoning: 'Код-двойник: план собран из измерений трека, без догадок.',
  });

  const code = compileTrackSpec(spec);
  report.style = style;
  report.bars = specSections.reduce((sum, section) => sum + section.cycles, 0);
  report.sections = specSections.map((section, index) => ({
    index,
    name: section.name,
    label: sections[index]?.label ?? null,
    cycles: section.cycles,
    energy: section.energy,
  }));
  report.roles = Object.entries(specRoles).map(([role, part]) => ({
    role,
    activeIn: part.activeIn,
    patternLength: part.pattern.length,
  }));
  report.honesty = {
    not_reproduced: ['вокал', 'точное сведение и мастеринг', 'тембр оригинала (используются синтезаторы)'],
    caveats: [
      'Глайды баса не воспроизводятся точно: в Strudel нет portamento/glide.',
      ...report.caveats,
    ],
    overall_confidence: Object.keys(specRoles).length >= 3 ? 'medium' : 'low',
  };

  return { spec, code, report };
}

/**
 * Жанр для поля meta.style — по измерениям, а не по названию файла.
 *
 * ЧЕСТНОСТЬ. Это эвристика низкой уверенности, а не определение жанра:
 * 140 BPM с тяжёлым низом одинаково объясняется и dubstep'ом, и trap'ом,
 * и phonk'ом. Поэтому правило требует одновременно трёх признаков и
 * записывает в отчёт, почему выбран именно этот стиль.
 */
export function detectStyle(descriptors, report) {
  const tempo = Number(descriptors?.measurements?.tempo?.bpm ?? 120);
  const balance = descriptors?.measurements?.spectral_balance ?? {};
  const density = Number(
    descriptors?.stem_descriptors?.drums?.onsets?.count
      ?? descriptors?.rhythm?.onsets?.count
      ?? 0,
  );
  const sub = Number(balance.sub ?? 0);
  const low = Number(balance.low ?? 0);
  const lowTotal = sub + low;
  const explain = (style, why) => {
    if (report && report.decisions) report.decisions.style = { value: style, why, confidence: 'low' };
    return style;
  };
  if (tempo >= 138 && tempo <= 160 && sub >= 0.3 && lowTotal >= 0.55) {
    return explain('dubstep', 'темп 138..160, очень тяжёлый низ');
  }
  if (tempo >= 86 && tempo <= 102 && lowTotal >= 0.35) {
    return explain('trap', 'темп 86..102 и бас в нижней половине спектра');
  }
  if (tempo >= 118 && tempo <= 130 && density > 0) {
    return explain(tempo >= 126 ? 'techno' : 'house', 'темп 118..130 с ударными');
  }
  if (tempo < 92) return explain('lo-fi', 'темп ниже 92');
  return explain('cinematic', 'признаков жанра не хватило — нейтральный стиль');
}

/**
 * Код для ОДНОГО слоя: транспайлер отдаёт и полный микс, и отдельный код
 * каждой роли. Так можно честно сравнивать слои: движок не умеет сольный
 * рендер партии (параметр partId игнорируется src/audio/engine/adapter.js).
 *
 * @param {object} spec каноническая TrackSpec
 * @param {string} role имя роли
 * @returns {string} Strudel-код только этой роли
 */
export function roleToCode(spec, role) {
  const only = {
    ...spec,
    parts: { roles: { [role]: spec.parts.roles[role] } },
  };
  return compileTrackSpec(only);
}
