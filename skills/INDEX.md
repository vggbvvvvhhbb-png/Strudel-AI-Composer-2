# INDEX — реестр скилов v1

| id | kind | версия | refs |
|---|---|---|---|
| composer-workflow | workflow | 1.0.0 | все |
| emotion-map | core | 1.0.1 | groove-templates, harmony-recipes, arrangement-arcs |
| groove-templates | groove | 1.0.0 | mix-roles |
| harmony-recipes | harmony | 1.0.0 | emotion-map |
| arrangement-arcs | arrangement | 1.0.0 | mix-roles |
| mix-roles | mix | 1.0.0 | — |
| genre-trip-hop | genre | 1.0.0 | emotion-map, groove-templates, harmony-recipes, arrangement-arcs, mix-roles |
| genre-synthpop | genre | 1.0.0 | те же |
| genre-ambient | genre | 1.0.0 | те же |
| genre-dnb | genre | 1.0.0 | те же |
| genre-lofi | genre | 1.0.0 | те же |

## Матрица активации (приёмочные промты → ожидаемые карты)

Правила разбора живут в картах, а не здесь: genre — по слову из запроса или по
V/A (`docs/SKILLS.md`), mood — по словарю emotion-map («последнее слово
доминирует»), groove и arc — из карты жанра. Матрица фиксирует ожидаемый
результат и служит регресс-тестом: `tests/unit/skills.test.js` сверяет её с
кодом и падает при расхождении.

| промт | genre | mood | groove | arc |
|---|---|---|---|---|
| «мрачный трип-хоп про дождь» | trip-hop | melancholy | drunken | slow-burn |
| «светлый синтипоп для вечеринки» | synthpop | joy | straight-16 | song-64 |
| «тревожный эмбиент, пустой космос» | ambient | void | none | bloom |
| «злой быстрый dnb» | dnb | anger | halftime | club-64 |
| «уютный лоуфай для учёбы» | lofi | nostalgia | swing-16 | song-64 |
| «нежная колыбельная» | ambient | tender | none | bloom |
| «эйфоричный фестиваль» | synthpop | euphoria | straight-16 | club-64 |
| «меланхолия осеннего города» | trip-hop | melancholy | drunken | slow-burn |
| «агрессивный фонк» | dnb | anger | halftime | club-64 |
| «ностальгическая кассета из 90-х» | lofi | nostalgia | swing-16 | song-64 |

## Smoke-приёмка учебника
1. Все EXAMPLES dry-parse + theory-lint 0 errors (CI).
2. Каждый жанровый скетч: offline-рендер 30 с, 0 клиппинга, бит-в-бит (два прогона).
3. 10 промтов выше → компилятор активирует ожидаемые карты (юнит-тест retrieval).
4. «сделай мрачнее» на любом скетче: лад→minor, регистр↓, плотность↓ или =,
   lpf↓ — проверяется по дельте ProjectModel, не на слух.
