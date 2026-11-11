// Пайплайн структурной композиции: спека → код → проверка → оценка.
//
// Ключевая идея цикла: LLM выбирает ИДЕИ (гармония, форма, роли, энергия),
// а детерминированный компилятор превращает их в код. Поэтому валидность
// достигается по построению: спека проверяется Zod и checkSpec, код —
// настоящим исполнением в Strudel, а не разбором текста.
//
// Пайплайн не бросает исключений на невалидной спеке: он её чинит
// (один retry с моделью), а если не вышло — детерминированно собирает
// запасную спеку из форм библиотеки. Трек должен получиться всегда.

import { compile } from '../compiler/index.js';
import { checkSpec } from '../spec/check.js';
import { jsonSchemaForSpec, SPEC_STYLES, SPEC_ROLES, SECTION_KINDS } from '../spec/schema.js';
import { progressionsForStyle, formsForStyle, roleFor } from '../knowledge/index.js';
import { detectStyle } from '../references.js';

/**
 * Стиль из свободного текста — для спеки нужен один из SPEC_STYLES.
 *
 * Профили стилей (references.js) и стили спеки (schema.js) — разные
 * списки: в профилях есть hiphop, в спеке — jazz, rock, cinematic.
 * Поэтому стиль спеки выводится отдельно.
 *
 * Подсказки разложены на два уровня:
 *   • ЯВНЫЕ — название жанра. Если в тексте несколько жанров, берётся
 *     тот, который встретился РАНЬШЕ: «спокойный lo-fi» — это lo-fi,
 *     а не ambient, хотя «спокойный» и тянет в сторону ambient.
 *   • НАСТРОЕНИЕ — слово без жанра. Работает, только если явных нет.
 */
const STYLE_HINTS = [
  ['dnb', ['dnb', 'drum n bass', 'drum and bass', 'drum & bass', 'днб', 'драм-н-бейс', 'нейрофанк', 'neurofunk']],
  ['techno', ['techno', 'техно', 'club', 'клэб', 'industrial', 'индастриал', 'rave', 'рейв']],
  ['house', ['house', 'хаус', 'disco', 'диско', 'deep house', 'tech house', 'afro house']],
  ['synthwave', ['synthwave', 'синтвейв', 'retrowave', 'ретроволн', 'outrun']],
  ['trap', ['trap', 'трэп', 'трейп', 'drill', 'дрилл']],
  ['lofi', ['lo-fi', 'lofi', 'лоу-фай', 'лофай', 'boom bap', 'бум-бэп']],
  ['jazz', ['jazz', 'джаз', 'swing', 'свинг', 'blues', 'блюз']],
  ['rock', ['rock', 'рок', 'гитар', 'guitar', 'indie']],
  ['ambient', ['ambient', 'эмбиент', 'drone', 'дрон']],
  ['cinematic', ['cinematic', 'кинематограф', 'кино', 'film score', 'soundtrack']],
];

/** Слова без жанра: работают, только если явного жанра в тексте нет. */
const MOOD_HINTS = [
  ['ambient', ['спокойн', 'calm', 'медитац', 'meditat', 'тих', 'расслаб']],
  ['cinematic', ['эпик', 'epic', 'тревожн', 'драматич', 'монумент']],
  ['jazz', ['chill', 'чилл', 'уютн']],
  ['lofi', ['уютн', 'ностальг', 'nostalg']],
];

/**
 * Определяет стиль спеки по тексту запроса.
 * @param {string} text
 * @returns {string} id из SPEC_STYLES
 */
export function detectSpecStyle(text) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return 'techno';

  // Явный жанр: побеждает тот, что встретился раньше.
  let best = null;
  for (const [id, needles] of STYLE_HINTS) {
    for (const needle of needles) {
      const at = hay.indexOf(needle);
      if (at < 0) continue;
      if (!best || at < best.at) best = { id, at };
      break; // для одного жанра достаточно первого совпадения
    }
  }
  if (best) return best.id;

  // Явного жанра нет — ищем по настроению.
  for (const [id, needles] of MOOD_HINTS) {
    if (needles.some((n) => hay.includes(n))) return id;
  }

  // Ничего не нашли — берём стиль профиля (может дать 'generic').
  const profile = detectStyle(text);
  if (SPEC_STYLES.includes(profile)) return profile;
  return 'techno';
}

/**
 * Описание библиотеки для промпта: что модели разрешено выбирать.
 *
 * Без этого модель выдумывает свои id прогрессий и роли — и спека
 * не проходит checkSpec. Список прогрессий, форм и ролей подаётся
 * как данные, а не как «придумай что-нибудь».
 */
function libraryBrief(style) {
  const progressions = progressionsForStyle(style)
    .map((p) => `- ${p.id}: степени [${p.degrees.join(', ')}], лад ${p.mode}, аккорд ${p.barsPerChord} такт, характер «${p.feel}»`)
    .join('\n');
  const forms = formsForStyle(style)
    .map((f) => `- ${f.id}: ${f.sections.map((s) => `${s.kind}(${s.bars})`).join(' → ')}`)
    .join('\n');
  const roles = SPEC_ROLES.filter((role) => roleFor(style, role))
    .map((role) => role)
    .join(', ');
  return { progressions, forms, roles };
}

/**
 * Текст промпта для генерации спеки.
 * @param {string} prompt запрос пользователя
 * @param {string} style стиль спеки
 */
