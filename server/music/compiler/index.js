// Компилятор спеки в Strudel-код.
//
// Компилятор — ЧИСТАЯ ДЕТЕРМИНИСТИЧНАЯ функция: одна и та же спека всегда
// даёт один и тот же код. Никакой случайности, никаких обращений к сети.
//
// Принципы сборки:
//   • Партии выводятся из гармонии: бас, пэд, аккорды, арпеджио и лид
//     строятся из степеней прогрессии. Бас никогда не живёт отдельной
//     строкой мимо аккордов.
//   • У каждой секции свои паттерны: рисунок сдвигается по секциям, чтобы
//     трек не был одним повторяющимся рисунком.
//   • Таймлайн на уровне партии: $BASS: arrange([8, BASS_0], [14, BASS_1],
//     [2, BASS_1_TAIL]) — микшер, mute/solo и пианороллы работают по партиям.
//   • Переход и филл вставляются автоматически по transition: тело секции и
//     её хвост — разные куски arrange.
//   • Автоматизация — только через сигналы (sine/perlin/saw).
//
// ПРОВЕРЕНО В ФАЗЕ 0 (docs/SPIKE.md) и пробами фазы 2 — важные факты:
//   • `.slow(n)` — это МЕТОД, а не часть mini-строки:
//     `n("<0 5>").scale(key).slow(2)`, а не `n("<0 5>.slow(2)")`.
//   • n("0 2 4").scale(key) даёт ПОСЛЕДОВАТЕЛЬНЫЕ ноты. Одновременный аккорд
//     получается только через stack().
//   • Аккорд = stack из голосов, у каждого голоса своё чередование:
//     stack(n("<0 5>"), n("<2 7>"), n("<4 9>")).scale(key).
//   • `.add(паттерн)` складывает ЗНАЧЕНИЕ в СТЕПЕННОЕ пространство, если
//     стоит ДО .scale(key): n("0 2 4").add(n("<0 5 3 4>")).scale(key) —
//     арпеджио, который идёт по аккордам прогрессии.
//   • `.struct()` с ритмом, длина которого не совпадает с числом нот,
//     ведёт себя непредсказуемо → ритм мотива переводится в mini-строку
//     самостоятельно.

import { progressionForSection } from '../spec/check.js';
import { ROLE_MATRIX, TRANSITIONS, selectPattern, normalizeRecipe } from '../knowledge/index.js';
import { num, str } from '../knowledge/descriptor.js';

/** Отображаемое имя роли → метка партии в коде. */
const PART_LABELS = {
  kick: 'KICK',
  snare: 'SNARE',
  hats: 'HATS',
  perc: 'PERC',
  sub: 'SUB',
  bass: 'BASS',
  pad: 'PAD',
  chords: 'CHORDS',
  lead: 'LEAD',
  arp: 'ARP',
  fx: 'FX',
  texture: 'TEXTURE',
};

/** Роли, которые играют на сэмплах (ритм из библиотеки, без гармонии). */
const SAMPLED = new Set(['kick', 'snare', 'hats', 'perc', 'fx']);

/** Роли, у которых ноты строятся из гармонии. */
const HARMONIC = new Set(['bass', 'sub', 'pad', 'chords', 'lead', 'arp', 'texture']);

/** Хвост секции с переходом — доля от длины секции, в тактах. */
const TRANSITION_TAIL_BARS = 2;

/** Устойчивый хэш строки — число. */
function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Вариант партии в секции.
 *
 * `family` — выбор рисунка из библиотеки: из спеки (A/B/C) или по зерну.
 * `phase`  — сдвиг по секциям: соседние секции одной роли звучат по-разному.
 *
 * Оба числа зависят только от спеки и зерна, поэтому компиляция
 * воспроизводима, а рисунок не стоит на месте.
 */
function variantFor(seed, role, index, explicit) {
  let family = null;
  if (explicit) {
    const code = String(explicit).trim().toUpperCase().charCodeAt(0) - 65;
    if (Number.isFinite(code) && code >= 0) family = code;
  }
  const phase = (hashString(`${seed}|${role}`) % 12) + index;
  return { family, phase };
}

