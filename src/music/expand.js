// Детерминированная экспансия плана в дорожки (фаза C).
//
// Замысел: LLM пишет ВЕРХНИЕ уровни (форма, гармония, тембры, состав
// групп), а код разворачивает их в 64–100+ дорожек. Модель не пишет 100
// промптов — она пишет один план.
//
// Два свойства, которые здесь важны:
//   1. ДЕТЕРМИНИЗМ: один и тот же план -> один и тот же трек, байт в байт.
//      Никаких Math.random() и Date.now().
//   2. БЮДЖЕТ ПОЛИФОНИИ: не более N атак на такт на группу. Без него микс
//      из 100 дорожек клиппит — измерено: true peak +6.02 dBTP, клиппинг
//      1660 отсчётов (tests/spike/parts-100.probe.mjs).
//
// Идентичность дорожки — её id (D-100), роль — атрибут. Две скрипки одной
// группы получают разные id, разные рисунки и разные голоса.

// Группы оркестра: роль -> группа. Роль из плана может быть любой
// (`violin`, `choir_soprano`), но для бюджета и разбавки нужна группа.
export const GROUP_BY_ROLE = {
  kick: 'drums', snare: 'drums', hats: 'drums', perc: 'drums',
  bass: 'bass', sub: 'bass',
  violin: 'strings', viola: 'strings', cello: 'strings', contrabass: 'strings',
  horn: 'brass', trumpet: 'brass', trombone: 'brass', tuba: 'brass',
  flute: 'woodwinds', oboe: 'woodwinds', clarinet: 'woodwinds', bassoon: 'woodwinds',
  piano: 'keys', organ: 'keys', harp: 'keys',
  choir: 'choir', choir_soprano: 'choir', choir_alto: 'choir', choir_tenor: 'choir', choir_bass: 'choir',
  pad: 'pads', texture: 'pads',
  lead: 'lead', arp: 'arp', chords: 'chords',
  fx: 'fx',
};

// Бюджет атак на такт на ОДИН голос группы: сколько ударов в такт
// допустимо для одной дорожки. Число не из фантазии: получено измерением
// (tests/spike/parts-100.probe.mjs) и подгонкой под гейт L0
// (scripts/build-opera-demo.mjs).
export const GROUP_BUDGET = {
  drums: 4,
  bass: 4,
  strings: 3,
  brass: 2,
  woodwinds: 2,
  keys: 3,
  choir: 2,
  pads: 1,
  lead: 4,
  arp: 4,
  chords: 2,
  fx: 2,
};

// Бюджет атак на такт на весь трек: не меньше 24 (обычный бит) и не
// больше 1.4 на дорожку. Без него 100 голосов превращаются в кашу.
export function globalAttackBudget(voices) {
  return Math.max(24, Math.round(voices * 1.4));
}

// Громкость одной дорожки на группу: сумма голосов группы держится около
// GROUP_LEVEL. Калибровано измерением: при 0.28 рендер оперы давал
// -18.47 LUFS-I (ниже коридора -16…-12), при 0.40 - -15.37, а после
// раскладки по регистрам потребовался 0.8, чтобы мастер-цепь (компрессор +
// лимитер, как в студии) вывела микс в коридор при пике не выше -1 dBTP.
export const GROUP_LEVEL = 0.8;

// Семейство ролей для шаблонов рисунков.
//
// Sustained-ноты («0@2» — нота длиной два такта) удерживают звук между
// атаками. Это не украшение: без них микс из 66 дорожек звучит «пиками»
// (пик −2.85 dBTP при −21.47 LUFS), и в коридор громкости он не влезает
// никогда — K-взвешивание не считает низкие регистры.
const FAMILY = {
  drums: ['bd*4', '~ sd ~ ~', 'hh*8', 'perc*3'],
  bass: ['0 ~ 2 ~', '0*4', '[0 0 3 5]'],
  strings: ['0@2 ~ 2@2', '0@1 ~ 2@1 ~ 4@1', '0@2 ~ 4@2'],
  brass: ['0@2 ~', '0@1 ~ 2@1'],
  woodwinds: ['0@1 ~ 2@1', '0@2 ~'],
  keys: ['0@2 ~ 2@2', '0 ~ 2 ~ 4 ~'],
  choir: ['0@2 ~ 2@2', '0@4'],
  pads: ['0@4', '0@2 ~ 2@2'],
  lead: ['7 ~ 4 ~ 2 ~', '4 ~ 5 ~ 7 ~'],
  arp: ['0 2 4 7', '7 4 2 0'],
  chords: ['0@2 ~ 2@2', '0 2 4'],
  fx: ['~ ~ perc ~', '~ perc ~ ~'],
};

// Ударные: свой рисунок на роль, иначе хаты превратились бы в бочку.
const ROLE_FAMILY = {
  kick: ['bd*4', 'bd ~ bd ~'],
  snare: ['~ sd ~ ~', 'sd ~ ~ ~'],
  hats: ['hh*8', 'hh*16'],
  perc: ['perc*3', '~ perc ~ perc'],
};

