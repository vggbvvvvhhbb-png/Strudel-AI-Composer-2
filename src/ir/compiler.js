// Компилятор Composition IR → Strudel-код.
//
// ГЛАВНОЕ ПРАВИЛО: компилятор — чистая функция. Один и тот же IR всегда даёт
// побайтно один и тот же код. Никаких Date.now(), Math.random() и порядков
// обхода, зависящих от вставки ключей.
//
// Как устроено кодирование (всё измерено пробами, см. docs/EVIDENCE-GROOVE.md):
//
//   • Сетка 1/16 — через `.beat("0,7,10",16)`: шаги выбираются списком.
//   • Динамика по шагам — через `.gain(v)`: значение берётся ПО СОБЫТИЮ,
//     поэтому шаги с разной динамикой живут в отдельных группах и
//     собираются через `stack(...)`.
//   • Микротайминг — через `.late(ms(6))`: сдвиг в циклах, где
//     ms(x) = x · (BPM/4) / 60000.
//   • Свинг считается ЗДЕСЬ, а не движком: `swingBy(x, n)` в Strudel 1.3.0
//     ДУБЛИРУЕТ события, а `swing(x)` без второго аргумента — no-op.
//   • Гармония — римские цифры → символы аккордов: `chord("<Dm9 Gm7>")`.
//   • Бас — корни аккорда: `"<Dm9 Gm7>".rootNotes(2).note().struct("x ~ x ~")`.
//
// Секции раскладываются через `arrange([bars, CONST], ...)`, как в старом
// компиляторе спеки: один формат кода на всю студию.

import { validateIR } from './schema.js';
import { grooveSteps } from './groove.js';
import { buildChordPlan } from './harmony.js';
import { paletteForGenre, isKnownSound, ROLE_ORBIT, ROLE_GAIN_DB } from './palette.js';
import { random01 } from './prng.js';
import { codeHash } from '../studio/roundtrip.js';

/** Строка лада для движка: {tonic:'C', mode:'minor'} → 'c:minor'. */
export function engineKey(key) {
  return `${String(key.tonic).toLowerCase()}:${key.mode}`;
}

/** Строка лада для спеки v2: 'Cminor' (регулярка спеки не пускает двоеточие). */
export function specKey(key) {
  return `${key.tonic}${key.mode}`;
}

const dbToLin = (db) => Math.pow(10, db / 20);

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Компилирует IR в Strudel-код.
 *
 * @param {object} input CompositionIR
 * @returns {{code:string, hash:string, sections:Array, roles:Array, spec:object, warnings:string[]}}
 */
export function compileIR(input) {
  const ir = validateIR(input);
  const warnings = [];
  const bpm = ir.meta.bpm;
  const key = engineKey(ir.meta.key);
  const genre = ir.meta.genre || 'lofi';

  // Палитра: явная в IR важнее жанровой, но каждое имя проверяется.
  const genrePalette = paletteForGenre(genre);
  const palette = { ...genrePalette };
  for (const [role, entry] of Object.entries(ir.palette || {})) {
    if (!isKnownSound(entry.ref)) {
      warnings.push(`Палитра: неизвестный звук «${entry.ref}» для роли ${role} — оставлен жанровой`);
      continue;
    }
    palette[role] = entry.ref;
  }

  const roles = collectRoles(ir);
  const consts = [];
  const perRoleSections = new Map(roles.map((role) => [role, []]));
  const sectionInfo = [];
  let bar = 0;

  ir.sections.forEach((section, index) => {
    const chords = buildChordPlan(key, section.harmony, section.bars);
    const activeRoles = Object.keys(section.layers).sort();

    for (const role of activeRoles) {
      const layer = section.layers[role];
      const expression = buildRoleExpression({
        role, layer, section, chords, ir, palette, bpm, key, index, warnings,
      });
      if (!expression) continue;
      const name = `${role.toUpperCase()}_${index}`;
      consts.push(`const ${name} = ${expression}`);
      perRoleSections.get(role).push({ name, bars: section.bars });
    }

    sectionInfo.push({
      id: section.id,
      kind: section.kind,
      bars: section.bars,
      startBar: bar,
      endBar: bar + section.bars,
      energy: section.energy,
      tension: section.tension,
      roles: activeRoles,
      chords: chords.map((chord) => chord.symbol),
    });
    bar += section.bars;
  });

  // Партии: у каждой роли — свой arrange по секциям.
  const partLines = [];
  for (const role of roles) {
    const chunks = perRoleSections.get(role);
    if (!chunks || !chunks.length) continue;
    const arranged = ir.sections.map((section) => {
      const found = chunks.find((chunk) => chunk.name.endsWith(`_${ir.sections.indexOf(section)}`));
      return found ? `[${section.bars}, ${found.name}]` : `[${section.bars}, silence]`;
    });
    partLines.push(`$${role.toUpperCase()}: arrange(${arranged.join(', ')})`);
  }

  const header = [
    '// Strudel AI Composer — Composition IR v1',
    `// ${genre} • ${bpm} BPM • ${key} • mood: ${ir.meta.mood.label || 'neutral'}`,
    `// seed: ${ir.seed}`,
    `setCpm(${bpm}/4)`,
    `const ms = x => x * (${bpm}/4) / 60000`,
    '',
  ];
  const code = [...header, ...consts, '', ...partLines].join('\n');

  return {
    ir,
    code,
    hash: codeHash(code),
    sections: sectionInfo,
    roles: roles.map((role) => ({
      role,
      label: role.toUpperCase(),
      orbit: ir.mix.orbit?.[role] ?? ROLE_ORBIT[role] ?? 1,
    })),
    spec: buildSpec(ir, palette),
    warnings,
  };
}