/**
 * Ритмический шаблон роли.
 *
 * Явный вариант из спеки (A/B/C) уважается буквально; иначе шаблон
 * выбирается по рецепту ('default'/'busy'/'sparse') и сдвигается по секциям.
 */
function pickPattern(role, recipe, index, seed, family) {
  if (!role.patterns.length) return '~';
  if (family !== null) {
    const unique = [...new Set(role.patterns)];
    return unique[family % unique.length];
  }
  return selectPattern(role, recipe, index, seed) || '~';
}

/**
 * Транспозиция партии, в полутонах.
 *
 * Зачем: без неё бас, пэд и арпеджио собираются из степеней лада и звучат
 * в ОДНОЙ октаве — трек лишён регистрового разделения, и метрика
 * «разделение регистров» штрафует каждый скомпилированный трек.
 *
 * Проверено пробой (tests/spike/transpose-probe.mjs):
 *   • `.transpose(-24)` ПОСЛЕ `.scale(key)` работает: F3 → F1;
 *   • ДО `.scale(key)` — ошибка «transpose: not a note», значение игнорируется.
 * Поэтому транспозиция ставится строго после масштаба.
 */
const ROLE_TRANSPOSE = {
  bass: -24,
  sub: -24,
  pad: 0,
  chords: 0,
  texture: 0,
  arp: 12,
  lead: 12,
};

/** Трезвучие из ступени лада: d, d+2, d+4. */
function triad(degree) {
  return [degree, degree + 2, degree + 4];
}

/**
 * Бас: корни аккордов прогрессии.
 *
 * `n("<0 5 3 4>").scale(key).slow(N)` — чередование корней, каждый аккорд на
 * N тактов. `.ply(K)` добавляет пульс: корень повторяется внутри аккорда.
 */
function buildBass(progression, barsPerChord, phase, recipe) {
  const roots = `<${progression.degrees.join(' ')}>`;
  const plys = [1, 2, 3, 4];
  let count = plys[phase % plys.length];
  if (recipe === 'busy') count = Math.min(4, count * 2);
  if (recipe === 'sparse') count = 1;
  const chain = [];
  if (barsPerChord > 1) chain.push({ method: 'slow', arg: num(barsPerChord) });
  if (count > 1) chain.push({ method: 'ply', arg: num(count) });
  return { source: `n("${roots}")`, chain };
}

/**
 * Аккорд: одновременные тоны трезвучия, чередующиеся по прогрессии.
 * Каждый голос получает своё чередование, чтобы смена аккорда была
 * одновременной во всех голосах.
 */
function buildChord(progression, barsPerChord, phase, recipe, role) {
  const voices = [0, 2, 4].map((offset) => {
    const degrees = progression.degrees.map((d) => d + offset);
    return `n("<${degrees.join(' ')}>")`;
  });
  const chain = [];
  if (barsPerChord > 1) chain.push({ method: 'slow', arg: num(barsPerChord) });
  // Аккорд бьётся каждый такт; пэд держится и не пульсирует.
  if (role !== 'pad' && recipe !== 'sparse' && phase % 2 === 1) {
    chain.push({ method: 'ply', arg: num(2) });
  }
  return { source: `stack(${voices.join(', ')})`, chain };
}

/**
 * Арпеджио: тоны аккорда по 1/3 такта, аккорд меняется по прогрессии.
 *
 * `n("0 2 4").add(n("<0 5 3 4>").slow(2)).scale(key)` — ноты тона
 * аккорда, сдвинутые на корень текущего аккорда.
 */
function buildArp(progression, barsPerChord, phase, recipe) {
  const speed = recipe === 'busy' ? 2 : phase % 3 === 0 ? 2 : 1;
  const base = speed > 1 ? `n("0 2 4").fast(${speed})` : 'n("0 2 4")';
  const add = `n("<${progression.degrees.join(' ')}>")`;
  const source = barsPerChord > 1
    ? `${base}.add(${add}.slow(${barsPerChord}))`
    : `${base}.add(${add})`;
  return { source, chain: [] };
}

