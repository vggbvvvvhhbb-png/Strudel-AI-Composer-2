// Сборщик системного промпта «музыкально образованного» ассистента (D-138).
// Промпт версионируется (PROMPT_VERSION). Правила инструментария берутся
// из реальных источников: белый список звуков — из server/prompts/system.md
// (один источник, не дубль), пресеты — из каталога Timbre Palette,
// теория — из server/rag/harmony.js. Примеры — только из базы знаний.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARMONY_RULES } from './harmony.js';

const here = dirname(fileURLToPath(import.meta.url));
export const PROMPT_VERSION = 'mi-1.0.0';

/** Белый список сэмплов и синтезаторов из system.md (единственный источник). */
export function loadVoiceRules(promptsDir = resolve(here, '../prompts')) {
  const text = readFileSync(resolve(promptsDir, 'system.md'), 'utf8');
  const namesLine = text.match(/Рабочие имена: ([^\n]+)/);
  const samples = namesLine ? [...namesLine[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [];
  const synthLine = text.match(/\.s\(([^)]+)\)/);
  const synths = synthLine ? [...synthLine[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  if (samples.length === 0 || synths.length === 0) {
    throw new Error('system.md: не удалось извлечь белый список звуков — формат изменился');
  }
  return { samples, synths };
}

/** Компактный список реальных пресетов каталога для промпта. */
export function presetLines(catalog) {
  return Object.values(catalog.presets || {}).map(
    (p) => `- ${p.strudelAlias} (${p.id}, ${p.family}, роли: ${(p.roles || []).join('/')}, CC0)`,
  );
}

function theoryBlock() {
  const f = HARMONY_RULES.functions.major;
  const subs = HARMONY_RULES.substitutions.map((s) => s.name).join(', ');
  return [
    '## Музыкальная теория (обязательна к соблюдению)',
    `- Ступени в n("...").scale("тоника:лад") — индексы 0..6. Функции: T (тоника, ступени ${f.T.join(',')}), S (субдоминанта, ${f.S.join(',')}), D (доминанта, ${f.D.join(',')}).`,
    '- Движение гармонии: T→S/D, S→D/T, D→T (в т.ч. прерванный D→vi). Избегай V→ii.',
    '- Каденция фразы: аутентическая D→T, половинная S→D, плагальная S→T. Последняя нота мелодии тяготеет к тонике или терции текущего аккорда.',
    `- Допустимые замены: ${subs}. Хроматика вне лада допустима только осознанно (замена), с объяснением.`,
    '- Ноты мелодии и баса принадлежат заявленному ладу; ударные высоту не несут.',
    '- Пауза в mini-нотации — тильда ~, не точка. Буквенные ноты только в note("..."), в n("...") — числа ступеней.',
  ].join('\n');
}

function toolBlock(voice, catalog) {
  return [
    '## Инструментарий (только реальные имена)',
    `- Сэмплы ударных/текстур: ${voice.samples.join(', ')}. Имена вне списка молчат — не выдумывай.`,
    `- Синтезаторы: ${voice.synths.join(', ')}.`,
    '- Пресеты Timbre Palette (CC0, звук загружен приложением) — используй .s("alias"):',
    ...presetLines(catalog),
    '- Не пиши samples(...) и .bank(...) — загрузку делает приложение.',
    '- harmonic minor через scale() не работает в движке проекта: для этого лада пиши note("...") с явными высотами (например g#5).',
    '- Аккорды: chord("Am7").voicing() — без voicing() высот нет. Символы maj7 не поддерживаются, пиши M7 (FM7, CM7).',
  ].join('\n');
}

const FORMAT_BLOCK = [
  '## Формат ответа (строго)',
  'Сначала 1–3 предложения теоретического обоснования (почему это звучит: функции, каденция, краска).',
  'Затем ровно один блок кода Strudel:',
  '```strudel',
  'setCpm(BPM/4)',
  'const key = "тоника:лад"',
  '$PART: ...',
  '```',
  'Код — готовый к исполнению: партии $NAME: заглавными, 4–8 партий для трека, минимум 16 тактов сумме секций, если строишь трек. Никакого текста после блока.',
].join('\n');

/**
 * Системный промпт ассистента.
 * @param {{catalog: object, voice?: {samples: string[], synths: string[]}}} opts
 */
export function buildSystemPrompt({ catalog, voice = loadVoiceRules() }) {
  return [
    `Ты — музыкально образованный ассистент-композитор Strudel AI Composer (промпт ${PROMPT_VERSION}).`,
    'Ты не генератор случайных нот: каждое решение обосновано теорией и звучит в реальном движке.',
    '',
    theoryBlock(),
    '',
    toolBlock(voice, catalog),
    '',
    FORMAT_BLOCK,
  ].join('\n');
}

/** Блок найденных примеров (топ-3 из базы знаний) для подшивки в контекст. */
export function examplesBlock(results) {
  if (!results?.length) return '';
  const parts = ['## Проверенные примеры из базы знаний (следуй их качеству и стилю обоснования)'];
  for (const { entry } of results) {
    const t = entry.music_tags;
    parts.push(
      `### ${entry.title} [${t.genre.join('/')} · ${t.tonic} ${t.mode} · ${t.complexity}${t.bpm ? ` · ${t.bpm} BPM` : ''}]`,
      `Обоснование: ${entry.rationale}`,
      ...(entry.education ? [
        `Учебное направление: ${entry.education.direction}`,
        ...entry.education.rules.map((rule) => `- ${rule}`),
      ] : []),
      '```strudel',
      entry.strudel_code,
      '```',
    );
  }
  return parts.join('\n');
}

/**
 * Сообщения для LLM: система + контекст примеров + текущий код + запрос.
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMessages({ userRequest, currentCode = '', searchResults = [], catalog, voice }) {
  const system = buildSystemPrompt({ catalog, voice });
  const user = [
    examplesBlock(searchResults),
    currentCode ? `## Текущий код пользователя\n\`\`\`strudel\n${currentCode}\n\`\`\`` : '',
    `## Запрос\n${userRequest}`,
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}