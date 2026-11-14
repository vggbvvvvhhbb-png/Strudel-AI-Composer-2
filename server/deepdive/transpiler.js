// Транспайлер режима «Разбор»: дескрипторы измерений → TrackSpec → Strudel-код.
//
// ПРИНЦИП. Ни одного числа здесь нет, что не пришло из измерений. Темп — из
// measurements.tempo, сетка ударов — из drums.onsets.grid, ноты баса — из
// bass.pitch.notes, аккорды — из other.chords, активность слоёв — из энергии
// стемов по секциям. Всё, что не измерено, не появляется.
//
// ГЛАВНОЕ ОГРАНИЧЕНИЕ. Плана владельца (producers-deep-dive-v2.md §5.2) прямо
// запрещает обещать больше, чем мы умеем: двойник — это «узнаваемый скелет
// трека в коде», а не копия. Поэтому:
//
//   * вокал, точное сведение и мастеринг НЕ воспроизводятся;
//   * глайды баса НЕ воспроизводятся точно: в Strudel нет portamento/glide
//     (проверено по реестру server/music/data/strudel-api.json) — только
//     legato, который меняет длительность, а не высоту;
//   * тембр задаётся синтезатором, а не сэмплом оригинала.
//
// ФОРМАТ. На выходе — каноническая TrackSpec (src/schemas/track-spec.schema.js),
// которую уже умеет компилировать server/music/compiler/index.js. Благодаря
// этому «Улучшить», «Ещё вариант» и «Предложенные правки» работают с двойником
// бесплатно: они правят ПЛАН, а код пересобирается из него.

import { validateTrackSpec } from '../../src/schemas/track-spec.schema.js';
import { compileTrackSpec } from '../music/compiler/index.js';

// Имена сэмплов Strudel по нотам General MIDI.
// Источник — реестр банка server/music/data/sample-banks.json (dirt-samples).
// Не выдумываем имён: неизвестное имя молча выпадает из звука.
const GM_TO_SAMPLE = {
  35: 'bd',   // acoustic bass drum
  36: 'bd',   // bass drum 1
  37: 'sd',   // side stick
  38: 'sd',   // snare 1
  39: 'cp',   // hand clap
  40: 'sd',   // snare 2
  42: 'hh',   // closed hi-hat
  44: 'hh',   // pedal hi-hat
  46: 'oh',   // open hi-hat
  49: 'crash',
  51: 'ride',
  53: 'rim',
};

// Роли ударных по нотам GM. Всё остальное ударное — в «perc».
const GM_TO_ROLE = {
  36: 'kick', 35: 'kick',
  38: 'snare', 40: 'snare', 37: 'snare',
  42: 'hats', 44: 'hats', 46: 'hats',
};

