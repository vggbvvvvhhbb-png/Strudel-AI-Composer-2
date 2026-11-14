# SKILLS — композиторский мозг: формат, компиляция, CI, эволюция

Скил-карта = версионированный рецепт + измеренная история. LLM не «знает музыку»,
LLM получает скомпилированный учебник под конкретный запрос.

## Формат файла
skills/<id>.md = YAML frontmatter + тело. Обязательные секции тела:
- `## COMPACT` — дистиллят ≤ 400 токенов. ТОЛЬКО он попадает в системный промт.
- `## RECIPE` — полные правила/таблицы (RAG-тело, в промт не целиком).
- `## EXAMPLES` — играбельные Strudel-скетчи (```js```), проходят dry-parse в CI.
- `## DO / DON'T`
- `## MEASURE` — какие метрики/lint-ожидания проверяют карту.
- `## EVOLVE` — что можно мутировать эволюции, что заморожено.

## Frontmatter (Zod — server/skills/schema.js)
```js
const SkillFront = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  kind: z.enum(['workflow','core','groove','harmony','arrangement','mix','genre']),
  tags: z.array(z.string()).min(1),
  refs: z.array(z.string()).default([]),          // id других карт
  paramRanges: z.record(z.tuple([z.number(), z.number()])).default({}),
  compact: z.boolean().default(true),
  scoreHistory: z.array(z.object({
    date: z.string(), metric: z.string(),
    before: z.number(), after: z.number(), n: z.number(),
    method: z.enum(['ab','metric','spike']),
  })).default([]),
});
```

## Компилятор промта (server/skills/compile.js)
Всегда: composer-workflow.COMPACT + emotion-map.COMPACT + mix-roles.COMPACT.
Выборка (детерминированная, tie-break по id — повторяемость важнее «творчества»):
1. genre: явное слово в промте → иначе вывод по V/A (A<−0.5→ambient; A<0→lofi;
   A>0.3→synthpop; else trip-hop) → genre.COMPACT.
2. groove: шаблон из genre-карты (поле groove) → соответствующий блок groove-templates.
3. harmony: прогрессия по настроению (emotion-map.harmonyRef) → блок harmony-recipes.
4. arc: из genre-карты (поле arc) → блок arrangement-arcs.
5. Палитра: top-8 паспортов сэмплов по ролям genre-карты (sample-passports.json).
Бюджет: ≤ 3200 токенов на учебник. Переполнение → резать EXAMPLES, не COMPACT.
`skillsVersion = sha256(все frontmatter+COMPACT)` → в паспорт MetricsReport,
в preference JSONL, в кэш-ключ LLM (prompt, skillsVersion, seed).

## CI check:skills
- frontmatter валиден (Zod), id уникальны, refs существуют;
- COMPACT ≤ 400 токенов; в теле есть все обязательные секции;
- каждый ```js``` из EXAMPLES проходит dry-parse существующим адаптером
  (код → паттерн БЕЗ звука) + theory-lint v1 (0 errors);
- guardrails paramRanges: bpm 40..200; groove |offset| ≤ 20 мс; lufsTarget −24..−8;
  delayfeedback < 1; gain ≤ 1.2; duckdepth ≤ 1;
- изменение тела без bump version → fail;
- scoreHistory: только с method и n (никаких «стало лучше» без метода).

## Эволюция скилов (OPRO-lite, спринт 4)
Объектив: combineScores + audioReport − штраф за lint-errors (+ Elo, когда есть A/B).
Операторы мутации: jitter числовых диапазонов ±10% (в guardrails); замена примера
из корпуса победителей; добавление DON'T из частых lint-замечаний; сужение/расширение
плотности. ЗАМОРОЖЕНО: лицензионные правила, delayfeedback<1, клиппинг-политика,
true-peak потолок, формат frontmatter. Траектория (skillsVersion, score, n) пишется
в scoreHistory победившей карты. Бюджет прогона: ≤ 200 рендеров, лимит LLM-затрат.

## Верификация синтаксиса (на момент написания)
late/early — циклы; swingBy(x,n)/swing(n); duckorbit/duckdepth/duckattack;
chord/voicing/dict/anchor/mode/rootNotes; scale/n/scaleTranspose; setcpm(BPM/4);
delaytime — секунды; room/size(0..10); ADSR — секунды; lpenv/lpd — фильтр-огибающая;
один delay/reverb на orbit (разные роли → разные orbit!); LFO sampled per event →
seg(16) для непрерывных автоматизаций. Источники: strudel.cc/learn/{time-modifiers,
effects,tonal,samples}, strudel.cc/learn/faq. При bump версии движка — перепроверить.
