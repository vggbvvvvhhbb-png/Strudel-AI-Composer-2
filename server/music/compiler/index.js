// Детерминированная компиляция канонической TrackSpec в Strudel.
import { validateTrackSpec } from '../../../src/schemas/track-spec.schema.js';
import { checkSpec } from '../spec/check.js';

const SAMPLED = new Set(['kick', 'snare', 'hats', 'perc', 'fx']);
const EFFECTS = new Set(['room', 'delay', 'gain', 'lpf', 'hpf']);
const NOTES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TRANSPOSE = { sub: -24, bass: -24, arp: 12, lead: 12 };

function mini(text, field) {
  // Values are data inside quoted mini strings, never executable Strudel expressions.
  if (!text.trim() || !/^[\w\s~*\[\]<>.,:!#b+\-\/|?@()]+$/.test(text)) {
    throw new Error(`${field}: неподдерживаемая mini-нотация`);
  }
  return JSON.stringify(text);
}

function keyScale(key) {
  const [, root, suffix] = key.match(/^([A-G][#b]?)([a-z]*)$/);
  const aliases = { min: 'minor', maj: 'major', m: 'minor' };
  return `${root.toLowerCase()}:${aliases[suffix] || suffix || 'major'}`;
}

// Гармония в виде «Cmin Fmin Gmin Cmin» сдвигает ступени тональных партий.
// Произвольная строка harmony из схемы остаётся описанием, не выполняемым кодом.
function chordRoots(harmony, key) {
  const tokens = harmony.trim().split(/\s+/);
  if (!tokens.length || !tokens.every((token) => /^[A-G][#b]?(?:(?:maj|min|m|major|minor)|(?::(?:maj|min|major|minor)))?$/.test(token))) return null;
  const pitch = (token) => {
    const match = token.match(/^([A-G])([#b]?)/);
    return (NOTES[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0) + 12) % 12;
  };
  const mode = key.match(/^[A-G][#b]?([a-z]*)$/)?.[1] || '';
  const steps = /^(min|m|minor|dorian|phrygian|aeolian)$/.test(mode)
    ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const tonic = pitch(key);
  const roots = tokens.map((token) => steps.indexOf((pitch(token) - tonic + 12) % 12));
  return roots.every((degree) => degree >= 0) ? roots : null;
}

function effectsFor(part, { skipGain = false } = {}) {
  return (part.effects || []).map((effect) => {
    if (!EFFECTS.has(effect.name) || effect.params.length !== 1 ||
      typeof effect.params[0] !== 'number' || !Number.isFinite(effect.params[0])) {
      throw new Error(`effects: неподдерживаемый эффект «${effect.name}» или его параметры`);
    }
    if (skipGain && effect.name === 'gain') return '';
    return `.${effect.name}(${effect.params[0]})`;
  }).join('');
}

/**
 * Группы измеренных ударов -> `stack(...)`.
 *
 * Список шагов через .beat("0,4,8,12",16), динамика через .gain(),
 * микротайминг через .late(ms(x)). Это тот же приём, что и в IR-компиляторе
 * (src/ir/compiler.js), и он же единственно верный: swingBy в Strudel 1.3.0
 * ДУБЛИРУЕТ события, а swing(x) без второго аргумента — no-op
 * (проверено пробой tests/spike/swing-semantics.probe.mjs).
 */
function groupsExpression(part, role) {
  const groups = part.groups ?? [];
  if (!groups.length) return null;
  const parts = groups.map((group) => {
    if (!group.sample || !/^[\w:-]+$/.test(group.sample)) {
      throw new Error(`${role}.groups.sample: неподдерживаемое имя сэмпла`);
    }
    const steps = group.steps.map((step) => Math.round(step)).join(',');
    if (!steps) throw new Error(`${role}.groups: пустой список шагов`);
    const gain = Number.isFinite(group.gain) ? Number(group.gain.toFixed(4)) : 1;
    const late = Number.isFinite(group.lateMs) && Math.abs(group.lateMs) > 0.01
      ? `.late(ms(${Number(group.lateMs.toFixed(3))}))`
      : '';
    return `s(${JSON.stringify(group.sample)}).beat(${JSON.stringify(steps)},16).gain(${gain})${late}`;
  });
  return parts.length === 1 ? parts[0] : `stack(${parts.join(', ')})`;
}

function sectionBody(part, role, section, scale, key) {
  // Переопределения по секции: у каждой секции свой рисунок (двойник).
  const override = part.sections?.[section.name] ?? {};
  const pattern = override.pattern ?? part.pattern;
  const sound = override.sound ?? part.sound;
  const gainPattern = override.gainPattern ?? part.gainPattern;
  const groups = override.groups ?? part.groups;
  const sampled = SAMPLED.has(role);
  const notation = mini(pattern, `${role}.pattern`);
  // Буквенные ноты уже содержат высоту; числовые ступени читаются через лад.
  const explicitNotes = !sampled && /[a-g](?:#|b)?-?\d/.test(pattern);
  let body = sampled ? (groupsExpression({ ...part, groups }, role) ?? `s(${notation})`) : explicitNotes ? `note(${notation})` : `n(${notation})`;
  if (!sampled) {
    if (!explicitNotes) {
      const roots = chordRoots(section.harmony, key);
      if (roots && roots.length) {
        const slow = section.cycles % roots.length === 0 ? section.cycles / roots.length : 1;
        body += `.add(n(${JSON.stringify(`<${roots.join(' ')}>` )})${slow > 1 ? `.slow(${slow})` : ''})`;
      }
      body += `.scale(${JSON.stringify(scale)})`;
    }
    if (TRANSPOSE[role]) body += `.transpose(${TRANSPOSE[role]})`;
    body += `.s(${JSON.stringify(sound)})`;
  }
  // 's' означает, что имена сэмплов уже указаны в pattern.
  // При заданных groups имена сэмплов уже внутри групп — .s() перебил бы их.
  const hasGroups = Boolean(groups?.length);
  if (sampled && !hasGroups && sound !== 's' && sound !== 'sample') {
    if (!/^[\w:-]+$/.test(sound)) throw new Error(`${role}.sound: неподдерживаемое имя сэмпла`);
    body += `.s(${JSON.stringify(sound)})`;
  }
  // При группах динамика уже записана в каждой группе — общий gain не дублируем.
  body += effectsFor(part, { skipGain: hasGroups });
  // Огибающая громкости по шагам сетки (двойник): velocity ударов измерена,
  // а effects.gain принимает только одно число. Если эффект gain уже задан —
  // не дублируем.
  if (gainPattern && !hasGroups && !part.effects?.some((effect) => effect.name === 'gain')) {
    body += `.gain(${mini(gainPattern, `${role}.gainPattern`)})`;
  }
  // Свинг сетки — из измерений (drums.onsets.swing). ВНИМАНИЕ: swingBy в
  // Strudel 1.3.0 ДУБЛИРУЕТ события, а swing(x) без второго аргумента — no-op
  // (проба tests/spike/swing-semantics.probe.mjs). Поэтому свинг выражен
  // измеренным микротаймингом в groups (lateMs), а не этим параметром.
  if (!hasGroups && typeof part.swing === 'number' && Number.isFinite(part.swing) && part.swing > 0.001) {
    body += `.swingBy(${part.swing}, 8)`;
  }
  if (section.parameters?.cutoff) {
    body += `.lpf(sine.slow(${section.cycles}).range(${section.parameters.cutoff.join(', ')}))`;
  }
  if (section.parameters?.gain) {
    body += `.gain(sine.slow(${section.cycles}).range(${section.parameters.gain.join(', ')}))`;
  }
  return body;
}

/** Валидирует вход до генерации; возвращает строку Strudel-кода. */
export function compileTrackSpec(input) {
  const spec = validateTrackSpec(input);
  const checked = checkSpec(spec);
  if (!checked.ok) throw new Error(`Invalid TrackSpec: ${checked.errors.join('; ')}`);
  const { sections } = spec.structure;
  const roles = Object.entries(spec.parts.roles).sort(([a], [b]) => a.localeCompare(b, 'en'));
  const scale = keyScale(spec.meta.key);
  const lines = [
    `// ${spec.meta.style} — ${spec.meta.bpm} BPM, ${scale}`,
    `// Форма: ${sections.map((s) => `${s.name}(${s.cycles})`).join(' → ')}`,
    `setCpm(${spec.meta.bpm}/4)`,
    `const key = ${JSON.stringify(scale)}`,
  ];
  // Хелпер для микротайминга в миллисекундах — нужен группам с lateMs.
  const needsMs = Object.values(spec.parts.roles).some((part) => {
    const all = [...(part.groups ?? [])];
    for (const override of Object.values(part.sections ?? {})) all.push(...(override.groups ?? []));
    return all.some((group) => Number.isFinite(group.lateMs) && Math.abs(group.lateMs) > 0.01);
  });
  if (needsMs) {
    lines.push(`const ms = x => x * (${spec.meta.bpm}/4) / 60000`);
  }
  lines.push('');
  const constants = [];
  const parts = [];
  for (const [role, part] of roles) {
    const chunks = [];
    sections.forEach((section, index) => {
      if (!part.activeIn.includes(section.name)) {
        chunks.push(`[${section.cycles}, silence]`);
        return;
      }
      const name = `${role.toUpperCase()}_${index}`;
      constants.push(`const ${name} = ${sectionBody(part, role, section, scale, spec.meta.key)}`);
      chunks.push(`[${section.cycles}, ${name}]`);
    });
    if (part.activeIn.length) {
      const visual = SAMPLED.has(role) ? '_scope' : '_pianoroll';
      parts.push(`$${role.toUpperCase()}: arrange(${chunks.join(', ')}).${visual}()`);
    }
  }
  lines.push(...constants, '', ...parts);
  return lines.join('\n');
}

/** Совместимость только по форме результата: старый формат входа не поддерживается. */
export function compile(spec) {
  const code = compileTrackSpec(spec);
  const sections = spec.structure.sections;
  let bar = 0;
  return {
    code,
    parts: code.split('\n').filter((line) => /^\$[A-Z]+:/.test(line))
      .map((line) => ({ label: line.match(/^\$([A-Z]+):/)[1], code: line })),
    sections: sections.map((section) => {
      const startBar = bar;
      bar += section.cycles;
      return { kind: section.name, bars: section.cycles, energy: section.energy,
        startBar, endBar: bar,
        roles: Object.entries(spec.parts.roles).filter(([, part]) => part.activeIn.includes(section.name)).map(([role]) => role),
        transition: null };
    }),
    warnings: [],
    trace: [],
  };
}