function specMessages(prompt, style) {
  const brief = libraryBrief(style);
  const schema = jsonSchemaForSpec();
  const system = [
    'Ты — композитор. Твоя задача — спланировать трек, а не писать код.',
    'Ответ — строго один JSON-объект по схеме ниже. Никакого текста вокруг.',
    '',
    'Что ты выбираешь:',
    '- meta.style — стиль трека.',
    '- meta.bpm — темп 50..190.',
    '- meta.key — тональность в формате "c:minor" (полное имя лада одним словом: major, minor, dorian, phrygian, lydian, mixolydian).',
    '- harmony — прогрессия из списка ниже (progressionId) или свои степени (degrees, 0..6).',
    '- form — массив секций трека: kind (тип секции), bars (длина в тактах, 4..32), energy (0..1), roles (какие партии играют).',
    '- roles в секции — объект: роль → {recipe, variant}. recipe: default/busy/sparse (плотность рисунка). variant: A/B/C (рисунок партии).',
    '- progressionOverride в секции — если в этой секции нужна другая гармония.',
    '- transition — переход В эту секцию: {into: "drop", type: "riser"}.',
    '- motif — {degrees, rhythm, transforms}: ритм мотива строками "x ~ x x".',
    '- reasoning — одно-два предложения: почему такой план.',
    '',
    'Правила плана:',
    '- Суммарная длина трека 16..96 тактов, минимум 2 секции.',
    '- Секции различаются: у интро энергия ниже, у дропа — выше. Одинаковая энергия у всех секций — плохой план.',
    '- В каждой секции 2..6 ролей, и роли секций отличаются: не пиши один и тот же набор ролей везде.',
    '- Гармония меняется: одна и та же прогрессия на весь трек — плохой план.',
    '- Роли и прогрессии бери из списка библиотеки для этого стиля.',
    '',
    `Стиль: ${style}`,
    '',
    'Прогрессии (progressionId):',
    brief.progressions || '(нет)',
    '',
    'Формы (образец длины и набора секций):',
    brief.forms || '(нет)',
    '',
    `Доступные роли: ${brief.roles}`,
    '',
    'JSON Schema ответа:',
    JSON.stringify(schema.schema),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Запрос: ${prompt}` },
  ];
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
  const forms = formsForStyle(style);
  const progressions = progressionsForStyle(style);
  const form = forms.length ? forms[seed % forms.length] : null;
  const progression = progressions.length ? progressions[seed % progressions.length] : null;

  const sections = (form?.sections || []).map((section) => {
    // Энергия секции → плотность рисунка: интро разреженнее, дроп плотнее.
    const recipe = section.energy >= 0.75 ? 'busy' : section.energy <= 0.4 ? 'sparse' : 'default';
    const roles = {};
    for (const role of section.roles || []) {
      roles[role] = { recipe };
    }
    const out = {
      kind: section.kind,
      bars: section.bars,
      energy: section.energy,
      roles,
    };
    if (section.transition) out.transition = section.transition;
    return out;
  });

  const bpm = { techno: 132, house: 122, dnb: 174, lofi: 78, ambient: 64, synthwave: 100, trap: 140, jazz: 118, rock: 128, cinematic: 90 }[style] || 120;

  return {
    meta: { style, bpm, key: 'c:minor', seed },
    harmony: progression
      ? { progressionId: progression.id, mode: progression.mode, barsPerChord: progression.barsPerChord }
      : { degrees: [0, 5, 2, 6], mode: 'minor', barsPerChord: 2 },
    form: sections,
    reasoning: 'Запасной план: форма и прогрессия взяты из библиотеки знаний.',
  };
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
async function askModel({ prompt, style, completeChat, seed, signal, onUsage }) {
  const text = await completeChat({
    messages: specMessages(prompt, style),
    temperature: 0.4,
    signal,
    onUsage,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'track_spec_v2', strict: true, schema: jsonSchemaForSpec().schema },
    },
  });
  return { raw: extractJson(text), text };
}

/**
 * Полный проход пайплайна без оценки и refine.
 *
 * Шаги: спросить модель → проверить → (retry с замечаниями) → (fallback) →
 * скомпилировать → проверить код исполнением.
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
}) {
  const trackStyle = SPEC_STYLES.includes(style) ? style : detectSpecStyle(prompt);
  const emit = (event, payload) => {
    if (typeof onEvent === 'function') onEvent(event, payload);
  };

  emit('style', { style: trackStyle });

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
      answer = await askModel({ prompt, style: trackStyle, completeChat, seed, signal, onUsage });
    } catch (err) {
      if (signal?.aborted) throw err;
      emit('warn', { message: `Модель не ответила: ${err.message || err}` });
      break;
    }
    raw = answer.raw;
    if (!raw) {
      lastErrors = ['ответ модели не разобрался как JSON'];
      emit('warn', { message: 'Ответ модели не разобрался как JSON' });
      continue;
    }

    const check = checkSpec(raw);
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
            { role: 'system', content: specMessages(prompt, trackStyle)[0].content },
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
          responseFormat: {
            type: 'json_schema',
            json_schema: { name: 'track_spec_v2', strict: true, schema: jsonSchemaForSpec().schema },
          },
        });
        const fixedRaw = extractJson(fixed);
        if (fixedRaw) {
          const fixedCheck = checkSpec(fixedRaw);
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
    spec = check.ok ? check.spec : fallback;
    emit('fallback', { message: 'Модель не дала валидную спеку — собран запасной план из библиотеки' });
  }

  emit('spec', { spec, attempts: modelCalls, usedFallback, errors: lastErrors });

  // Компиляция — чистая детерминированная функция.
  const compiled = compile(spec);
  emit('compiled', {
    code: compiled.code,
    sections: compiled.sections,
    parts: compiled.parts,
    warnings: compiled.warnings,
    trace: compiled.trace,
  });

  return { spec, compiled, style: trackStyle, attempts: modelCalls, usedFallback, seed, raw };
}

export { SPEC_STYLES, SPEC_ROLES, SECTION_KINDS };
