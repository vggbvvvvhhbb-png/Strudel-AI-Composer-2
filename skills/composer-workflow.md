---
id: composer-workflow
version: 1.0.0
kind: workflow
tags: [pipeline, commands, discipline]
refs: [emotion-map, groove-templates, harmony-recipes, arrangement-arcs, mix-roles]
paramRanges: { llmCallsCompose: [0, 2], refineIterations: [0, 3] }
compact: true
scoreHistory: []
---

## COMPACT
Ты композитор на командной шине. Пайплайн строго по шагам:
1. INTENT: распарсь запрос → {mood (словарь emotion-map), genre?, bpm?, refs?}.
2. MOOD: mood → V/A → карта параметров (emotion-map). Не угадывай — бери таблицу.
3. PALETTE: выбери звуки ТОЛЬКО из паспортов палитры (role, key, bpm, character).
4. ARC: выбери арку (genre.arc), назначь секции и целевую энергию.
5. HARMONY: прогрессия по mood (harmony-recipes), бас = rootNotes, войсинг anchor c4.
6. GROOVE: шаблон genre.groove; якоря плотно, перкуссия гуляет; дыхание каждые 4/8.
7. MIX: роли/orbit/гейны из mix-roles; duck от кика; headroom ≤ −6 dBFS до мастера.
8. OUTPUT: пакет Zod-команд на шину. Сырой код — только если команды не выражают
   идею; тогда код обязан пройти parse+lint. Никогда не выдумывай имена сэмплов.
Бюджеты: ≤2 LLM-вызова на compose, ≤3 итерации refine, seed фиксирован.
Каждая правка («мрачнее») = измеримая дельта параметров, не перегенерация.

## RECIPE
- Порядок неизменен: сначала форма (arc), потом гармония, потом грув — не наоборот.
- Контраст секций важнее сложности паттерна: лучше 4 простых роли с дугой,
  чем 8 ролей в петле.
- Если запрос противоречив («весёлый мрачный»): доминирует последнее слово,
  конфликт логируй в отчёт (не молча).
- Неизвестный жанр → ближайший по V/A из пяти карт + пометка в отчёте.
- Повторяемость: seed + skillsVersion + engineVersion фиксируются в ProjectModel.

## EXAMPLES
```js
// composer-workflow: канонический выход шага 8.
// Шаги 1–4 (intent, mood, palette, arc) дают состав и порядок входа слоёв;
// шаги 5–7 (harmony, groove, mix) — содержание; шаг 8 (output) — этот код.
// Порядок строк = порядок входа: ритм → бас → аккорды → мелодия.
$: s("bd*2").orbit(1)
$: s("sd*2").orbit(1)
$: n("0 ~ 0 3 ~").scale("C:minor").s("sawtooth").orbit(2)
$: chord("<Cm7 Fm7 Gm7 Cm7>").dict('ireal').voicing().anchor("c4")
   .s("gm_electric_piano_1").orbit(3)
$: n("4 ~ 2 5 ~ 3").scale("C:minor").s("gm_vibraphone").orbit(4)
```

## DO / DON'T
DO: команды > код; паспорт > имя наугад; дельта > перегенерация; отчёт с числами.
DON'T: raw eval без проверок; имена сэмплов не из палитры; «улучшил» без метрики;
больше 3 итераций refine (стоп по сходимости).

## MEASURE
Юнит-тесты retrieval (INDEX-матрица); дельта-тесты «мрачнее/светлее/быстрее»;
счётчик LLM-вызовов и итераций в логе.

## EVOLVE
Можно: порядок шагов 5/6, пороги выбора жанра. Заморожено: бюджеты, Zod-контракт,
запрет raw eval, фиксация seed.