/** Все роли трека в стабильном порядке. */
export function collectRoles(ir) {
  const roles = new Set();
  for (const section of ir.sections) {
    for (const role of Object.keys(section.layers)) roles.add(role);
  }
  return [...roles].sort();
}

/**
 * Уровень роли в секции: базовый уровень из mix-roles × вес секции ×
 * индивидуальная поправка. Возвращает линейный множитель.
 */
function levelFor(role, layer, section, ir) {
  const base = ROLE_GAIN_DB[role] ?? -9;
  const personal = layer.gainDb ?? 0;
  // Энергия секции слегка поднимает уровень: пик должен быть громче.
  const energy = 0.85 + (section.energy ?? 0.5) * 0.3;
  return dbToLin(base + personal) * (layer.weight ?? 1) * energy;
}

/**
 * Уровень роли в секции — публичная копия для оракула.
 * Оракул строит события из тех же чисел, что и компилятор, поэтому уровень
 * должен считаться ОДНИМ способом. Экспортированная обёртка делает это
 * явным контрактом: если формула изменится, оракул и код поедут вместе.
 * @returns {number} линейный множитель громкости
 */
export function roleLevel(role, layer, section, ir) {
  return levelFor(role, layer, section, ir);
}

/**
 * Строит выражение роли в секции.
 * @returns {string|null} код выражения либо null, если роль в секции молчит
 */
function buildRoleExpression(ctx) {
  const { role, layer, section, chords, ir, palette, bpm, key, index, warnings } = ctx;
  const level = levelFor(role, layer, section, ir);
  if (!level || level <= 0.0001) return null;

  switch (layer.plan) {
    case 'drums':
      return drumsExpression({ ...ctx, level });
    case 'bassline':
      return bassExpression({ ...ctx, level, chords });
    case 'chords':
      return chordsExpression({ ...ctx, level, chords, pad: false });
    case 'pad':
      return chordsExpression({ ...ctx, level, chords, pad: true });
    case 'melody':
      return melodyExpression({ ...ctx, level, key });
    case 'arp':
      return arpExpression({ ...ctx, level, key });
    case 'texture':
      return noiseExpression({ ...ctx, level, role });
    default:
      return fxExpression({ ...ctx, level, role });
  }
}

/**
 * Ударные: группы (шаги, динамика, сдвиг) → `stack(...)`.
 * Групп собираются по паре «динамика + сдвиг», чтобы внутри группы шаги
 * стояли на своих местах, а разные группы несли разные веса.
 */
