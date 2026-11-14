// Секции, активность слоёв и сборка ролей.
//
// Секция — это кусок трека из измерений (structure): свои границы, своя
// энергия, свой набор активных стемов. Роль — партия плана (kick, snare,
// hats, perc, bass, chords), собранная из измеренных ударов, нот баса и
// аккордов. Здесь живёт и то, и другое: ровно те куски descriptorsToSpec,
// которые отвечают за роли, секции и активность слоёв.

import { buildGroupsForSection } from './grid.js';
import { chordTriad, harmonyToken, midiToNoteName } from './notes.js';
import { GM_TO_ROLE, GM_TO_SAMPLE } from './samples.js';

// Справочники ударных живут в ./samples.js (их использует и сетка), но
// роли смотрят на них именно отсюда.
export { GM_TO_SAMPLE, GM_TO_ROLE };

const SECTION_NAMES = ['intro', 'verse', 'chorus', 'drop', 'build', 'breakdown', 'bridge', 'fill', 'outro'];

/**
 * Активность слоя по секциям: энергия стема сравнивается с его собственным
 * максимумом. Порог — доля от максимума (по умолчанию 20 %).
 */
export function activityBySection(stemDescriptor, sections, threshold = 0.2) {
  const activity = stemDescriptor?.activity ?? {};
  const values = Object.values(activity).map((v) => Number(v) || 0);
  const max = values.length ? Math.max(...values) : 0;
  if (max <= 0) return sections.map(() => false);
  return sections.map((section) => {
    const value = Number(activity[section.index] ?? activity[String(section.index)] ?? 0);
    return value / max >= threshold;
  });
}

/**
 * Секции трека из измерений: границы, длительность в тактах, энергия и
 * активность ударных.
 *
 * ИМЕНА СЕКЦИЙ. Имя секции должно быть РАЗНЫМ, если набор активных слоёв
 * разный: activeIn ссылается на имя, а не на индекс
 * (server/music/spec/check.js). Поэтому при совпадении профилей имя
 * переиспользуется, а в отчёт пишется предупреждение.
 *
 * @param {object} descriptors результат анализа по контракту deep-dive.schema.json
 * @param {object} stems измеренные стемы (descriptor.stem_descriptors)
 * @param {number} barSec длительность такта в секундах
 * @param {object} report отчёт о решениях (сюда пишутся предупреждения)
 * @returns {Array<object>} секции с именами, циклами и энергией
 */
export function buildSections(descriptors, stems, barSec, report) {
  const rawSections = Array.isArray(descriptors?.structure) ? descriptors.structure : [];
  const sections = rawSections.map((section, index) => {
    const start = Number(section.start_s) || 0;
    const end = Number(section.end_s) || 0;
    const cycles = Math.max(1, Math.round((end - start) / barSec));
    return {
      index,
      label: section.label ?? String.fromCharCode(65 + (index % 26)),
      start_s: start,
      end_s: end,
      cycles,
      energy: Math.min(1, Math.max(0, Number(section.energy) || 0)),
      activity: activityBySection(stems.drums, rawSections, 0.2),
    };
  });

  const used = new Set();
  const profileOf = (section) => {
    const profile = new Set();
    for (const [stemName, descriptor] of Object.entries(stems)) {
      const activity = descriptor?.activity ?? {};
      const values = Object.values(activity).map((v) => Number(v) || 0);
      const max = values.length ? Math.max(...values) : 0;
      const value = Number(activity[section.index] ?? activity[String(section.index)] ?? 0);
      if (max > 0 && value / max >= 0.2) profile.add(stemName);
    }
    return [...profile].sort().join('+');
  };
  const profiles = new Map();
  sections.forEach((section) => {
    const profile = profileOf(section);
    const energy = section.energy;
    const preference = energy >= 0.7
      ? ['drop', 'chorus', 'build']
      : energy >= 0.45
        ? ['chorus', 'verse', 'bridge']
        : ['verse', 'breakdown', 'intro'];
    let name = null;
    for (const candidate of preference) {
      if (!used.has(candidate)) {
        name = candidate;
        break;
      }
    }
    if (!name) {
      // Имена кончились: если профиль совпадает с уже использованной секцией —
      // переиспользуем имя (партии будут одинаковыми, это честно).
      const twin = sections.find((s) => s.index < section.index && profiles.get(s.index) === profile);
      name = twin ? twin.name : SECTION_NAMES.find((n) => !used.has(n)) ?? 'verse';
      if (!twin) report.warnings.push(`секций больше, чем имён в схеме: «${name}» переиспользована — слои могут отличаться`);
    }
    used.add(name);
    profiles.set(section.index, profile);
    section.name = name;
    if (section.index === 0 && section.energy < 0.6 && !used.has('intro')) {
      used.delete(name);
      section.name = 'intro';
      used.add('intro');
    }
    if (section.index === sections.length - 1 && section.energy < 0.6 && !used.has('outro')) {
      used.delete(section.name);
      section.name = 'outro';
      used.add('outro');
    }
  });

  return sections;
}