/**
 * Мотив в mini-строку: ритм из спеки раскладывается по степеням.
 *
 * Ритм "x ~ x x" и степени [0, 2, 4] → "0 ~ 2 4".
 */
function motifToMini(motif) {
  const degrees = motif.degrees;
  const rhythm = String(motif.rhythm || '').trim();
  if (!rhythm) return degrees.join(' ');

  const tokens = rhythm.split(/\s+/).filter(Boolean);
  let cursor = 0;
  const parts = [];
  for (const token of tokens) {
    if (token === '~' || token === '_') {
      parts.push('~');
      continue;
    }
    const mul = token.match(/\*(\d+)$/);
    const count = mul ? Number(mul[1]) : 1;
    for (let i = 0; i < count; i += 1) {
      parts.push(String(degrees[cursor % degrees.length]));
      cursor += 1;
    }
  }
  if (!parts.length) return degrees.join(' ');
  return parts.join(' ');
}

/**
 * Лид: мелодический мотив поверх аккордов.
 */
function buildLead(motif, progression, barsPerChord, phase) {
  if (!motif || !motif.degrees || !motif.degrees.length) {
    // Мотив не задан — лид играет верхние ступени аккорда.
    const tops = progression.degrees.map((d) => d + 4);
    const chain = [];
    if (barsPerChord > 1) chain.push({ method: 'slow', arg: num(barsPerChord) });
    return { source: `n("<${tops.join(' ')}>")`, chain };
  }

  let degrees = [...motif.degrees];
  for (const transform of motif.transforms || []) {
    if (transform === 'invert') {
      // Инверсия: ступень d → 7 − d в пределах октавы.
      degrees = degrees.map((d) => {
        const octave = Math.floor(d / 7);
        const step = ((d % 7) + 7) % 7;
        return octave * 7 + (7 - step);
      });
    } else if (transform === 'shift') {
      degrees = degrees.map((d) => d + 2);
    } else if (transform === 'reverse') {
      degrees = [...degrees].reverse();
    } else if (transform === 'transpose') {
      const delta = phase % 2 === 0 ? 2 : -1;
      degrees = degrees.map((d) => Math.max(0, d + delta));
    }
  }

  // Октавный и обратный варианты — чтобы лид не был одной фразой.
  if (phase % 3 === 1) degrees = degrees.map((d) => d + 7);
  else if (phase % 3 === 2) degrees = [...degrees].reverse();

  const mini = motifToMini({ ...motif, degrees });
  const add = `n("<${progression.degrees.join(' ')}>")`;
  const source = barsPerChord > 1
    ? `n("${mini}").add(${add}.slow(${barsPerChord}))`
    : `n("${mini}").add(${add})`;
  return { source, chain: [] };
}

/**
 * Рендерит аргумент метода в текст кода.
 */
function renderArg(arg) {
  if (!arg) return '0';
  if (arg.kind === 'number') return String(arg.value);
  if (arg.kind === 'string') return JSON.stringify(arg.value);
  if (arg.kind === 'signal') {
    const [low, high] = arg.range;
    const from = arg.direction === 'down' ? high : low;
    const to = arg.direction === 'down' ? low : high;
    return `${arg.signal}.slow(${arg.slow}).range(${from}, ${to})`;
  }
  return '0';
}

/**
 * Рендерит цепочку методов.
 */
function renderChain(chain) {
  if (!chain || !chain.length) return '';
  return chain.map((step) => `.${step.method}(${renderArg(step.arg)})`).join('');
}

/**
 * Общие эффекты роли.
 */
function roleEffects(role) {
  const presets = {
    pad: [['room', num(0.5)]],
    chords: [['room', num(0.35)]],
    texture: [['room', num(0.7)]],
    arp: [['delay', num(0.3)]],
    lead: [['room', num(0.4)]],
  };
  return (presets[role] || []).map(([method, arg]) => ({ method, arg }));
}

/**
 * Громкость роли.
 */
function roleGain(role) {
  const presets = {
    kick: 0.9,
    snare: 0.7,
    hats: 0.45,
    perc: 0.5,
    sub: 0.75,
    bass: 0.7,
    pad: 0.4,
    chords: 0.5,
    lead: 0.55,
    arp: 0.4,
    fx: 0.5,
    texture: 0.3,
  };
  const value = presets[role];
  return value === undefined ? null : value;
}