function drumsExpression({ role, layer, section, ir, palette, level }) {
  const templateRole = role === 'perc' ? 'hats' : role;
  const steps = grooveSteps({
    template: ir.groove.template,
    role: templateRole,
    bpm: ir.meta.bpm,
    amount: ir.groove.amount,
    swing: ir.groove.swing,
    offsetMs: ir.groove.offsetMs,
    density: layer.density,
    seed: ir.seed,
    address: `${section.id}:${role}`,
  });
  if (!steps.length) return null;

  const sample = palette[role] || 'bd';
  const groups = groupSteps(steps);
  const parts = groups.map((group) => {
    const gain = round3(group.velocity * level);
    const late = group.offsetMs ? `.late(ms(${round3(group.offsetMs)}))` : '';
    return `s("${sample}").beat("${group.steps.join(',')}",16).gain(${gain})${late}`;
  });
  return parts.length === 1 ? parts[0] : `stack(${parts.join(', ')})`;
}

/** Группировка шагов по динамике и сдвигу. */
export function groupSteps(steps) {
  const map = new Map();
  for (const step of steps) {
    const key = `${step.velocity}|${step.offsetMs}`;
    if (!map.has(key)) map.set(key, { velocity: step.velocity, offsetMs: step.offsetMs, steps: [] });
    map.get(key).steps.push(step.step);
  }
  return [...map.values()].sort((a, b) => a.steps[0] - b.steps[0]);
}

/**
 * Прогрессия секции: аккорд повторяется столько раз, сколько тактов держится.
 *
 * Строка собирается В УГЛОВЫХ СКОБКАХ: в mini-нотации «Dm Dm Bb7» без скобок —
 * это три аккорда ЗА ТАКТ, а «<Dm Dm Bb7>» — по одному за такт. Повтор
 * символа по числу тактов и задаёт длину аккорда.
 */
export function progressionString(chords) {
  const parts = [];
  for (const chord of chords) {
    for (let i = 0; i < chord.bars; i += 1) parts.push(chord.symbol);
  }
  if (!parts.length) return '';
  return `<${parts.join(' ')}>`;
}

/** Ритм баса: оффбитный или длинный — зависит от жанра и настроения. */
export function bassRhythm(ir) {
  // Явный ритм в IR важнее жанрового: его ставит трансформация, когда
  // линтер находит рассинхрон баса с киком.
  if (ir?.groove?.bassRhythm) return ir.groove.bassRhythm;
  const genre = ir.meta.genre;
  const mood = ir.meta.mood.label;
  if (genre === 'synthpop' || mood === 'euphoria') return '~ x ~ x ~ x ~ x';
  if (genre === 'ambient' || mood === 'void' || mood === 'tender') return 'x ~ ~ ~ ~ ~ ~ ~';
  if (genre === 'trip-hop' || mood === 'melancholy' || mood === 'dark') return 'x ~ ~ x ~ ~ ~ ~';
  return 'x ~ x ~ x ~ x ~';
}

/** Бас: корни аккорда в октаве 2 с ритмом роли. */
function bassExpression({ role, layer, chords, palette, level, ir }) {
  const progression = progressionString(chords);
  if (!progression) return null;
  const sound = palette[role] || 'sine';
  const lpf = role === 'sub' ? 200 : 400;
  // Октава берётся из РЕГИСТРА роли: иначе `shiftRegister` был бы пустой
  // трансформацией — менял IR, но не менял звук.
  const octave = bassOctave(layer);
  return `"${progression}".rootNotes(${octave}).note().struct("${bassRhythm(ir)}")` +
    `.s("${sound}").lpf(${lpf}).gain(${round3(level)})`;
}

/**
 * Октава корня баса из регистра роли.
 * MIDI 36 (c2) → октава 2, MIDI 48 (c3) → октава 3.
 */
function bassOctave(layer) {
  const register = layer?.register;
  if (!Array.isArray(register) || !Number.isFinite(register[0])) return 2;
  const octave = Math.floor(register[0] / 12) - 1;
  return Math.max(0, Math.min(7, octave));
}

