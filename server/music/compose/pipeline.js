// План → validateTrackSpec/checkSpec → синхронная компиляция → оценка/refine.
import { TrackSpecSchema, validateTrackSpec } from '../../../src/schemas/track-spec.schema.js';
import { ROLES as SPEC_ROLES } from '../../../src/schemas/parts.js';
import { checkSpec } from '../spec/check.js';
import { formsForStyle, roleFor, selectPattern } from '../knowledge/index.js';
import { detectStyle } from '../references.js';
import { compileForProtocol } from './compiled.js';
import { compileTrackSpec } from '../compiler/index.js';

const SPEC_STYLES = TrackSpecSchema.shape.meta.shape.style.options;
const SECTION_KINDS = TrackSpecSchema.shape.structure.shape.sections.element.shape.name.options;

const STYLE_HINTS = [
  ['techno', ['techno', 'техно', 'industrial', 'рейв']],
  ['house', ['house', 'хаус', 'disco', 'диско']],
  ['synthwave', ['synthwave', 'синтвейв', 'retrowave']],
  ['trap', ['trap', 'трэп', 'drill', 'дрилл']],
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

function specMessages(prompt, style) {
  const system = [
    'Ты — композитор. Спланируй трек, не пиши JavaScript или Strudel-код.',
    'Верни строго один JSON-объект TrackSpec без текста вокруг.',
    `meta: {style, bpm, key, schemaVersion?}; style: ${SPEC_STYLES.join(', ')}; bpm 60..180.`,
    'key: заглавная нота A..G, необязательный #/b, затем строчные буквы лада; например Cmin, Am, F#minor. Двоеточие в key запрещено.',
    `structure: {sections: [{name, cycles, energy, harmony, parameters?}]}; name: ${SECTION_KINDS.join(', ')}.`,
    'cycles — целое число циклов >=1; energy 0..1; harmony — строка аккордов, например "Cm Fm Gm Cm".',
    'parameters?: {cutoff?: [число, число], gain?: [число, число]}.',
    `parts: {roles: {роль: {activeIn, pattern, sound, effects?}}}; роли: ${SPEC_ROLES.join(', ')}.`,
    'Имена секций могут повторяться; порядок и длительности задаёт structure.sections.',
    'activeIn — массив имён существующих секций; партия играет во всех секциях с указанным именем.',
    'pattern — mini-нотация, не код: ударные "bd*4", "~ sd ~ sd", "hh*8"; тональные партии — степени "0 ~ 2 4".',
    'sound — имя сэмпла или синтезатора: bd, sd, hh, sine, triangle, sawtooth, square, piano.',
    'effects?: [{name, params}]; поддерживаются room, delay, gain, lpf, hpf с одним числовым аргументом. Не придумывай методы.',
    'reasoning? — короткое объяснение плана.',
    'План: 2..12 секций, всего 16..96 циклов; энергия и набор активных ролей различаются; гармония развивается.',
    'Никаких верхнеуровневых harmony, form, motif, automation; никаких recipe/variant.',
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
async function askModel({ prompt, style, completeChat, seed, signal, onUsage }) {
  const text = await completeChat({
    messages: specMessages(prompt, style),
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
          responseFormat: { type: 'json_object' },
        });
        const fixedRaw = extractJson(fixed);
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

  emit('spec', { spec, attempts: modelCalls, usedFallback, errors: lastErrors });

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

  return { spec, compiled, style: trackStyle, attempts: modelCalls, usedFallback, seed, raw };
}

export { SPEC_STYLES, SPEC_ROLES, SECTION_KINDS };