/**
 * Гармония секций: из аккордов стема other (не из микса — 808 забивает
 * хромаграмму). Если аккордов нет, берётся лад трека.
 */
export function applySectionHarmony(sections, chords, key) {
  for (const section of sections) {
    const overlapping = chords.filter(
      (chord) => (chord.start_s ?? 0) < section.end_s && (chord.end_s ?? 0) > section.start_s,
    );
    const tokens = [];
    for (const chord of overlapping) {
      const token = harmonyToken(chord);
      if (token && !tokens.includes(token)) tokens.push(token);
    }
    section.harmony = tokens.length ? tokens.join(' ') : `${key.key.replace(/major$/, 'maj').replace(/min$/, 'min')}`;
    section.chordTriads = overlapping
      .map((chord) => chordTriad(chord, 60))
      .filter(Boolean);
  }
}

/**
 * Роли из измерений: ударные по сетке ударов, бас по питч-треку, аккорды —
 * по триадам измеренных аккордов.
 *
 * @returns {object} роли в промежуточном виде (секции/такты, а не план)
 */
export function buildRoles({ stems, sections, barSec, chords, hits, gridSteps }) {
  const roles = {};

  // Ударные: раскладываем удары по сетке.
  const drumsByRole = { kick: [], snare: [], hats: [], perc: [] };
  for (const hit of hits) {
    const role = GM_TO_ROLE[hit.gm] ?? 'perc';
    drumsByRole[role].push(hit);
  }

  for (const [role, roleHits] of Object.entries(drumsByRole)) {
    if (!roleHits.length) continue;
    const sectionData = [];
    for (const section of sections) {
      const built = buildGroupsForSection(roleHits, section, barSec, gridSteps);
      sectionData.push(built);
    }
    roles[role] = { sections: sectionData, sectionIndex: sections.map((_, i) => i) };
  }

  // Бас: ноты из питч-трека. Компенсация октавы — см. TRANSPOSE в компиляторе.
  const bassNotes = stems.bass?.pitch?.notes ?? [];
  if (bassNotes.length) {
    const bars = [];
    const gains = [];
    for (const section of sections) {
      const sectionBars = [];
      const sectionGains = [];
      for (let bar = 0; bar < section.cycles; bar += 1) {
        const barStart = section.start_s + bar * barSec;
        const barEnd = barStart + barSec;
        const inBar = bassNotes.filter((note) => {
          const time = note.time_s ?? 0;
          return time >= barStart && time < barEnd;
        });
        const steps = [];
        const stepGains = [];
        let cursor = barStart;
        for (const note of inBar) {
          const time = note.time_s ?? cursor;
          const index = Math.max(0, Math.min(gridSteps - 1, Math.round((time - barStart) / (barSec / gridSteps))));
          const midi = Number(note.midi);
          if (!Number.isFinite(midi)) continue;
          // Компилятор применяет .transpose(-24) к роли bass — компенсируем +24.
          const name = midiToNoteName(midi + 24);
          const durationSteps = note.duration_s
            ? Math.max(1, Math.round((note.duration_s / barSec) * gridSteps))
            : 1;
          while (steps.length < index) steps.push('~');
          while (stepGains.length < index) stepGains.push(0.8);
          steps.push(durationSteps > 1 ? `${name}*${durationSteps}` : name);
          stepGains.push(0.8);
          cursor = time + (note.duration_s ?? 0);
        }
        while (steps.length < gridSteps) steps.push('~');
        while (stepGains.length < gridSteps) stepGains.push(0.8);
        sectionBars.push(steps.slice(0, gridSteps));
        sectionGains.push(stepGains.slice(0, gridSteps));
      }
      bars.push(sectionBars);
      gains.push(sectionGains);
    }
    roles.bass = { bars, gains, sectionIndex: sections.map((_, i) => i) };
  }

  // Аккорды: из стема other (не из микса — 808 забивает хромаграмму).
  if (sections.some((section) => section.chordTriads?.length)) {
    const bars = [];
    for (const section of sections) {
      const triads = section.chordTriads ?? [];
      const sectionBars = [];
      for (let bar = 0; bar < section.cycles; bar += 1) {
        const barStart = section.start_s + bar * barSec;
        const chord = triads.find((triad, index) => {
          const chordStart = (chords.find((c) => c.end_s > section.start_s + index * barSec)?.start_s) ?? barStart;
          return chordStart <= barStart + barSec;
        }) ?? triads[bar % Math.max(1, triads.length)] ?? null;
        const tokens = new Array(gridSteps).fill('~');
        if (chord) {
          const startStep = Math.round(((chords.find((c) => c.start_s >= section.start_s)?.start_s ?? barStart) - barStart) / (barSec / gridSteps));
          const index = Math.max(0, Math.min(gridSteps - 1, startStep));
          tokens[index] = `[${chord.join(' ')}]`;
        }
        sectionBars.push(tokens);
      }
      bars.push(sectionBars);
    }
    roles.chords = { bars, gains: null, sectionIndex: sections.map((_, i) => i) };
  }

  return roles;
}