/** Аккорды: войсинг с якорем, фильтр, приглушение. */
function chordsExpression({ role, layer, chords, palette, level, pad, ir }) {
  const progression = progressionString(chords);
  if (!progression) return null;
  const sound = palette[role] || 'triangle';
  // Расширенные аккорды (9/13/7) требуют словаря иреальных интервалов —
  // без него движок ставит ноты в другую октаву.
  const dict = /\d/.test(progression) ? ".dict('ireal')" : '';
  const anchor = pad ? 'c3' : 'c4';
  const lpf = layer.lpf ?? (pad ? 1400 : 2400);
  const envelope = pad
    ? '.attack(2.5).decay(1).sustain(.7).release(5)'
    : '';
  const space = pad ? '.room(.6).size(6)' : '';
  return `chord("${progression}")${dict}.voicing().anchor("${anchor}")` +
    `.s("${sound}")${envelope}.lpf(${lpf})${space}.gain(${round3(level)})`;
}

/** Мотив → mini-строка на 16 слотов. */
export function motifToMini(motif, octaveShift = 0) {
  const slots = new Array(16).fill('~');
  motif.degrees.forEach((degree, index) => {
    const step = motif.steps[index];
    if (step === undefined || step < 0 || step > 15) return;
    if (degree === null) return;
    slots[step] = String(degree + octaveShift * 7);
  });
  return slots.join(' ');
}

/**
 * Мотив трека: из IR или детерминированно сгенерированный.
 *
 * Мотив возвращается, но в СЕКЦИЯХ он варьируется: иначе лид звучит как
 * зацикленная петля (оральный оракул так и сообщает: «мотив повторяется, но
 * всегда одинаково»). Первая секция даёт эталонный хук, последняя
 * возвращает его — хук замыкает трек. Промежуточные секции получают
 * детерминированные вариации по адресу (seed, секция, мотив).
 */
export function resolveMotif(ir, layer, section, role) {
  const base = baseMotif(ir, layer);
  if (!base) return FALLBACK_MOTIF;
  const roleSections = ir.sections.filter((item) => role && item.layers[role]);
  const index = roleSections.findIndex((item) => item.id === section.id);
  if (index <= 0) return base;
  // Последняя секция с этой ролью возвращает эталонный хук.
  const isLast = index === roleSections.length - 1;
  if (isLast) return base;
  return varyMotif(base, ir.seed, section.id);
}

/** Мотив из IR или первый по имени — детерминированно. */
function baseMotif(ir, layer) {
  if (layer.motifId && ir.motifs[layer.motifId]) return ir.motifs[layer.motifId];
  const first = Object.keys(ir.motifs).sort()[0];
  return first ? ir.motifs[first] : null;
}

/**
 * Вариация мотива: часть ступеней сдвигается на ступень вверх или вниз.
 * Контур (число и длины нот) сохраняется — меняется только высота.
 */
function varyMotif(motif, seed, sectionId) {
  const degrees = motif.degrees.map((degree, index) => {
    if (degree === null) return null;
    const roll = random01(seed, 'motif-variation', sectionId, index);
    if (roll > 0.4) return degree;
    return Math.max(0, Math.min(6, degree + (roll > 0.2 ? 1 : -1)));
  });
  return { ...motif, degrees };
}

/** Запасной мотив: терции и кварты вокруг тоники. */
const FALLBACK_MOTIF = {
  degrees: [4, null, 2, null, 5, null, 3, null],
  steps: [0, 1, 2, 3, 4, 5, 6, 7],
};

/** Лид: мотив в ладу тональности. */
function melodyExpression({ role, layer, section, ir, palette, level, key }) {
  const motif = resolveMotif(ir, layer, section, role);
  const mini = motifToMini(motif, octaveShift(layer));
  const sound = palette[role] || 'triangle';
  return `n("${mini}").scale("${key}").s("${sound}").lpf(${layer.lpf ?? 3000}).gain(${round3(level)})`;
}

/**
 * Сдвиг октавы мотива по регистру роли.
 * Степени лада — индексы, поэтому октава = ±7 индексов.
 */
function octaveShift(layer) {
  const register = layer?.register;
  if (!Array.isArray(register) || !Number.isFinite(register[0])) return 0;
  return Math.round((register[0] - 60) / 12);
}

