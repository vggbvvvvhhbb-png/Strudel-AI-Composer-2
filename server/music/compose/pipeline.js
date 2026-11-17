// План → validateTrackSpec/checkSpec → синхронная компиляция → оценка/refine.
import { TrackSpecSchema, validateTrackSpec } from '../../../src/schemas/track-spec.schema.js';
import { ROLES as SPEC_ROLES, SAMPLED_ROLES, ROLE_RE } from '../../../src/schemas/parts.js';
import { checkSpec } from '../spec/check.js';
import { formsForStyle, roleFor, rolesForStyle, selectPattern } from '../knowledge/index.js';
import { detectStyle } from '../references.js';
import { minedDigest, minedStats } from '../mining/library.js';
import { matchMinedPattern } from '../mining/groove.js';
import { compileForProtocol } from './compiled.js';
import { compileTrackSpec } from '../compiler/index.js';
// Регистрирует серверный загрузчик каталога Timbre в общем компиляторе (D-128).
import '../../samples/timbre.js';
import { applySamplePlan, passportHints, sampleDigest } from './sample-plan.js';

const SPEC_STYLES = TrackSpecSchema.shape.meta.shape.style.options;
const SECTION_KINDS = TrackSpecSchema.shape.structure.shape.sections.element.shape.name.options;

/** Границы длины трека в тактах — те же, что и у проверки спеки. */
const MIN_TRACK_BARS = 16;
const MAX_TRACK_BARS = 96;

const STYLE_HINTS = [
  ['techno', ['techno', 'техно', 'industrial', 'рейв']],
  ['house', ['house', 'хаус', 'disco', 'диско']],
  ['synthwave', ['synthwave', 'синтвейв', 'retrowave']],
  ['trap', ['trap', 'трэп', 'drill', 'дрилл', 'phonk', 'фонк']],
  ['lo-fi', ['lo-fi', 'lofi', 'лоу-фай', 'лофай', 'boom bap']],
  ['dubstep', ['dubstep', 'дабстеп']],
  ['jazz', ['jazz', 'джаз', 'swing', 'blues']],
  ['rock', ['rock', 'рок', 'гитар', 'guitar', 'indie']],
  ['ambient', ['ambient', 'эмбиент', 'drone', 'дрон']],
  ['cinematic', ['cinematic', 'кинематограф', 'soundtrack', 'film score']],
];

export function detectSpecStyle(text) {
  const hay = String(text ?? '').toLowerCase();
  let best = null;
  for (const [id, needles] of STYLE_HINTS) {
    for (const needle of needles) {
      const at = hay.indexOf(needle);
      if (at >= 0 && (!best || at < best.at)) best = { id, at };
    }
  }
  if (best) return best.id;
  if (/спокойн|calm|медитац|meditat|тих|расслаб/.test(hay)) return 'ambient';
  if (/эпик|epic|тревожн|драматич|монумент/.test(hay)) return 'cinematic';
  if (/chill|чилл|уютн/.test(hay)) return 'jazz';
  if (/ностальг|nostalg/.test(hay)) return 'lo-fi';
  const profile = detectStyle(text);
  return SPEC_STYLES.includes(profile) ? profile : 'techno';
}

// Имена библиотеки не являются альтернативным входным контрактом TrackSpec.
function knowledgeStyle(style) {
  return style === 'lo-fi' ? 'lofi' : style === 'dubstep' ? 'trap' : style;
}

function validatePlan(raw) {
  try {
    const checked = checkSpec(validateTrackSpec(raw));
    // Zod проверяет форму, но не исполнимость mini-нотации и эффектов.
    if (checked.ok) compileTrackSpec(checked.spec);
    return checked;
  } catch (err) {
    return { ok: false, spec: null, errors: [err.message || String(err)], warnings: [] };
  }
}

/**
 * Сводка библиотеки для стиля: какие звуки и рисунки можно ставить.
 *
 * ЗАЧЕМ. Модель выдумывала «vinyl rain texture» и «hats» — такие значения
 * компилятор отвергает, и спека падала целиком, хотя остальное было в
 * порядке. Сводка отдаёт ровно те сэмплы и шаблоны, которые библиотека уже
 * проверила настоящим парсером Strudel.
 *
 * @param {string} style
 * @returns {string}
 */