/**
 * Рецепт партии с учётом энергии секции.
 *
 * Явный рецепт из спеки важнее энергии. Но если рецепт не задан ('default'),
 * энергия секции решает: интро должно быть разреженным, дроп — плотным.
 * Это и даёт треку развитие во времени, а не один ровный рисунок.
 */
function effectiveRecipe(recipe, energy) {
  if (recipe !== 'default') return recipe;
  if (energy >= 0.75) return 'busy';
  if (energy <= 0.4) return 'sparse';
  return 'default';
}

/**
 * Компилирует спеку в Strudel-код.
 *
 * @param {object} spec спека, прошедшая checkSpec
 * @returns {{code: string, parts: object[], sections: object[], warnings: string[], trace: object[]}}
 */
export function compile(spec) {
  const warnings = [];
  const seed = spec.meta.seed ?? hashString(`${spec.meta.style}|${spec.meta.key}|${spec.meta.bpm}`);
  const keyName = spec.meta.key.trim().toLowerCase().replace(/^["'`]|["'`]$/g, '');
  const styleRoles = ROLE_MATRIX[spec.meta.style] || {};

  // Прогрессия для каждой секции.
  const sectionProgressions = spec.form.map((_, index) => progressionForSection(spec, index));

  // Роль → индексы секций, где она играет.
  const roleSections = new Map();
  spec.form.forEach((section, index) => {
    for (const role of Object.keys(section.roles)) {
      if (!roleSections.has(role)) roleSections.set(role, []);
      roleSections.get(role).push(index);
    }
  });

  const lines = [];
  lines.push(`// ${spec.meta.style} — ${spec.meta.bpm} BPM, ${keyName}`);
  lines.push(`// Форма: ${spec.form.map((s) => `${s.kind}(${s.bars})`).join(' → ')}`);
  lines.push(`// Прогрессия: ${sectionProgressions.map((p) => p.id).join(' | ')}`);
  lines.push(`// Зерно: ${seed}`);
  lines.push('');
  lines.push(`setCpm(${Math.round(spec.meta.bpm)}/4)`);
  lines.push(`const key = "${keyName}"`);
  lines.push('');

  // --- константы секций ---
  const constants = [];
  const trace = [];

  for (const [role, indexes] of roleSections.entries()) {
    const roleInfo = styleRoles[role];
    if (!roleInfo) {
      warnings.push(`Роль «${role}» не описана для стиля ${spec.meta.style} — пропущена`);
      continue;
    }

    for (const index of indexes) {
      const section = spec.form[index];
      const choice = section.roles[role] || {};
      const recipe = effectiveRecipe(
        normalizeRecipe(choice.recipe),
        typeof section.energy === 'number' ? section.energy : 0.5,
      );
      const progression = sectionProgressions[index];
      const barsPerChord = progression.barsPerChord || 2;
      const { family, phase } = variantFor(seed, role, index, choice.variant);

      let built = null;
      if (SAMPLED.has(role)) {
        // Ударные и эффекты: сэмплы, ритм из библиотеки.
        const rhythm = pickPattern(roleInfo, recipe, index, seed, family);
        built = { source: `s("${rhythm}")`, chain: [], rhythm };
      } else if (role === 'bass' || role === 'sub') {
        built = buildBass(progression, barsPerChord, phase, recipe);
      } else if (role === 'chords' || role === 'pad') {
        built = buildChord(progression, barsPerChord, phase, recipe, role);
      } else if (role === 'arp') {
        built = buildArp(progression, barsPerChord, phase, recipe);
      } else if (role === 'lead') {
        built = buildLead(spec.motif, progression, barsPerChord, phase);
      } else {
        // Текстура: ритм из библиотеки, тональность — да.
        const rhythm = pickPattern(roleInfo, recipe, index, seed, family);
        built = { source: `n("${rhythm}")`, chain: [], rhythm };
      }

      if (!built) continue;

      // Цепочка: синтезатор → общие эффекты роли.
      const chain = [...built.chain];
      if (!SAMPLED.has(role) && roleInfo.synth) {
        chain.push({ method: 's', arg: str(roleInfo.synth) });
      }
      chain.push(...roleEffects(role));

      const name = `${PART_LABELS[role] || role.toUpperCase()}_${index}`;
      // .scale(key) — только для партий с нотами. К сэмплам применять
      // лад бессмысленно: движок ругается «Invalid value format for scale».
      const scalePart = SAMPLED.has(role) ? '' : '.scale(key)';
      // Транспозиция — строго ПОСЛЕ масштаба (см. ROLE_TRANSPOSE).
      const transpose = !SAMPLED.has(role) && ROLE_TRANSPOSE[role]
        ? `.transpose(${ROLE_TRANSPOSE[role]})`
        : '';
      const body = `${built.source}${scalePart}${transpose}${renderChain(chain)}`;
      constants.push({ name, role, index, body, section, built, chain });

      trace.push({
        section: index,
        kind: section.kind,
        role,
        recipe,
        variant: choice.variant || null,
        pattern: built.rhythm || null,
        synth: SAMPLED.has(role) ? 'sample' : roleInfo.synth || null,
        transpose: ROLE_TRANSPOSE[role] ?? 0,
      });

      // Переход: хвост секции — отдельный кусок arrange.
      if (section.transition) {
        const recipeFn = TRANSITIONS[section.transition.type];
        if (recipeFn) {
          const tailChain = [...chain];
          const withTransition = recipeFn(
            { kind: 'n', value: '', scale: true, chain: [] },
            TRANSITION_TAIL_BARS,
          );
          tailChain.push(...(withTransition.chain || []));
          constants.push({
            name: `${name}_TAIL`,
            role,
            index,
            body: `${built.source}${scalePart}${renderChain(tailChain)}`,
            section,
            built,
            chain: tailChain,
            isTail: true,
          });
        }
      }
    }
  }

  if (constants.length) {
    lines.push('// --- константы секций ---');
    for (const constant of constants) {
      lines.push(`const ${constant.name} = ${constant.body}`);
    }
    lines.push('');
  }

  // --- партии: таймлайн на уровне партии ---
  const partBlocks = [];
  for (const [role, indexes] of roleSections.entries()) {
    const label = PART_LABELS[role] || role.toUpperCase();
    const chunks = [];

    for (const index of indexes) {
      const section = spec.form[index];
      const body = constants.find((c) => c.role === role && c.index === index && !c.isTail);
      if (!body) continue;
      const tail = constants.find((c) => c.role === role && c.index === index && c.isTail);

      if (tail) {
        // Тело секции + хвост с переходом.
        const tailBars = Math.min(TRANSITION_TAIL_BARS, Math.max(2, section.bars - 2));
        chunks.push(`[${section.bars - tailBars}, ${body.name}]`);
        chunks.push(`[${tailBars}, ${tail.name}]`);
      } else {
        chunks.push(`[${section.bars}, ${body.name}]`);
      }
    }

    if (!chunks.length) continue;
    const gain = roleGain(role);
    const tail = SAMPLED.has(role) ? '._scope()' : '._pianoroll()';
    partBlocks.push(`$${label}: arrange(${chunks.join(', ')})${gain !== null ? `.gain(${gain})` : ''}${tail}`);
  }

  lines.push('// --- партии ---');
  lines.push(...partBlocks);
  lines.push('');

  // Секции для таймлайна в интерфейсе.
  let bar = 0;
  const sections = spec.form.map((section) => {
    const start = bar;
    bar += section.bars;
    return {
      kind: section.kind,
      bars: section.bars,
      energy: section.energy,
      startBar: start,
      endBar: bar,
      roles: Object.keys(section.roles),
      transition: section.transition || null,
    };
  });

  return {
    code: lines.join('\n'),
    parts: partBlocks.map((block) => {
      const match = block.match(/^\$([A-Z]+):/);
      return { label: match ? match[1] : '', code: block };
    }),
    sections,
    warnings,
    trace,
  };
}