/**
 * Роли → партии плана: ударные остаются группами шагов, остальные — одним
 * повторяющимся паттерном на секцию.
 *
 * Партия попадает в план, только если слой активен в этой секции.
 *
 * ВОЗВРАТ. null означает «сборку прервать». В исходном монолите на этом
 * месте стоял `return` внутри цикла по ролям, и он выходил из самой
 * descriptorsToSpec: партия, не активная ни в одной секции, обрывала
 * сборку плана целиком. Здесь тот же останов выражен возвратом null —
 * вызывающая функция ведёт себя ровно как раньше.
 */
export function buildSpecRoles(roles, sections, stems) {
  const specRoles = {};
  for (const [role, data] of Object.entries(roles)) {
    const activeIn = [];
    const patterns = [];
    const gainPatterns = [];
    const sectionOverrides = {};
    const isDrum = role === 'kick' || role === 'snare' || role === 'hats' || role === 'perc';
    sections.forEach((section, index) => {
      const stemName = role === 'bass' ? 'bass' : role === 'chords' ? 'other' : 'drums';
      const active = activityBySection(stems[stemName], sections, 0.2)[index];
      if (!active) return;
      if (isDrum) {
        // Ударные: измеренные удары -> группы шагов (шаги, динамика, микротайминг).
        const built = data.sections[index];
        if (!built?.groups?.length) return;
        activeIn.push(section.name);
        sectionOverrides[section.name] = { groups: built.groups };
        patterns.push(built.groups.map((group) => group.sample).join(' '));
        return;
      }
      const barList = data.bars?.[index] ?? [];
      const nonEmpty = barList.some((tokens) => tokens.some((token) => token !== '~'));
      if (!nonEmpty) return;
      activeIn.push(section.name);
      const uniqueBars = [];
      for (const tokens of barList) {
        const key = tokens.join(' ');
        if (!uniqueBars.some((u) => u.key === key)) uniqueBars.push({ key, tokens });
      }
      const chosen = uniqueBars.slice(0, 8);
      const pattern = chosen.length === 1
        ? chosen[0].tokens.join(' ')
        : `<${chosen.map((bar) => bar.tokens.join(' ')).join(' ')}>`;
      patterns.push(pattern);
      sectionOverrides[section.name] = { pattern };
      if (data.gains) {
        const chosenGains = [];
        for (const tokens of barList) {
          const key = tokens.join(' ');
          if (!chosenGains.some((g) => g.key === key)) {
            chosenGains.push({ key, gains: data.gains[index][barList.indexOf(tokens)] });
          }
        }
        const gains = chosenGains.slice(0, 8).map((g) => g.gains.join(' ')).join(' ');
        gainPatterns.push(gains);
        sectionOverrides[section.name].gainPattern = gains;
      }
    });
    if (!activeIn.length) return null;
    const part = {
      activeIn,
      pattern: patterns[0] ?? '',
      sound: isDrum ? 's' : 'sine',
    };
    if (role === 'chords') part.sound = 'sawtooth';
    if (Object.keys(sectionOverrides).length) part.sections = sectionOverrides;
    if (gainPatterns.length && role !== 'chords' && !isDrum) part.gainPattern = gainPatterns[0];
    specRoles[role] = part;
  }
  return specRoles;
}