export function styleDigest(style) {
  const libraryStyle = knowledgeStyle(style);
  const roles = rolesForStyle(libraryStyle);
  const mined = minedDigest(libraryStyle);
  if (!roles.length && !mined) return '';
  const lines = roles.map((role) => {
    const info = roleFor(libraryStyle, role);
    const sampled = SAMPLED_ROLES.has(role);
    const sounds = sampled ? (info?.sounds ?? []) : (info?.synth ? [info.synth] : []);
    const patterns = (info?.patterns ?? []).slice(0, 3);
    const soundText = sampled
      ? (sounds.length ? `sound — один из: ${sounds.join(', ')}` : 'sound — нет: роль играет тонами')
      : `sound — '${sounds[0] ?? 'sine'}'`;
    return `- ${role}: ${soundText}; pattern — один из: ${patterns.join(' / ') || '—'}`;
  });
  // Измеренная статистика стиля (D-112) — числа из паспортов разбора.
  // Редкий стиль (мало разборов) в промпт не попадает: вывод по двум
  // трекам — это не «стиль», а выдумка.
  if (mined) lines.push(mined);
  return lines.join('\n');
}

/**
 * Приводит стиль, темп и лад к тому, что понимает схема.
 *
 * Модель писала «phonk drift» вместо стиля из списка — и вся спека падала
 * целиком, хотя остальное было в порядке. Незнакомый стиль переводится в
 * ближайший допустимый, лад приводится к виду «Fmin», темп зажимается в
 * 60..180. Это не подгонка под результат: всё, что приводится, остаётся
 * осмысленным и проверяемым.
 *
 * @param {object} raw спека от модели
 * @param {string} fallbackStyle стиль, определённый по запросу
 * @returns {object}
 */
export function normalizeSpec(raw, fallbackStyle) {
  if (!raw || typeof raw !== 'object' || !raw.meta || typeof raw.meta !== 'object') return raw;
  const meta = { ...raw.meta };
  if (typeof meta.style === 'string' && !SPEC_STYLES.includes(meta.style)) {
    meta.style = detectSpecStyle(meta.style) || fallbackStyle;
  }
  if (typeof meta.bpm === 'number' && Number.isFinite(meta.bpm)) {
    meta.bpm = Math.min(180, Math.max(60, Math.round(meta.bpm)));
  }
  if (typeof meta.key === 'string') {
    const key = meta.key.trim().replace(/\s+/g, '');
    meta.key = /minor$/i.test(key)
      ? key.replace(/minor$/i, 'min')
      : /major$/i.test(key)
        ? key.replace(/major$/i, 'maj')
        : key;
  }
  // schemaVersion в схеме — строка вида «1.2», а модель часто присылает
  // число 1.2 (или целое 1). Из-за одного этого поля валидная спека
  // отбрасывалась целиком и трек собирался из запасного плана библиотеки.
  if (typeof meta.schemaVersion === 'number' && Number.isFinite(meta.schemaVersion)) {
    const asText = String(meta.schemaVersion);
    if (/^\d+\.\d+$/.test(asText)) meta.schemaVersion = asText;
    else delete meta.schemaVersion;
  } else if (typeof meta.schemaVersion === 'string' && !/^\d+\.\d+$/.test(meta.schemaVersion)) {
    delete meta.schemaVersion;
  }
  return { ...raw, meta };
}

/**
 * Допустимые символы mini-нотации — ровно те, что принимает компилятор.
 * Длинное тире и кириллица сюда не входят: модель их приносила, и одна
 * такая буква ломала всю спеку.
 */