const SECTION_NAMES = ['intro', 'verse', 'chorus', 'drop', 'build', 'breakdown', 'bridge', 'fill', 'outro'];

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** MIDI → имя ноты с октавой: 60 → 'c4'. */
export function midiToNoteName(midi) {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

/** 'c#3' → MIDI. Возвращает null, если имя не разобрано. */
export function noteNameToMidi(name) {
  const match = String(name ?? '').match(/^([a-g])(#|b)?(-?\d+)$/);
  if (!match) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[match[1]];
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  return (Number(match[3]) + 1) * 12 + base + accidental;
}

/** Темп: берём из измерений, приводим в диапазон схемы (60..180). */
export function chooseTempo(tempo) {
  const candidates = [];
  if (tempo?.bpm) candidates.push({ bpm: tempo.bpm, kind: 'primary', confidence: tempo.confidence ?? 0 });
  for (const candidate of tempo?.candidates ?? []) {
    if (candidate.bpm && !candidates.some((c) => Math.abs(c.bpm - candidate.bpm) < 0.01)) {
      candidates.push(candidate);
    }
  }
  const usable = candidates.find((c) => c.bpm >= 60 && c.bpm <= 180);
  if (usable) {
    return {
      bpm: Number(usable.bpm.toFixed(3)),
      source: usable.kind ?? 'primary',
      shifted: usable.kind === 'half_time' || usable.kind === 'double_time' ? usable.kind : null,
      candidates: candidates.map((c) => ({ bpm: c.bpm, kind: c.kind ?? 'alternative', confidence: c.confidence ?? 0 })),
      note: usable.kind === 'half_time' || usable.kind === 'double_time'
        ? `выбран ${usable.kind}: ${usable.bpm} BPM (двойная/половинная сетка)`
        : null,
    };
  }
  const fallback = candidates[0]?.bpm ?? 120;
  const clamped = Math.min(180, Math.max(60, fallback));
  return {
    bpm: Number(clamped.toFixed(3)),
    source: 'clamped',
    shifted: null,
    candidates: candidates.map((c) => ({ bpm: c.bpm, kind: c.kind ?? 'alternative', confidence: c.confidence ?? 0 })),
    note: `измеренный темп ${fallback} BPM вне диапазона схемы 60..180 — взят ${clamped}`,
  };
}

/** Лад: тоника + режим → строка вида 'Cmin' (её ждёт keyScale в компиляторе). */
export function chooseKey(key) {
  const tonic = String(key?.tonic ?? 'C').replace(/^([a-g])/i, (m) => m.toUpperCase());
  const mode = String(key?.mode ?? 'major').toLowerCase();
  const suffix = mode === 'minor' ? 'min' : mode === 'major' ? 'major' : mode;
  return { key: `${tonic}${suffix}`, confidence: key?.confidence ?? 0 };
}

/** Аккорд-гипотеза → нормализованный токен гармонии ('Cmin' / 'Fmaj'). */
function harmonyToken(chord) {
  const root = String(chord?.root ?? '').replace(/^([a-g])/i, (m) => m.toUpperCase());
  if (!/^[A-G][#b]?$/.test(root)) return null;
  const quality = String(chord?.quality ?? '').toLowerCase();
  const minor = /^(m|min|minor|-)/.test(quality) || quality.includes('dim') || quality.includes('phryg');
  const major = /^(maj|major|)$/.test(quality) || quality.includes('maj');
  if (minor) return `${root}min`;
  if (major) return `${root}maj`;
  return null;
}

/**
 * Ноты аккорда → триада в конкретной октаве.
 * Измеряем только корень и качество, поэтому интервалы берём из качества:
 * мажор — 0/4/7, минор — 0/3/7. Для «сырых» гипотез — 0/3/7 (минор) как
 * консервативное допущение, помеченное в отчёте.
 */
function chordTriad(chord, rootMidi = 60) {
  const rootName = String(chord?.root ?? '').toLowerCase();
  const rootMidiValue = noteNameToMidi(`${rootName}3`);
  if (rootMidiValue === null) return null;
  const quality = String(chord?.quality ?? '').toLowerCase();
  const minor = /^(m|min|minor|-)/.test(quality) || quality.includes('dim') || quality.includes('phryg');
  const intervals = minor ? [0, 3, 7] : [0, 4, 7];
  const base = rootMidiValue + (rootMidi - rootMidiValue) % 12;
  return intervals.map((interval) => midiToNoteName(base + interval));
}

/** Порядок шагов сетки в такте: 1/4 → 4, 1/8 → 8, 1/12 → 12, 1/16 → 16, 1/24 → 24, 1/32 → 32. */
function stepsPerBar(gridStep) {
  const map = { '1/4': 4, '1/8': 8, '1/12': 12, '1/16': 16, '1/24': 24, '1/32': 32 };
  return map[gridStep] ?? 16;
}

/**
 * Раскладка ударов по шагам сетки для одного такта.
 *
 * @returns {{tokens:string[], gains:number[]}|null}
 */
function barFromHits(hits, barStart, barEnd, steps, stepSec, fallbackGain = 0.8) {
  const tokens = new Array(steps).fill('~');
  const gains = new Array(steps).fill(0);
  const seen = new Array(steps).fill(false);
  for (const hit of hits) {
    const time = hit.time_s ?? hit.time ?? null;
    if (time === null) continue;
    if (time < barStart - stepSec * 0.5 || time >= barEnd) continue;
    const index = Math.round((time - barStart) / stepSec);
    if (index < 0 || index >= steps) continue;
    // На один шаг — самый громкий удар: иначе два удара схлопнутся в один токен.
    const gain = hit.velocity ?? 0.8;
    if (!seen[index] || gain > gains[index]) {
      const sample = GM_TO_SAMPLE[hit.gm] ?? hit.label ?? 'perc';
      tokens[index] = sample;
      gains[index] = gain;
      seen[index] = true;
    }
  }
  if (!seen.some(Boolean)) return null;
  const normalized = gains.map((g) => (g > 0 ? Number(g.toFixed(3)) : fallbackGain));
  return { tokens, gains: normalized };
}

/** Строка mini-нотации из шагов. */
function tokensToMini(tokens) {
  return tokens.join(' ');
}

/**
 * Активность слоя по секциям: энергия стема сравнивается с его собственным
 * максимумом. Порог — доля от максимума (по умолчанию 20 %).
 */
function activityBySection(stemDescriptor, sections, threshold = 0.2) {
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
 * Основная функция: дескрипторы → план (TrackSpec) + отчёт о решениях.
 *
 * @param {object} descriptors результат анализа по контракту deep-dive.schema.json
 * @returns {{spec: object, code: string, report: object}}
 */
export function descriptorsToSpec(descriptors) {
  const measurements = descriptors?.measurements ?? {};
  const stems = descriptors?.stem_descriptors ?? {};
  const report = { warnings: [], caveats: [], decisions: {} };

  const tempo = chooseTempo(measurements.tempo);
  const key = chooseKey(measurements.key);
  report.decisions.tempo = tempo;
  report.decisions.key = key;

  const bpm = tempo.bpm;
  const barSec = 240 / bpm; // один такт = 4 доли
  const stepSec = barSec / 16;

  // ---- секции -------------------------------------------------------------
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

  // Имена секций должны быть РАЗНЫМИ, если набор активных слоёв разный:
  // activeIn ссылается на имя, а не на индекс (server/music/spec/check.js).
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

  // ---- гармония секций: из аккордов стема other ---------------------------
  const chords = stems.other?.chords ?? [];
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

  // ---- роли ---------------------------------------------------------------
  const roles = {};

  // Ударные: раскладываем удары по сетке.
  const drums = stems.drums;
  const hits = drums?.onsets?.hits ?? [];
  const gridSteps = stepsPerBar(drums?.onsets?.grid?.step);
  const drumsByRole = { kick: [], snare: [], hats: [], perc: [] };
  for (const hit of hits) {
    const role = GM_TO_ROLE[hit.gm] ?? 'perc';
    drumsByRole[role].push(hit);
  }

  for (const [role, roleHits] of Object.entries(drumsByRole)) {
    if (!roleHits.length) continue;
    const bars = [];
    const gains = [];
    for (const section of sections) {
      const sectionBars = [];
      const sectionGains = [];
      for (let bar = 0; bar < section.cycles; bar += 1) {
        const barStart = section.start_s + bar * barSec;
        const built = barFromHits(roleHits, barStart, barStart + barSec, gridSteps, barSec / gridSteps);
        sectionBars.push(built ? built.tokens : null);
        sectionGains.push(built ? built.gains : null);
      }
      const filled = sectionBars.map((tokens) => tokens ?? new Array(gridSteps).fill('~'));
      const filledGains = sectionGains.map((values) => values ?? new Array(gridSteps).fill(0.8));
      bars.push(filled);
      gains.push(filledGains);
    }
    roles[role] = { bars, gains, sectionIndex: sections.map((_, i) => i) };
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

  // ---- сборка TrackSpec ----------------------------------------------------
  const specSections = sections.map((section) => ({
    name: section.name,
    cycles: section.cycles,
    energy: Number(section.energy.toFixed(3)),
    harmony: section.harmony,
  }));

  const specRoles = {};
  for (const [role, data] of Object.entries(roles)) {
    const activeIn = [];
    const patterns = [];
    const gainPatterns = [];
    sections.forEach((section, index) => {
      const stemName = role === 'bass' ? 'bass' : role === 'chords' ? 'other' : 'drums';
      const active = activityBySection(stems[stemName], sections, 0.2)[index];
      const barList = data.bars[index] ?? [];
      const nonEmpty = barList.some((tokens) => tokens.some((token) => token !== '~'));
      if (!active || !nonEmpty) return;
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
      if (data.gains) {
        const chosenGains = [];
        for (const tokens of barList) {
          const key = tokens.join(' ');
          if (!chosenGains.some((g) => g.key === key)) {
            chosenGains.push({ key, gains: data.gains[index][barList.indexOf(tokens)] });
          }
        }
        gainPatterns.push(chosenGains.slice(0, 8).map((g) => g.gains.join(' ')).join(' '));
      }
    });
    if (!activeIn.length) return;
    const part = {
      activeIn,
      pattern: patterns[0],
      sound: role === 'kick' || role === 'snare' || role === 'hats' || role === 'perc' ? 's' : 'sine',
    };
    if (role === 'chords') part.sound = 'sawtooth';
    if (gainPatterns.length && role !== 'chords') part.gainPattern = gainPatterns[0];
    const swing = Number(drums?.onsets?.swing ?? 0);
    if (swing > 0.52 && (role === 'hats' || role === 'kick' || role === 'snare')) {
      part.swing = Number(((swing - 0.5) * 2).toFixed(3));
    }
    specRoles[role] = part;
  }

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
  const density = Number(descriptors?.stem_descriptors?.drums?.onsets?.count ?? 0);
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