// Сэмпл по роли: ударные играют сэмплами, остальные — синтезаторами.
const ROLE_SOUND = {
  kick: 'bd', snare: 'sd', hats: 'hh', perc: 'perc',
};

// Синтезатор по умолчанию для группы.
const SOUND_BY_GROUP = {
  drums: 'bd',
  bass: 'sawtooth',
  strings: 'sawtooth',
  brass: 'square',
  woodwinds: 'triangle',
  keys: 'piano',
  choir: 'sine',
  pads: 'sine',
  lead: 'square',
  arp: 'square',
  chords: 'piano',
  fx: 'perc',
};

// Регистр голоса в полутонах относительно средней ступени лада.
// Без этого все голоса оркестра стоят в одном регистре: «диапазон» и
// «разделение регистров» в скоре равны нулю (измерено на треке из 100
// дорожек до введения раскладки).
const REGISTER_BY_ROLE = {
  bass: -24, sub: -24, contrabass: -24,
  cello: -12, pads: -12, pad: -12, texture: -12,
  viola: -5, horn: -7, trombone: -7, tuba: -7, bassoon: -7,
  violin: 0, trumpet: 0, clarinet: 0, piano: 0, harp: 0, keys: 0,
  flute: 12, choir: 5, choir_soprano: 7, choir_alto: 0, choir_tenor: -5, choir_bass: -12,
  lead: 12, arp: 12, chords: 0, percussion: 0, perc: 0,
  kick: 0, snare: 0, hats: 0, fx: 0,
};

const DEFAULT_BUDGET = 4;

/** Группа роли (или сама роль, если группа неизвестна). */
export function groupOf(role) {
  return GROUP_BY_ROLE[role] || role;
}

/**
 * Токены мини-нотации: пробелы внутри групп `<...>` и `[...]` не
 * разделяют токен. Иначе `<0 2 4>` рассыпался бы на три куска.
 */