const MINI_CHARS = /^[\w\s~*\[\]<>.,:!#b+\-\/|?@()]+$/;

/**
 * Чинит mini-нотацию: типографские тире и кавычки заменяются, недопустимые
 * символы убираются.
 *
 * @param {unknown} text
 * @returns {string|null} исправленная нотация или null, если чинить нечего
 */
export function sanitizePattern(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .replace(/[—–]/g, '-')
    .replace(/[“”„]/g, '"')
    .replace(/[^\w\s~*\[\]<>.,:!#b+\-\/|?@()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || !MINI_CHARS.test(cleaned)) return null;
  return cleaned;
}

/**
 * Чинит спеку модели по библиотеке.
 *
 * ЗАЧЕМ. Модель подходит к правильной форме близко, но ошибается в деталях:
 * роль партии без поля role, несуществующий сэмпл, длинное тире внутри
 * mini-нотации, неизвестное имя секции. Раньше такая спека отбрасывалась
 * целиком, и трек собирался из запасного плана библиотеки — то есть запрос
 * пользователя не выполнялся вовсе. Теперь известные значения заменяются на
 * библиотечные, а партии, чью роль определить нельзя, убираются.
 *
 * @param {object} raw спека от модели
 * @param {string} style канонический стиль
 * @returns {object}
 */
export function repairSpec(raw, style) {
  if (!raw || typeof raw !== 'object') return raw;
  const libraryStyle = knowledgeStyle(style);
  const next = { ...raw };
  const meta = { ...(next.meta ?? {}) };

  if (typeof meta.style !== 'string' || !SPEC_STYLES.includes(meta.style)) {
    meta.style = SPEC_STYLES.includes(style) ? style : 'techno';
  }
  if (!Number.isFinite(meta.bpm)) meta.bpm = 120;
  if (typeof meta.key !== 'string' || !/^[A-G][#b]?[a-z]*$/.test(meta.key)) meta.key = 'Cmin';
  next.meta = meta;

  // Секции: неизвестное имя и мусорные числа заменяем на осмысленные.
  const sections = Array.isArray(next.structure?.sections) ? next.structure.sections : [];
  const fixedSections = [];
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    if (!SECTION_KINDS.includes(section.name)) continue;
    fixedSections.push({
      ...section,
      cycles: Number.isFinite(section.cycles) ? Math.min(64, Math.max(1, Math.round(section.cycles))) : 4,
      energy: Number.isFinite(section.energy) ? Math.min(1, Math.max(0, section.energy)) : 0.5,
      harmony: typeof section.harmony === 'string' && section.harmony.trim() ? section.harmony : 'Cm Fm Gm Cm',
    });
  }
  if (fixedSections.length) {
    // Длина трека: 16..96 тактов. Модель часто собирает короче или длиннее —
    // растягиваем и ужимаем секции пропорционально, а не отбрасываем трек.
    const total = fixedSections.reduce((sum, section) => sum + section.cycles, 0);
    if (total < MIN_TRACK_BARS || total > MAX_TRACK_BARS) {
      const target = Math.min(MAX_TRACK_BARS, Math.max(MIN_TRACK_BARS, total));
      const scaled = fixedSections.map((section) => ({
        ...section,
        cycles: Math.max(1, Math.round((section.cycles / total) * target)),
      }));
      let diff = target - scaled.reduce((sum, section) => sum + section.cycles, 0);
      let index = 0;
      while (diff !== 0 && scaled.length && index < 1000) {
        const section = scaled[index % scaled.length];
        const step = diff > 0 ? 1 : -1;
        if (section.cycles + step >= 1) {
          section.cycles += step;
          diff -= step;
        }
        index += 1;
      }
      fixedSections.length = 0;
      fixedSections.push(...scaled);
    }
    next.structure = { ...next.structure, sections: fixedSections };
  }

  // Партии: роль, сэмпл и рисунок — по библиотеке.
  const roles = next.parts?.roles;
  if (roles && typeof roles === 'object') {
    const fixedRoles = {};
    for (const [id, part] of Object.entries(roles)) {
      if (!part || typeof part !== 'object') continue;
      const declared = typeof part.role === 'string' && ROLE_RE.test(part.role) ? part.role : null;
      const fromKey = SPEC_ROLES.includes(id) ? id : null;
      const role = declared ?? fromKey;
      // Роль не определить — партию использовать нечем.
      if (!role) continue;

      const info = roleFor(libraryStyle, role);
      const sampled = SAMPLED_ROLES.has(role);
      const allowedSounds = sampled ? (info?.sounds ?? []) : (info?.synth ? [info.synth] : []);
      let sound = part.sound;
      if (!allowedSounds.includes(sound)) sound = allowedSounds[0] ?? (sampled ? 'bd' : 'sine');

      // Рисунок должен быть ПРИГОДНЫМ для роли, а не просто набором букв:
      // ударной партии — имя сэмпла, тональной — цифра (степень). Иначе в
      // коде появится n("vinyl rain texture"), и REPL на этом упадёт.
      const fits = (text) => {
        if (!text) return false;
        if (sampled) {
          const names = allowedSounds.length ? allowedSounds : ['bd', 'sd', 'hh'];
          return names.some((name) => text.includes(name));
        }
        return /\d/.test(text);
      };
      const libraryPattern = sanitizePattern((info?.patterns ?? [])[0]);
      let pattern = sanitizePattern(part.pattern);
      if (!fits(pattern)) pattern = fits(libraryPattern) ? libraryPattern : (sampled ? 'bd*4' : '0 ~ 2 4');

      const activeIn = Array.isArray(part.activeIn) && part.activeIn.length
        ? part.activeIn.filter((name) => fixedSections.some((section) => section.name === name))
        : fixedSections.map((section) => section.name);
      if (!activeIn.length) continue;

      fixedRoles[id] = { ...part, role, sound, pattern, activeIn };
    }
    next.parts = { ...next.parts, roles: fixedRoles };
  }
  return next;
}

function specMessages(prompt, style, sampleBlock = '') {
  const system = [
    'Ты — композитор. Спланируй трек, не пиши JavaScript или Strudel-код.',
    'Верни строго один JSON-объект TrackSpec без текста вокруг.',
    `meta: {style, bpm, key, schemaVersion?}; style: ${SPEC_STYLES.join(', ')}; bpm 60..180.`,
    'key: заглавная нота A..G, необязательный #/b, затем строчные буквы лада; например Cmin, Am, F#minor. Двоеточие в key запрещено.',
    `structure: {sections: [{name, cycles, energy, harmony, parameters?}]}; name: ${SECTION_KINDS.join(', ')}.`,
    'cycles — целое число циклов >=1; energy 0..1; harmony — строка аккордов, например "Cm Fm Gm Cm".',
    'parameters?: {cutoff?: [число, число], gain?: [число, число]}.',
    '',
    'parts: {roles: {...}} — КЛЮЧ записи это идентификатор партии, а НЕ роль:',
    '  ключи вида KICK_1, SNARE_1, HATS_1, PERC_1, BASS_1, PAD_1, CHORDS_1, LEAD_1, ARP_1, FX_1, TEX_1, SUB_1;',
    '  вторая дорожка той же роли — KICK_2;',
    `  значение партии: {role, activeIn, pattern, sound, effects?}, где role — ровно одно из: ${SPEC_ROLES.join(', ')}.`,
    'activeIn — массив имён существующих секций; партия играет во всех секциях с указанным именем.',
    'pattern — mini-нотация, НЕ слова. Допустимы только символы: буквы, цифры,',
    '  пробел, ~ * [ ] < > . , : ! # b + - / | ? @ ( ). Никаких слов и фраз:',
    '  «vinyl rain texture» — ошибка. Для ударных: "bd*4", "~ sd ~ sd", "hh*8".',
    '  Для тональных партий — степени: "0 ~ 2 4", "<0 3 4 0>", "[0 0 3 5]".',
    'sound — ТОЛЬКО из белого списка ниже; другое имя компилятор отвергнет.',
    'effects?: [{name, params}]; поддерживаются room, delay, gain, lpf, hpf с одним числовым аргументом. Не придумывай методы.',
    'reasoning? — короткое объяснение плана.',
    'План: 2..12 секций, всего 16..96 циклов; энергия и набор активных ролей различаются; гармония развивается.',
    'Никаких верхнеуровневых harmony, form, motif, automation; никаких recipe/variant.',
    ...(sampleBlock ? ['', sampleBlock] : []),
    '',
    `Белый список для стиля «${style}» — бери звуки и рисунки отсюда:`,
    styleDigest(style),
    '',
    `Стиль запроса: ${style}. Пример канонической структуры:`,
    JSON.stringify(fallbackSpec(style, 1)),
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `Запрос: ${prompt}` }];
}
/**
 * Достаёт JSON-объект из ответа модели.
 *
 * Модель может завернуть JSON в markdown-обёртку или добавить текст
 * вокруг — вырезаем первый сбалансированный объект.
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // markdown-обёртка ```json ... ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(body);
  } catch {
    // не чистый JSON — ищем первый сбалансированный {...}
  }

  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Запасная спека из библиотеки форм.
 *
 * Это не «плохой трек», а последний рубеж: если модель не смогла
 * придумать план, мы собираем его сами — форма из библиотеки,
 * прогрессия стиля, роли по энергии секции.
 *
 * @param {string} style
 * @param {number} seed
 * @returns {object} спека, проходящая checkSpec
 */
export function fallbackSpec(style, seed = 1) {
  const canonicalStyle = SPEC_STYLES.includes(style) ? style : 'techno';
  const libraryStyle = knowledgeStyle(canonicalStyle);
  const forms = formsForStyle(libraryStyle);
  const index = Math.abs(Math.trunc(seed)) % Math.max(1, forms.length);
  const form = forms[index];
  const source = form?.sections || [
    { kind: 'intro', bars: 8, energy: 0.3, roles: ['pad', 'hats'] },
    { kind: 'drop', bars: 16, energy: 0.9, roles: ['kick', 'hats', 'bass', 'pad'] },
    { kind: 'outro', bars: 8, energy: 0.25, roles: ['pad', 'hats'] },
  ];
  const harmonies = ['Cm Fm Gm Cm', 'Ab Bb Cm Gm', 'Fm Cm Ab Gm'];
  const sections = source.map((section, i) => ({
    name: section.kind,
    cycles: section.bars,
    energy: section.energy,
    harmony: harmonies[(index + i) % harmonies.length],
  }));
  const roles = {};
  const mined = minedStats(libraryStyle);
  source.forEach((section) => {
    for (const role of section.roles || []) {
      if (!SPEC_ROLES.includes(role)) continue;
      if (!roles[role]) {
        const info = roleFor(libraryStyle, role);
        roles[role] = {
          activeIn: [],
          pattern: selectPattern(info, 'default', index, seed) || '0 ~ 2 4',
          sound: info?.synth || info?.sounds?.[0] || 'sine',
        };
      }
      if (!roles[role].activeIn.includes(section.kind)) roles[role].activeIn.push(section.kind);
    }
  });
  // Измеренный грув стиля (D-112) выбирает ударный рисунок из библиотеки
  // знаний: ближе всего к измеренной гистограмме атак. Если измерений нет
  // (стиль редкий или паспортов мало) — рисунок остаётся прежним.
  if (mined) {
    for (const role of Object.keys(roles)) {
      if (!SAMPLED_ROLES.has(role)) continue;
      const info = roleFor(libraryStyle, role);
      const candidates = Array.isArray(info?.patterns) ? info.patterns : [];
      const match = matchMinedPattern(candidates, mined);
      if (match) roles[role].pattern = match.pattern;
    }
  }
  const bpm = { techno: 132, house: 122, 'lo-fi': 78, ambient: 64, dubstep: 140, synthwave: 100, trap: 140, jazz: 118, rock: 128, cinematic: 90 }[canonicalStyle];
  return validateTrackSpec({
    meta: { style: canonicalStyle, bpm, key: 'Cmin' },
    structure: { sections },
    parts: { roles },
    reasoning: 'Запасной план: секции и партии взяты из библиотеки знаний.',
  });
}

/**
 * Шаг 1: модель предлагает спеку.
 *
 * @param {object} options
 * @param {string} options.prompt запрос пользователя
 * @param {string} options.style стиль
 * @param {Function} options.completeChat функция вызова модели
 * @param {number} [options.seed]
 * @returns {Promise<{raw: object|null, text: string}>}
 */
async function askModel({ prompt, style, completeChat, seed, signal, onUsage, sampleBlock }) {
  const text = await completeChat({
    messages: specMessages(prompt, style, sampleBlock),
    temperature: 0.4,
    signal,
    onUsage,
    responseFormat: { type: 'json_object' },
  });
  return { raw: extractJson(text), text };
}

/**
 * Полный проход пайплайна без оценки и refine.
 *
 * Шаги: спросить модель → проверить → (retry с замечаниями) → (fallback) →
 * скомпилировать. Оценка и исполнение выполняются вызывающим кодом.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.style]
 * @param {Function} options.completeChat
 * @param {number} [options.seed]
 * @param {Function} [options.onEvent] колбэк события пайплайна
 * @returns {Promise<object>}
 */
export async function buildTrack({
  prompt,
  style,
  completeChat,
  seed = Math.floor(Math.random() * 2 ** 31),
  signal,
  onEvent,
  onUsage,
  sampleEntry = null,
}) {
  const trackStyle = SPEC_STYLES.includes(style) ? style : detectSpecStyle(prompt);
  const emit = (event, payload) => {
    if (typeof onEvent === 'function') onEvent(event, payload);
  };

  emit('style', { style: trackStyle });

  // Паспорт сэмпла (D-119): измеренные признаки идут и в промпт модели,
  // и в детерминированную правку готовой спеки — модель не может их потерять.
  const sampleHints = sampleEntry ? passportHints(sampleEntry.passport) : null;
  const sampleBlock = sampleEntry ? sampleDigest(sampleEntry, sampleHints) : '';
  if (sampleEntry) emit('sample', { id: sampleEntry.id, name: sampleEntry.name ?? null, hints: sampleHints });

  let spec = null;
  let raw = null;
  let modelCalls = 0;
  let lastErrors = [];

  // До двух заходов за спекой: первый — с нуля, второй — чинящая
  // итерация, где модели показывают её же спеку и конкретные ошибки
  // (одна чинящая итерация, как в ТЗ).
  while (modelCalls < 2) {
    modelCalls += 1;
    let answer;
    try {
      answer = await askModel({ prompt, style: trackStyle, completeChat, seed, signal, onUsage, sampleBlock });
    } catch (err) {
      if (signal?.aborted) throw err;
      emit('warn', { message: `Модель не ответила: ${err.message || err}` });
      break;
    }
    raw = repairSpec(normalizeSpec(answer.raw, trackStyle), trackStyle);
    if (!raw) {
      lastErrors = ['ответ модели не разобрался как JSON'];
      emit('warn', { message: 'Ответ модели не разобрался как JSON' });
      continue;
    }

    const check = validatePlan(raw);
    if (check.ok) {
      spec = check.spec;
      break;
    }

    lastErrors = check.errors;
    emit('warn', { message: `Спека не прошла проверку: ${check.errors.join('; ')}` });

    // Чинящая итерация: показываем модели её же спеку и конкретные ошибки.
    if (modelCalls === 1) {
      try {
        modelCalls += 1;
        const fixed = await completeChat({
          messages: [
            { role: 'system', content: specMessages(prompt, trackStyle, sampleBlock)[0].content },
            {
              role: 'user',
              content: [
                `Запрос: ${prompt}`,
                '',
                'Твоя предыдущая спека не прошла проверку:',
                JSON.stringify(raw),
                '',
                'Ошибки:',
                ...check.errors.map((e) => `- ${e}`),
                '',
                'Верни исправленную спеку — строго JSON по той же схеме.',
              ].join('\n'),
            },
          ],
          temperature: 0.2,
          signal,
          onUsage,
          responseFormat: { type: 'json_object' },
        });
        const fixedRaw = repairSpec(normalizeSpec(extractJson(fixed), trackStyle), trackStyle);
        if (fixedRaw) {
          const fixedCheck = validatePlan(fixedRaw);
          if (fixedCheck.ok) {
            spec = fixedCheck.spec;
            break;
          }
          lastErrors = fixedCheck.errors;
          emit('warn', { message: `Исправленная спека тоже невалидна: ${fixedCheck.errors.join('; ')}` });
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        emit('warn', { message: `Чинящая итерация не удалась: ${err.message || err}` });
      }
    }
  }

  let usedFallback = false;
  if (!spec) {
    usedFallback = true;
    const fallback = fallbackSpec(trackStyle, seed);
    const check = checkSpec(fallback);
    if (!check.ok) throw new Error(`Запасной план не прошёл проверку: ${check.errors.join('; ')}`);
    spec = validateTrackSpec(check.spec);
    emit('fallback', { message: 'Модель не дала валидную спеку — собран запасной план из библиотеки' });
  }

  let sampleApplied = null;
  if (sampleEntry) {
    const { spec: withSample, applied } = applySamplePlan(spec, { entry: sampleEntry, hints: sampleHints });
    const check = validatePlan(withSample);
    if (check.ok) {
      spec = check.spec;
      sampleApplied = applied;
    } else {
      emit('warn', { message: `План вокруг сэмпла не прошёл проверку: ${check.errors.join('; ')}` });
    }
  }

  emit('spec', { spec, attempts: modelCalls, usedFallback, errors: lastErrors, sample: sampleApplied });

  // Компиляция — чистая детерминированная функция.
  spec = validateTrackSpec(spec);
  const compiled = compileForProtocol(spec);
  emit('compiled', {
    code: compiled.code,
    sections: compiled.sections,
    parts: compiled.parts,
    warnings: compiled.warnings,
    trace: compiled.trace,
  });

  return { spec, compiled, style: trackStyle, attempts: modelCalls, usedFallback, seed, raw, errors: lastErrors, sample: sampleApplied };
}

export { SPEC_STYLES, SPEC_ROLES, SECTION_KINDS };