/** Арпеджио: движение по аккорду в 16-х. */
function arpExpression({ role, layer, section, chords, palette, level, key }) {
  const progression = progressionString(chords);
  const sound = palette[role] || 'square';
  if (!progression) {
    return `n("0 2 4 7 4 2").scale("${key}").fast(2).s("${sound}").lpf(3000).gain(${round3(level)})`;
  }
  return `n("0 2 4 7 4 2").scale("${key}").fast(2).s("${sound}")` +
    `.lpf(3000).gain(${round3(level)})`;
}

/** Шумовая подложка. */
function noiseExpression({ role, palette, level }) {
  const sound = palette[role] || 'pink';
  const lpf = sound === 'brown' ? 700 : 2000;
  return `s("${sound}").lpf(${lpf}).gain(${round3(level)})`;
}

/** Эффект: тот же шум, но с «вдохом» фильтра. */
function fxExpression({ role, palette, level }) {
  const sound = palette[role] || 'pink';
  return `s("${sound}").hpf(400).gain(${round3(level)})`;
}

/**
 * Строит спеку v2 для моста в ProjectModel.
 *
 * В спеку попадает и mini-строка паттерна (для анализа и пиано-ролла),
 * и готовое выражение `expr` — полное выражение роли с arrange по секциям.
 * Компилятор спеки учитывает `expr` и не пересобирает роль заново.
 */
function buildSpec(ir, palette) {
  const specNames = ir.sections.map((section) => specSectionName(section.kind));
  const roles = {};
  for (const role of collectRoles(ir)) {
    // activeIn в спеке адресует секции ИМЕНЕМ, а не id: мост обязан использовать
    // те же имена, что и в structure.sections.
    const activeIn = [];
    ir.sections.forEach((section, index) => {
      if (!section.layers[role]) return;
      const name = specNames[index];
      if (!activeIn.includes(name)) activeIn.push(name);
    });
    roles[role] = {
      activeIn,
      pattern: patternPreview(ir, role),
      sound: palette[role] || 'sine',
      effects: [],
    };
  }
  return {
    meta: {
      style: ir.meta.style || 'lo-fi',
      // Спека v2 ограничивает темп 60…180 BPM, а IR допускает 40…200.
      // Мост не имеет права выдать спеку, которую схема не примет.
      bpm: Math.min(180, Math.max(60, ir.meta.bpm)),
      key: specKey(ir.meta.key),
      schemaVersion: '2.1',
    },
    structure: {
      sections: ir.sections.map((section, index) => ({
        name: specNames[index],
        cycles: section.bars,
        energy: section.energy,
        harmony: (section.harmony || []).map((step) => step.rn).join(' '),
        parameters: {},
      })),
    },
    parts: { roles },
    reasoning: `Composition IR v1, seed ${ir.seed}`,
  };
}

/** Имя секции из набора спеки v2 (там нет 'peak' и 'break' — есть аналоги). */
function specSectionName(kind) {
  switch (kind) {
    case 'intro': return 'intro';
    case 'verse': return 'verse';
    case 'build': return 'build';
    case 'peak': return 'chorus';
    case 'chorus': return 'chorus';
    case 'drop': return 'drop';
    case 'break': return 'breakdown';
    case 'outro': return 'outro';
    case 'air': return 'intro';
    case 'grow': return 'build';
    case 'bloom': return 'chorus';
    case 'fade': return 'outro';
    default: return 'verse';
  }
}

/**
 * Мини-строка «предпросмотра» паттерна роли — для пиано-ролла и анализа.
 * Для ударных — сетка 1/16, для остальных — пусто (звук задаёт expr).
 */
function patternPreview(ir, role) {
  if (!['kick', 'snare', 'hats', 'perc'].includes(role)) return '';
  const templateRole = role === 'perc' ? 'hats' : role;
  const steps = grooveSteps({
    template: ir.groove.template,
    role: templateRole,
    bpm: ir.meta.bpm,
    amount: ir.groove.amount,
    swing: ir.groove.swing,
    offsetMs: ir.groove.offsetMs,
    density: 1,
    seed: ir.seed,
    address: `preview:${role}`,
  });
  const slots = new Array(16).fill('~');
  for (const step of steps) slots[step.step] = 'x';
  return slots.join(' ');
}