export function tokenizeMini(pattern) {
  const tokens = [];
  let current = '';
  let depth = 0;
  for (const ch of String(pattern || '')) {
    if (ch === '<' || ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === '>' || ch === ']' || ch === '}' || ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth <= 0) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Сколько атак в одном токене. */
function tokenAttacks(token) {
  if (token === '~') return 0;
  const repeat = token.match(/\*(\d+)/);
  if (repeat) return Number(repeat[1]);
  if (/^<.*>$/.test(token) || /^\[.*\]$/.test(token)) {
    const inner = token.slice(1, -1).trim();
    if (!inner) return 0;
    return tokenizeMini(inner).reduce((sum, part) => sum + tokenAttacks(part), 0);
  }
  return 1;
}

/**
 * Атаки на такт в мини-нотации.
 * `bd*4` — четыре атаки, `~` — тишина, `<0 2 4>` — три, всё остальное — одна.
 */
export function attacksPerBar(pattern) {
  return tokenizeMini(pattern).reduce((sum, token) => sum + tokenAttacks(token), 0);
}

/**
 * Прореживание рисунка: оставить каждую `stride`-ю атаку.
 * Детерминированно: атаки, взяты�� по порядку, а не случайно.
 *
 * Важно: внутри группы `<...>` тишины быть не может — Strudel такую
 * запись не парсит (проверено: рендер падал на `n("<0 ~ ~ ~")`). Поэтому
 * прореженная группа схлопывается до первого элемента.
 */
export function thinPattern(pattern, stride) {
  if (stride <= 1) return pattern;
  const tokens = tokenizeMini(pattern);
  const out = [];
  let attackIndex = 0;
  for (const token of tokens) {
    if (token === '~') {
      out.push(token);
      continue;
    }
    const repeat = token.match(/\*(\d+)/);
    if (repeat) {
      // Повтор: оставляем часть ударов («bd*4» -> «bd*2»).
      const count = Number(repeat[1]);
      const kept = Math.max(1, Math.ceil(count / stride));
      out.push(token.replace(/\*\d+$/, `*${kept}`));
      attackIndex += count;
      continue;
    }
    if (/^<.*>$/.test(token) || /^\[.*\]$/.test(token)) {
      // Группа: прореживать нельзя (тишина внутри группы запрещена) —
      // оставляем первый элемент.
      const inner = tokenizeMini(token.slice(1, -1));
      const first = inner.find((part) => tokenAttacks(part) > 0);
      out.push(first ?? '~');
      attackIndex += tokenAttacks(token);
      continue;
    }
    out.push(attackIndex % stride === 0 ? token : '~');
    attackIndex += 1;
  }
  return out.join(' ');
}

/** Идентификатор дорожки: роль и номер голоса в группе. */
export function voiceId(role, index) {
  const base = String(role).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `${base}_${index + 1}`;
}

/**
 * Разворачивает план в партии трека.
 *
 * @param {object} plan
 * @param {string} [plan.style]
 * @param {string} [plan.key]
 * @param {number} [plan.bpm]
 * @param {Array} [plan.sections] [{name, bars, energy}]
 * @param {Array} plan.groups [{group, role, count, sound?, register?, activeIn?}]
 * @returns {{parts: object, report: object}}
 */
export function expandPlan(plan) {
  const groups = Array.isArray(plan?.groups) ? plan.groups : [];
  const sections = Array.isArray(plan?.sections) ? plan.sections : [];
  const sectionNames = sections.map((section) => section.name);
  const parts = {};
  const report = {
    voices: 0,
    groups: [],
    budgetViolations: [],
    totalAttacksPerBar: 0,
  };

  // Голоса собираются по группам: бюджет плотности — на голос, а общий
  // бюджет считается по всему треку.
  const byGroup = new Map();
  for (const entry of groups) {
    const role = entry.role || entry.group;
    const group = entry.group || groupOf(role);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({ ...entry, role, group });
  }

  for (const [group, entries] of byGroup) {
    const perVoiceBudget = entries[0].budget ?? GROUP_BUDGET[group] ?? DEFAULT_BUDGET;
    const voices = [];
    for (const entry of entries) {
      const count = Math.max(1, Math.round(entry.count ?? 1));
      const family = ROLE_FAMILY[entry.role] || FAMILY[group] || ['0 ~ 2 ~'];
      const sound = entry.sound || ROLE_SOUND[entry.role] || SOUND_BY_GROUP[group] || 'sawtooth';
      const activeIn = entry.activeIn?.length ? entry.activeIn : sectionNames;
      for (let i = 0; i < count; i += 1) {
        voices.push({
          id: voiceId(entry.role, i),
          role: entry.role,
          group,
          pattern: family[i % family.length],
          sound,
          activeIn: [...activeIn],
          // Регистр голоса: явный сдвиг в плане важнее роли.
          transpose: Number.isFinite(entry.transpose) ? entry.transpose : REGISTER_BY_ROLE[entry.role],
        });
      }
    }

    // Плотность одного голоса: прореживаем, пока голос не укладывается в
    // бюджет. Шаг удваивается — детерминированно.
    for (const voice of voices) {
      let stride = 1;
      while (stride <= 64 && attacksPerBar(voice.pattern) > perVoiceBudget) {
        stride *= 2;
        voice.pattern = thinPattern(voice.pattern, stride);
      }
      voice.stride = stride;
    }

    // Громкость: сумма голосов группы держится у GROUP_LEVEL.
    const voiceGain = GROUP_LEVEL / Math.max(1, voices.length);
    for (const voice of voices) {
      if (parts[voice.id]) continue; // идентификатор уже занят
      const part = {
        role: voice.role,
        activeIn: voice.activeIn,
        pattern: voice.pattern,
        sound: voice.sound,
        effects: [{ name: 'gain', params: [Number(voiceGain.toFixed(4))] }],
      };
      // Регистр голоса: у скрипок смещение, у альтов — вниз, у флейт — вверх.
      const register = voice.transpose;
      if (Number.isFinite(register) && register !== 0) part.transpose = register;
      parts[voice.id] = part;
    }

    report.groups.push({
      group,
      voices: voices.length,
      perVoiceBudget,
      attacksPerBar: voices.reduce((sum, voice) => sum + attacksPerBar(voice.pattern), 0),
    });
    report.voices += voices.length;
  }

  // Общий бюджет атак на такт: если трек перегружен, прореживаем голоса
  // по кругу (детерминированно), пока сумма не уложится.
  const budget = globalAttackBudget(report.voices);
  const ids = Object.keys(parts);
  let stride = 1;
  const total = () => ids.reduce((sum, id) => sum + attacksPerBar(parts[id].pattern), 0);
  while (stride <= 64 && total() > budget) {
    stride += 1;
    for (const id of ids) {
      if (attacksPerBar(parts[id].pattern) <= 1) continue;
      parts[id].pattern = thinPattern(parts[id].pattern, stride);
    }
  }
  report.globalStride = stride;
  report.globalBudget = budget;
  report.totalAttacksPerBar = total();
  report.budgetOk = report.totalAttacksPerBar <= budget;
  if (!report.budgetOk) {
    report.budgetViolations.push({
      group: 'все',
      attacks: report.totalAttacksPerBar,
      budget,
    });
  }
  return { parts, report };
}

/** Собирает спеку трека из плана. */
export function specFromPlan(plan) {
  const { parts, report } = expandPlan(plan);
  const sections = (plan?.sections ?? []).map((section) => ({
    name: section.name,
    cycles: section.bars ?? section.cycles ?? 8,
    energy: section.energy ?? 0.5,
    harmony: section.harmony ?? 'Cm',
  }));
  return {
    spec: {
      meta: { style: plan.style ?? 'cinematic', key: plan.key ?? 'Cmin', bpm: plan.bpm ?? 90 },
      structure: { sections },
      parts: { roles: parts },
    },
    report,
  };
}
