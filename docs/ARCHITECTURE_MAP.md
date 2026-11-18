# ARCHITECTURE_MAP — Strudel AI Composer и точки интеграции режима «Разбор» (Deep Dive)

*Составлено 14.11.2026 в сессии «Producer's Deep Dive × Strudel AI Composer», этап A (рекогносцировка).
Источники: чтение кода + проверка рантайма (тесты, прод-сайт, SSH-доступ к серверу).
Метки: **✓** — проверено фактом (командой или чтением), **≈** — вывод из кода без прогона, **?** — неизвестно.*

---

## 0. Кратко: что уже есть и чего нет

Студия — зрелая система генерации кода: LLM → план → компилятор → Strudel-код → браузерный
рендер → метрики → цикл улучшения. **Цикл «план → код → предложенные правки → применить»
уже существует и работает** — Deep Dive обязан вливаться в него, а не строить параллельный UI.

Но «Разбор» требует трёх вещей, которых в проекте **нет вообще**:

1. **Работа с чужим аудиофайлом** — нет декодера, нет измерений BPM/тональности/секций по сигналу,
   нет разделения на стемы (в проекте нет даже одного `.py`-файла).
2. **Серверного аудио-рендера** — `server/music/strudel-runtime.mjs` даёт *события* паттернов,
   но не звук; `OfflineAudioContext` в Node отсутствует. Рендер звука есть только в браузере.
3. **Фоновой очереди задач** — весь сервер синхронный: один HTTP-запрос + SSE.

---

## 1. Фронтенд

### 1.1 Разметка — трёхколоночный grid, вкладок нет

`index.html:28` — `main.app-grid` → `aside.col-left` (`:30-106`), `section.col-center` (`:109-159`),
`aside.col-right` (`:162-168`).

Левая колонка — шесть `<section class="panel">`:

| Панель | id ключевых элементов | Строки |
|---|---|---|
| Генерация | `#prompt-input`, `#compose-mode` (structured/free), `#btn-run`, `#btn-compose`, `#btn-compose-mutate`, `#btn-compose-variants` | `:31-48` |
| Ход композиции | `#compose-trace`, `#compose-sections`, `#compose-variants` | `:50-56` |
| Улучшить трек | `#improve-input`, `#btn-improve` | `:58-62` |
| План композиции | `#btn-ir-plan`, `#ir-transforms`, `#ir-search`, `#ir-critique`, `#ir-panel` | `:64-77` |
| Музыкальный разбор | `#music-style`, `#btn-analyze`, `#music-score`, `#music-criteria`, `#music-issues`, `#btn-refine`, `#btn-variants` | `:79-92` |
| Пресеты и история | `#preset-list`, `#btn-export`, `#btn-import-input` (единственный file-input в проекте, `:100`) | `:94-105` |

Центр: `#status` (`:110`), `#compose-timeline` + SVG `#compose-energy` (`:112-127`), редактор
`#code-hl`/`#code-input` (`:131-132`), `#btn-play-code`/`#btn-share`/`#btn-clear` (`:136-138`),
`#strudel-container` (`:143`), **`#diff-panel`** с `#btn-diff-apply`/`#btn-diff-reject` (`:146-155`),
`#log` (`:158`).

Правая колонка: `#mixer` (`:165`). Транспорт — `footer.transport` (`:173-198`): `#btn-play`,
`#bpm-slider`/`#bpm-value`, `#key-select`, `#scale-select`, `#rec-bars`, `#btn-record`, `#rec-time`.
Точка входа — `src/main.js:208`.

> **Вывод для Deep Dive:** «Разбор» — это **панель/секция**, а не вкладка (вкладок в студии нет).
> Прецедент отдельной страницы есть: `tinder.html` подключается как вторая точка входа роллапа
> в `vite.config.js:18-25`.

### 1.2 Инициализация и «режимы»

`src/main.js:18-23` — порядок: `initEditor()` → `initUI({editor})` → `initEngine('#strudel-container')`
→ `initLive` → `initVoice`; далее мобильная шторка микшера, `initHistory`, загрузка трека по хэшу `#c=`.

`src/ui.js:148-220` — `initUI` собирает все панели. **Общий контракт панели: `{getCode, setCode, applyCode, log}`**.
`applyCode` = «положить в редактор → `runValidated` → исполнить». `runValidated` (`src/ui.js:60-80`) —
цикл до 3 попыток: `staticValidate` → `dryValidate` → `fixCode` (до 2 автофиксов).

**Реестра режимов и фичефлагов нет.** Переключатель «структурный/свободный» — это `<select id="compose-mode">`,
обработчик `src/compose.js:58-64`. Константа `MODES` в `src/compose.js:27-30` объявлена, но **не используется**.
Флаги есть только на сервере: `server/config.js` + `.env.example`, отдаются в `/api/health`
(`server/routes/health.js:18` → `features: {voice, music}`).

### 1.3 Цикл «план → код → правки» и SSE-протокол

`src/compose.js`: `runCompose` (`:75-103`) → `composeTrack({prompt, mode, onEvent})` → `applyCode(result.code)`.
Обработка SSE — `handleEvent` (`:205-253`). **Полный список событий** (истина — `server/routes/compose.js:122-227`,
`server/music/compose/pipeline.js:232-334`, `refine.js:109-133`):

| type | поля |
|---|---|
| `style` | `style:string` |
| `warn` | `message:string` |
| `fallback` | `message:string` |
| `spec` | `spec:TrackSpec`, `attempts:int`, `usedFallback:bool`, `errors:string[]` |
| `compiled` | `code:string`, `sections[]`, `parts[]` |
| `scored` | `score:{total,v1,v2,audio,issues[]}`, `spec`, `audioRejected:string\|null` |
| `refine-step` | `iteration:int`, `remark:{id,label,hint}`, `score:number`, `gain:number` |
| `refined` | `steps[]`, `before:number`, `after:number`, `improved:bool`, `spec` |
| `done` | `code:string`, `spec`, `score`, `sections[]`, `mode` |
| `error` | `message:string` |

Формат SSE: `data: {type, ...payload}\n\n` (`server/routes/compose.js:138-140`), заголовки
`text/event-stream` + `X-Accel-Buffering: no` (`:132-137`), отмена апстрима по `res.on('close')` (`:142-145`).

### 1.4 Панели разбора — разбирают НАШ код, а не чужой файл

- **`src/music-panel.js`** — «Музыкальный разбор». Ждёт `POST /api/music/analyze`
  (`server/routes/music.js:79-112`): `analysis:{bpm,key,detectedKey,outsideScale,parts[],metrics,errors[]}`,
  `score`, `audio:{total,findings[],report:{lufsI,truePeakDbtp,peakDbfs,crestDb,clipCount,bands,silence,repeatability,engineVersion,renderMode}}`,
  `profile`, `report`. **Рендер звука делается в браузере ДО запроса**: `hooks.renderAudio`
  (`music-panel.js:18,192-201`) = `renderTrackOffline({code, bars:[0,16]})` (`src/ui.js:188-191`).
- **`src/ir-panel.js`** — панель Composition IR. Ответ `POST /api/music/ir/plan` = `pack(ir)`
  (`server/routes/ir.js:32-56`): `{ok, ir, code, hash, spec, sections[], warnings[], skillsVersion, report}`.

### 1.5 «Улучшить» и diff

`src/improve.js`: `initImprove({getCode, apply})` (`:11-17`) → `runImprove` (`:19-49`) →
`generateCode({prompt, mode:'improve', currentCode})` → `pending={newCode}` → `renderDiff` (`:51-72`)
на `changedRegions`/`diffLines` из `src/core/code-model.js:129,146`; `#diff-panel` показывается (`:71`).
`applyDiff` (`:74-80`) → `hooks.apply` → запись в редактор + `runValidated` + исполнение.

### 1.6 Mixer / transport / editor — переиспользовать как есть

- **Микшер** `src/mixer.js`: `initMixer({getCode,setCode})` (`:108-111`), `syncMixer(code)` (`:114-134`) —
  каналы строятся из `parseParts(code)` (`src/core/code-model.js:21`): имя, чипы M (`:63-75`) и S (`:77-97`),
  фейдер 0..1 (`:37-56`), индикатор `.vu` (`:59-61`). Все правки **пишутся в текст кода** и применяются
  повторным `evaluateCode` с дебаундом 250 мс (`applyLive`, `:13-20`).
- **Транспорт** `src/transport.js`: `initTransport` (`:69-147`), `syncTransport(code)` (`:150-159`),
  `transportIsPlaying()` (`:161`). BPM 40–220, лады `SCALES` (`:11`). «● Rec» → `src/core/recorder.js`.
- **Редактор** `src/editor.js`: `initEditor()` → `{refresh, setActiveParts, setStreaming}`. **Ключевое:**
  переопределён сеттер `textarea.value` (`:87-97`) — внешнее присваивание перерисовывает подсветку
  **и** шлёт `input`, на который подписан `src/ui.js:224-230` (→ `syncMixer` + `syncTransport`).
  => Любая новая панель, пишущая в `#code-input`, автоматически синхронизируется с микшером и транспортом.

### 1.7 Storage / share

- `src/core/storage.js` — **только `localStorage`**: `strudel.presets.v1`, `strudel.history.v1`,
  `strudel.presets.seeded.v1` (подпись встроенных пресетов FNV-1a). Хранит `{code,bpm,key,mixer,tags}`.
- `src/core/share.js` — `makeShareLink(code)` → `LZString.compressToEncodedURIComponent` → `#c=<payload>`;
  лимит 8192 символов (`:8`); `codeFromHash()` (`:12-23`) распаковывает и **валидирует код** через
  `staticValidate`. **Ссылка несёт только код** — для ссылки на разбор нужен другой параметр хэша
  и серверный id (разбор в URL не влезает).

---

## 2. Бэкенд

### 2.1 `server/index.js`

Проверка провайдера при старте: без ключа и без `MOCK_LLM=1` — `process.exit(1)` (`:25-34`).
`trust proxy` (`:37`), `x-powered-by` выключен (`:38`).
**helmet + CSP** (`:42-77`): `default-src 'self'`; `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' blob: data:`;
`style-src 'self' 'unsafe-inline'`; **`media-src 'self' blob: https://raw.githubusercontent.com`**;
`connect-src 'self' blob: raw.githubusercontent.com, shabda.ndre.gr, *.githubusercontent.com`;
`permissionsPolicy {microphone:['(self)']}`.
**rate limit** `/api` — 20 запросов/мин на IP (`:80-89`).
`express.json({limit:'100kb'})` (`:91`) — **файл >100 KB через JSON не пройдёт, нужен multipart (multer уже есть)**.
Роутеры (`:93-103`), статика `dist` + SPA-fallback с 404 для `/api/*` (`:105-114`),
логгер без тел запросов (`:117-123`), обработчик 413/400/500 (`:126-130`), graceful shutdown (`:137-142`).

**Полный список маршрутов:**

| Метод | Путь | Файл:строка |
|---|---|---|
| POST | `/api/generate` (SSE `delta`/`done`/`error`) | `server/routes/generate.js:45-90` |
| POST | `/api/fix` | `server/routes/fix.js:14-32` |
| POST | `/api/transcribe` (multipart `audio`, multer memory, 10 МБ, allowlist mime) | `server/routes/transcribe.js:58-88` |
| POST | `/api/music/analyze` | `server/routes/music.js:133-145` |
| POST | `/api/music/refine` | `server/routes/music.js:148-222` |
| POST | `/api/music/variants` | `server/routes/music.js:225-281` |
| GET | `/api/music/styles` | `server/routes/music.js:284-288` |
| POST | `/api/music/compose` (SSE) | `server/routes/compose.js:123-227` |
| POST | `/api/music/compose/variants` | `server/routes/compose.js:237-292` |
| POST | `/api/music/compose/mutate` | `server/routes/compose.js:299-336` |
| POST | `/api/music/ir/plan` | `server/routes/ir.js:86-103` |
| POST | `/api/music/ir/transform` | `server/routes/ir.js:109-155` |
| POST | `/api/music/ir/search` | `server/routes/ir.js:161-189` |
| POST | `/api/music/ir/critique` | `server/routes/ir.js:195-217` |
| GET | `/api/skills`, `/api/skills/:id` | `server/routes/skills.js:39-67` |
| POST | `/api/skills/compile`, `/api/skills/plan`, `/api/skills/cache/clear` | `server/routes/skills.js:73-164` |
| GET | `/api/preference/queue`, `/api/preference/stats`, `/api/preference/pairs`, `/api/preference/export` | `server/routes/preference.js:94-194` |
| POST | `/api/preference` · DELETE `/api/preference` | `server/routes/preference.js:116-206` |
| GET | `/api/taste`, `/api/taste/active` · POST `/api/taste/train` | `server/routes/taste.js:30-167` |
| GET | `/api/health` | `server/routes/health.js:13-22` |
| GET | `/api/stats` | `server/routes/stats.js:8-10` |

### 2.2 Две разные схемы плана — не путать

**(A) TrackSpec v2** (Zod, `src/schemas/track-spec.schema.js:5-48`) — то, что просит у модели LLM-путь
`/api/music/compose` и что компилит `server/music/compiler/index.js`:

```
meta: { style, bpm 60..180, key, schemaVersion? }
structure.sections[]: { name, cycles:int≥1, energy:0..1, harmony:string, parameters?{cutoff?,gain?} }
parts.roles: Record<kick|snare|hats|perc|sub|bass|pad|chords|lead|arp|fx|texture,
                  { activeIn:string[], pattern:string(mini), sound:string, effects?[{name,params[]}] }>
reasoning?: string
```

**(B) Composition IR v1** (Zod, `src/ir/schema.js:152-161`) — верхний слой над спекой:
`v, seed, meta{title,bpm,meter,key{tonic,mode},mood{valence,arousal,label?,modifiers[]},genre?,style?}`,
`palette`, `motifs`, `sections[1..12]{id,kind,bars,energy,tension,harmony[],layers,enter?}`,
`groove{template,amount,swing?,bassRhythm?,offsetMs?}`, `mix{sidechain[],pan,orbit}`.
JSON-схема для structured output — `server/ir/schema-json.js:118-207`; версия `ir-json-1.0.0` (`:17`).

`server/ir/planner.js` — LLM-планировщик: `planWithLLM({prompt,seed,genre,bpm,maxCalls,...})` (`:130-269`);
**бюджет вызовов `DEFAULT_MAX_CALLS = 2`** (`:30`); ремонтный ретрай (`:170-250`); fallback на правила (`:253`);
кэш 200 записей (`:52-56`).

### 2.3 Компиляторы

- **`server/music/compiler/index.js`** — `compileTrackSpec(spec)` (`:85-119`): `setCpm(${bpm}/4)` (`:95`),
  `const key = "<root>:<major|minor>"` (`:96`), для каждой роли — свой `arrange([bars, CONST], …)`;
  неактивная роль → `[cycles, silence]` (`:103-111`). Выражения: `s("mini")` для ударных, `note(...)` при
  явных нотах, иначе `n("mini")` + `.add(n("<0 2 4>"))` + `.scale("key")` + `.transpose(N)` (`:8`) +
  `.s("sound")` (`:51-82`). Эффекты только из `EFFECTS = {room, delay, gain, lpf, hpf}` (`:6,41-49`).
- **`src/ir/compiler.js`** — IR → код: `drumsExpression` (`:208-231`), `bassExpression` (`:274-288`),
  `chordsExpression` (`:298-314`), `melodyExpression` (`:376-381`), `arpExpression` (`:394-401`).
  **Свинг считается в компиляторе**, не движком (`:15-16,215,497`).
- **Обратного пути «файл → спека/IR → код» не существует** — это и есть Transpiler Deep Dive.

### 2.4 LLM-роутер

`server/llm/router.js`: цепочка провайдеров `providerChain()` (`:21-71`); **таймаут `TIMEOUT_MS = 120_000`** (`:11`);
`streamChat` (`:207-237`) — async-генератор; `completeChat({messages,temperature,signal,providerId,maxTokens,onUsage,responseFormat})`
(`:251-312`) → `Promise<string>`; при отказе провайдера в `response_format` — повтор без него (`:299-304`).
**Лимита итераций в роутере нет** — бюджет живёт в вызывающем коде (`maxCalls=2` в `planner.js:30`,
`iterations` 1..3 в `server/routes/music.js:35`). `MOCK_LLM=1` → `server/llm/mock.js` — детерминированные ответы.

### 2.5 Реестр API Strudel — не выдумывать функции

`server/music/data/strudel-api.json` (версия 1.3.0, 1017 экспортов, 1172 patternMethods),
генерируется `npm run check:api`.

**Подтверждённые экспорты (выборка):** `set, add, arrange, n, note, s, stack, cat, slowcat, fast, slow, off,
every, sometimes, ply, rev, degrade, chunk, segment, euclid, struct, mask, keep, drop, cut, loop, press,
shape, distort, clip, gain, lpf, hpf, lp, hp, bp, room, delay, echo, ir, jux, pan, spread, vibrato, tremolo,
legato, chord, voicing, scale, transpose, octave, swing, env, adsr, attack, decay, sustain, release,
resonance, cutoff, filter, sound, noise, sine, saw, square, time, cps, cpm, getCps`.

**Важно:** `setcpm`/`setbpm`/`setCpm`/`setBpm` **в реестр не попали** (есть `cpm`, `cps`, `getCps`,
`setCpsFunc`), хотя оба компилятора используют `setCpm(...)` — то есть компиляторы полагаются на API
**вне** этого whitelist. `arrange` есть среди экспортов, но **не** среди patternMethods.

Файл **не подключён** к валидатору: `src/core/validator.js` использует собственный список `FORBIDDEN`
(`fetch, eval, document, window, import, localStorage, require` — `:6-14`). Реальный запрет — `staticValidate`
+ `dryValidate` (`src/core/validator.js`, `src/strudel-engine.js:398`).

### 2.6 Агентный контур (фаза A, 15.11.2026)

✓ Проверено фактом: `npm run gate:a` — 15/15, `docs/evidence/agent/gate-a.json`.

Отдельный слой поверх LLM-роутера: **цикл «план → инструмент → наблюдение →
ответ»**, а не «промпт → код». Отличается от существующего compose-пути тем, что
шаги выбирает модель (или эвристика), каждый шаг — настоящий вызов инструмента,
и всё это видно в панели по ходу дела.

| Файл | Что |
|---|---|
| `server/agent/loop.js` | Сам цикл: `runAgent()` — async-генератор событий `plan, tool_start, tool_end, text, usage, done, error` |
| `server/agent/tools.js` | Реестр из 9 инструментов: `web_search`, `web_fetch`, `library_search`, `deep_dive`, `compose_spec`, `compile`, `edit_ir`, `usage_report`, `render_local` (фаза B) |
| `server/agent/navigator.js` | Zod-схема плана + `heuristicPlan()` — запасной план, когда модель ответила мусором |
| `server/agent/modes.js` | 4 режима с бюджетами (шаги, вызовы, источники, токены). Режим выбирается **по цели** запроса (D-101) |
| `server/agent/guard.js` | Лимиты сессии; при превышении — честная ошибка, а не бесконечный цикл |
| `server/agent/cache.js` | `TtlLruCache` + `cacheKey` с версией каталога + `isCacheable` (не кэшировать при истории) |
| `server/agent/web.js` | Поиск/чтение страниц; статус сервисов по имени переменной (`EXA_API_KEY`); **SSRF-фильтр** |
| `server/agent/prompts.js` | Промты планировщика и ответчика; прошлые реплики разговора — часть контекста |
| `server/routes/agent.js` | `GET /api/agent/tools` (паспорт) и `POST /api/agent` (SSE) |
| `src/agent-panel.js` | Панель в правой колонке студии: план, карточки тулзов, ответ, «Взять код в редактор» |

**Свойства, которые нельзя потерять:**

* **Честная деградация.** Нет `EXA_API_KEY` → агент не падает: шаг помечен
  «не сработал» с причиной, агент отвечает по локальной библиотеке и говорит
  об этом вслух. Тест на деградацию обязателен.
* **Код не применяется молча.** Собранный код трека попадает в редактор
  только по кнопке «Взять код в редактор».
* **Расход виден и честен.** Событие `usage`: оценка помечена оценкой,
  неизвестная цена говорится словами («Цена не измерена»), а не нулём (D-102).
* **Режим — это лимит.** Инструмент вне режима в план не попадает
  (`allowed` в `loop.js`).

**Чего нет:** `freesound_search` (фаза E), `ab_eval` (нужен живой рецензент),
серверного хранения истории диалогов, полного прохода с интернетом (нет
ключа — E-015).

### 2.7 Локальный демон (фаза B, 15.11.2026)

✓ Проверено фактом: `npm run gate:b` — 10/12 (две строки — честные «нет
данных»), `docs/evidence/agent/gate-b.json`.

Тяжёлое считается на машине владельца: рендер, разделение на стемы, анализ
(D-097). Сервер остаётся витриной и оркестратором, LLM — в облаке.

| Файл | Что |
|---|---|
| `local/daemon.mjs` | HTTP-сервер демона: `/health`, `/tasks`, `/tasks/:id`, `/tasks/:id/stream` (SSE). Авторизация по токену, fail-closed |
| `local/queue.mjs` | DurableQueue: журнал `queue.jsonl` на диске; незавершённые задачи возвращаются в работу после перезапуска |
| `local/tasks.mjs` | Реестр задач: `render`, `analyze`, `separate`, `analyze_stems`. Рендер — через существующий `render-worker.mjs`, анализ — через Python-воркер |
| `local/client.mjs` | Клиент демона: `health`, `submit`, `status`, `streamTask`. Без побочных эффектов при импорте |
| `server/routes/local.js` | `/api/local/status`, `/api/local/tasks`, `/api/local/tasks/:id`, `/api/local/tasks/:id/stream` |

**Свойства, которые нельзя потерять:**

* **Демон не пишет свой рендер.** Он зовёт тот же `server/deepdive/render/render-worker.mjs`,
  что и сервер, — иначе «локальный» результат нельзя сравнивать с серверным.
* **Токен обязателен.** Без `LOCAL_DAEMON_TOKEN` демон не стартует; сравнение
  токена — постоянного времени.
* **Очередь переживает обрыв.** Принятая задача не теряется при `SIGKILL`
  демона: журнал на диске, при старте незавершённое возвращается в работу.
* **Честная деградация.** Нет Python-воркера → `/health` показывает
  `analysis.available = false` с причиной, а задача `separate` падает с
  понятным текстом. Демон не притворяется, что умеет разделение.
* **Рендер не побитово детерминирован для смеси** осциллятора и сэмпла:
  расхождение 1 LSB (3.05e-5), что в пределах допуска проекта (D-104, E-019).

---

## 3. Аудио-стек

| Модуль | Что делает | Строки |
|---|---|---|
| `src/audio/render/offline.js` | чистый оркестратор рендера, **не знает про Web Audio** (рендер-функция внедряется снаружи) | `:76`, `:83`, `:112`, `:170` |
| `src/audio/render/realm.js` | менеджер изолированного рендера: iframe-realm на прогон, очередь, таймауты (D-143) | — |
| `src/audio/render/seed.js` | mulberry32 с фиксированным зерном для детерминизма IR в realm (E-022) | — |
| `src/audio/engine/adapter.js` | реальный `OfflineAudioContext`; `new OfflineAudioContext(2, sr*seconds, sr)`; additive-хук `prepare` перед startRendering | `:173-229` |
| `src/audio/metrics-report.js` | `buildMetricsReport` (`:41`), `ACCEPTANCE` (`:19-26`), zod-схема (`:176`), `parseMetricsReport` (`:222`) | — |
| `src/audio/qa.js` | 13 кодов замечаний (`:16-30`), `runAudioQa` (`:53`), `acceptancePassed` (`:262`) | — |
| `src/audio/dsp/loudness.js` | **свой** LUFS по BS.1770-4 (не pyloudnorm) | `:11-14,28,93,105` |
| `src/audio/dsp/truepeak.js` | true peak 4× оверсемплинг, полифазный фильтр 49 отсчётов (как libebur128) | `:44,78,167` |
| `src/audio/dsp/bands.js` | 6 полос **по biquad-RMS, не FFT**: sub 20–60, low 60–150, lowMid 150–400, mid 400–1500, highMid 1500–4000, high 4000–16000 | `:8-15,17,64` |
| `src/core/wav.js` | кодировщик 16-bit PCM WAV (`encodeWav(channels, sampleRate)`) — чистый, тестируется в Node | `:2-30` |

**Чего нет в DSP:** FFT/STFT/спектрограммы, onset detection, beat tracking, хроматики, декодера
аудиофайлов. «Спектральный баланс» = 6 полос RMS. Онсеты/сетка/velocity существуют только как свойства
**собственных** Strudel-событий (`server/music/metrics/events.js:71-99`).

### 3.1 Доказанная детерминированность

`tests/spike/browser/out-offline.txt` — реальный headless-Chrome рендер:
bass LUFS-I −21.91, true peak −12.33 dBTP, `lufsDeltaDb=0.000 passed=true`, **`maxAbsDiff=0 rmsDiff=0`**;
2 прогона + метрики = 976 мс; arp 1650 мс; pad 902 мс; живой контекст `running → running`; ошибок движка 0.

`docs/SPIKE-AUDIO.md:212-221` — сверка DSP с `ffmpeg ebur128`: |ΔLUFS| ≤ 0.05, |ΔdBTP| ≤ 0.01 на 6 фикстурах.

**Важно (D-143, фикс E-020):** офлайн-рендер студии изолирован в свежем
iframe-realm на каждый прогон (`src/audio/render/realm.js` +
`src/render-realm.js`, точка входа `render-realm.html`). Исторически
рендер был **операцией с глобальным состоянием**: движок переключал
глобальный аудиоконтекст, а superdough 1.3.0 удерживал узлы эффектов
между контекстами (E-020) — быстрые последовательные рендеры падали.
Realm уничтожается после рендера, удержания умирают вместе с ним; живой
контекст студии рендер не трогает. Детерминизм IR реверберации обеспечен
зерном PRNG и ожиданием `convolver.buffer` (E-022). Вызовы рендера
по-прежнему сериализуются очередью менеджера. Legacy-путь
`adapter.renderCodeOffline` сохранён для зондов и всё ещё несёт E-020.

**Официальный `renderPatternAudio` непригоден** (`tests/spike/browser/out.txt:35,248`): возвращает `undefined`,
а WAV-блоб отдаёт через `<a download>` и **закрывает живой AudioContext**. Используется собственный рендер.

### 3.2 Чего нет принципиально

- **Пути «код → WAV-файл на диск» не существует** (`encodeWav` используется только рекордером браузера).
- **Серверного аудио-рендера нет**: `server/music/strudel-runtime.mjs` — «Звука здесь нет — нужны паттерны» (`:18`).
- `OfflineAudioContext` в Node отсутствует.
- **Аудио-фикстур в репозитории нет** (поиск `*.wav/*.mp3/*.ogg/*.flac` вне node_modules → пусто).

---

## 4. Тесты и гейты (регресс, который нельзя сломать)

Vitest: `pool:'forks'`, `execArgv:['--expose-gc']` (`vite.config.js:27-36`).
**Baseline на 14.11.2026: 49 файлов, 854 теста — все зелёные, 8.24 с.**

| Гейт | npm | Что проверяет |
|---|---|---|
| `scripts/check-secrets.js` | `check:secrets` | ключи `sk-`/`gsk_` в git-индексе, `.env` не коммитится |
| `scripts/check-presets.mjs` | `check:presets` | пресеты парсятся **настоящим** mini-парсером `@strudel/web` |
| `scripts/check-knowledge.mjs` | `check:knowledge` | библиотека знаний цела (10 стилей, прогрессии, формы, роли, переходы) |
| `scripts/check-skills.mjs` | `check:skills` | скил-карты: frontmatter, id, refs, COMPACT ≤400 токенов, dry-parse, версионный замок |
| `scripts/check-baseline.mjs` | `check:baseline` | заморозка корпуса Baseline-0: sha256 манифеста, 60 промтов, рендеры |
| `scripts/build-queue-prompts.mjs --check` | `check:prompts` | пул промтов очереди == корпус по хэшу |
| `scripts/check-taste.mjs` | `check:taste` | механика выученной цели; **модель не допускается, пока нет 60 живых пар** |
| `scripts/lint-syntax.mjs` | `lint` | `node --check` по src,server,scripts,tests,eval |
| `scripts/bundle-budget.mjs` | `bundle:budget` | **жёсткие бюджеты**: 1200 KB JS, 120 KB CSS, 900 KB chunk, 400 KB gzip |
| `scripts/validate-loudness.mjs` / `validate-master.mjs` | `validate:*` | сверка DSP с ffmpeg/libebur128 (в CI не гоняются) |
| `scripts/extract-strudel-api.mjs` | `check:api` | пересборка whitelist Strudel API (в CI не гоняется) |

CI (`.github/workflows/ci.yml`): jobs `lint`, `test`, `checks` (secrets, presets, knowledge, skills,
baseline, prompts, taste), `build` + `bundle:budget`, `docker` (`MOCK_LLM=1` + `/api/health`), `smoke`
(Playwright `tests/smoke/smoke.mjs`). Node 22, ubuntu-latest.
Pre-commit hook `.githooks/pre-commit` → только `check-secrets.js`.

---

## 5. Деплой и железо (проверено фактами)

### 5.1 Прод-стенд ✓

| адрес | код | что |
|---|---|---|
| `https://music.34.88.114.146.sslip.io/` | 200 | студия (HTML 441 мс, ассеты 47-136 мс) |
| `https://music.34.88.114.146.sslip.io/api/health` | 200 | `{"ok":true,"version":"0.2.0","features":{"voice":false,"music":true},"providers":["openai"]}` |

`features.voice=false` — нет `GROQ_API_KEY` (кнопка микрофона скрыта по дизайну).

### 5.2 Железо сервера ✓ (SSH `root@34.88.114.146`, ключ `$HOME/.ssh/shveyka_deploy`)

| величина | значение | вывод |
|---|---|---|
| OS | Ubuntu 24.04.5 LTS | — |
| CPU | **2 vCPU** (Intel Xeon @ 2.20GHz, 1 ядро × 2 потока) | Demucs CPU будет медленным |
| RAM | **3.8 ГБ всего, ~2.7 ГБ доступно, swap 0** | риск OOM при разделении |
| Диск | 38 ГБ, **8.0 ГБ свободно (79% занято)** | веса моделей + chromium сюда влезут, но впритык |
| GPU | **нет** (`nvidia-smi` не найден) | правило «GPU по требованию» из плана владельца не закрыто |
| Python | 3.12.3 (подходит под требование Basic Pitch ≥3.11 ✓) | — |
| ffmpeg | **отсутствовал** → установлен в этой сессии | нужен для нормализации и true peak |
| Сеть | pypi 200 (0.4 с), huggingface 200 | веса моделей качать можно |
| Контейнеры | `shveyka-strudel-1` (healthy), `admin-bot`, `bot`, `web`, `caddy` | соседей не трогаем |

`/opt` занят 527 МБ. Лимитов cgroup у контейнера `strudel` нет (`Memory: 0`, `NanoCpus: 0`).

### 5.3 Железо машины разработчика ✓

| величина | значение |
|---|---|
| CPU | AMD Ryzen 5 5500, 12 потоков |
| RAM | 15.9 ГБ |
| GPU | **NVIDIA GeForce RTX 2060, 8 ГБ VRAM (2.2 ГБ занято)**, драйвер 572.60, CUDA 12.8 |
| Python | 3.14.4 (numpy/scipy/librosa/torch — **не установлены**) |
| Docker | CLI 29.9.2 есть, **демон не запущен** |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` — браузерный спайк воспроизводим |
| ffmpeg | `node_modules/ffmpeg-static/ffmpeg.exe` 6.0 (81 МБ), фильтр `ebur128` есть |
| Диск | C: 2.4 ГБ свободно (!), F: 86.9 ГБ, D: 98.4 ГБ |

### 5.4 Деплой

- `Dockerfile` — multi-stage `node:22-alpine`; runtime `npm ci --omit=dev` (`:20`) ⇒
  **devDependencies (ffmpeg-static, playwright-core, esbuild) в прод-образ НЕ попадают**;
  копируются `dist`, `server`, **`src`**, `scripts`, **`skills`** (`:22-30`). Python, ffmpeg, браузера, моделей — нет.
- `deploy/deploy-server.sh:21-25` — `APP_DIR=/opt/strudel`, `COMPOSE_DIR=/opt/shveyka`,
  `DOMAIN=music.34.88.114.146.sslip.io`, `SSH_KEY=$HOME/.ssh/shveyka_deploy`, `SSH_HOST=root@34.88.114.146`.
  Ключевое: `up -d strudel` поднимает **только свой** сервис; блок Caddy добавляется идемпотентно,
  `caddy validate` + откат по `.bak` (`:76-100`).
- `deploy/docker-compose.strudel.yml` — порт наружу не публикуется, только `reverse_proxy strudel:3001`.
- `deploy/ecosystem.config.cjs` — pm2, `max_memory_restart:'300M'`.
- **GPU/CUDA упоминаний в коде и деплое нет.**
- `docs/BRIEF.md:71` — «тяжёлые новые сервисы (headless-рендер) — отдельный контейнер с жёсткими лимитами
  CPU/RAM, не влияющий на швейку»; `:73` — `renderFingerprint` в каждом отчёте, допуск между платформами
  `maxAbsDiff ≤ 1e-4`, `|ΔLUFS| ≤ 0.05`; `:92-94` — реестр нерешённых: A2 (headless Chromium против браузера),
  A3 (`OfflineAudioContext` в Web Worker), **A4 (хватает ли ресурсов VM под рендер-контейнер рядом со швейкой)**.
- `docs/HANDOFF.md:201` — «Рендер-контейнер — разрешить ли поднимать рядом со „швейкой“ (A4)» — открытый вопрос владельцу.

**A4 закрыт фактами в этой сессии:** ресурсов VM **хватает с ограничениями** — 2 vCPU / 3.8 ГБ RAM / 8 ГБ диска.
Рендер-контейнер возможен, но: без GPU, с лимитом RAM (headless Chromium ≈ 300–500 МБ),
сегментация Demucs обязательна (иначе OOM), и режим «ночью/по кнопке».

---

## 6. ТОЧКИ ИНТЕГРАЦИИ — куда встраивается «Разбор»

### Фронтенд
1. `index.html` — новая `<section class="panel">` в `aside.col-left` (после `:92`, рядом с «Музыкальный разбор»)
   либо отдельная страница `dive.html` + точка входа в `vite.config.js:18-25` (прецедент `tinder.html`).
   **Все новые id — с префиксом `dive-`**, существующие id не переиспользовать.
2. `src/main.js:18-23` — инициализация нового модуля **после** `initEngine` (движок нужен для офлайн-рендера).
3. `src/ui.js:148-220` — регистрация панели по образцу `initMusicPanel` (`:176-192`);
   хуки `{getCode, setCode, applyCode, log, renderAudio}`. **`runValidated` (`:60-80`) не трогать** — он общий.
4. `src/api/client.js` — новые функции в стиле существующих (`composeTrack` `:118-158` — SSE; `analyzeMusic` `:66-74` — JSON).
5. `src/compose.js` / `src/music-panel.js` / `src/ir-panel.js` — **не трогать**: у них жёсткая привязка к id.
   Новый режим — отдельный модуль с тем же контрактом.
6. `src/core/share.js` — ссылка на разбор: новая схема хэша (`#c=` занят кодом), скорее всего серверный id.
7. `src/core/storage.js` — пресет/история только для кода; разбор (JSON с метриками) — отдельный ключ.
8. `src/mixer.js` / `src/transport.js` / `src/editor.js` — **переиспользовать как есть** (см. §1.6).
9. `src/styles/` — новый CSS; **учесть бюджет бандла** (`bundle:budget.mjs`: 120 KB CSS, 1200 KB JS).

### Бэкенд
10. `server/index.js:93-103` — `app.use(deepDiveRoute)`. **Учесть:** rate limit `/api` = 20/мин (`:80-89`),
    `express.json` limit 100 KB (`:91`) ⇒ файлы только через multipart/multer (прецедент `server/routes/transcribe.js:22-33`),
    CSP `media-src`/`connect-src` (`:59-68`) — для своих же стемов хватит `blob:`/`self`.
11. `server/config.js:18-54` — новые флаги (лимит файла, включение режима, путь к воркеру) + `.env.example`.
12. `server/routes/deepdive.js` — в стиле `server/routes/ir.js` (Zod-схема тела, `pack()`-подобный ответ);
    SSE — копия механики `server/routes/compose.js:132-145`.
13. `server/llm/router.js` — `completeChat` переиспользовать **без изменений**; лимит итераций — в маршруте
    (как `iterations` в `server/routes/music.js:35`).
14. `server/music/compiler/index.js` + `src/ir/compiler.js` — новый **Transpiler** (дескрипторы → спека/IR → код)
    в этом же стиле; **каждую функцию Strudel проверять по `server/music/data/strudel-api.json`** и
    пересобирать реестр через `npm run check:api` после добавления новых вызовов.
15. `src/audio/metrics-report.js:176-220` — zod-схема `MetricsReport` — форма отчёта рендера;
    `parseMetricsReport` (`:222`) — точка приёмки отчёта.
16. **Отдельный воркер-сервис** (Python) — пайплайн анализа/разделения. Требования: отдельный процесс/контейнер,
    лимиты CPU/RAM, без сети наружу, API `/internal/...` с токеном (`docs/BRIEF.md:295`).

### Регресс, который нельзя сломать
`npm test` (854) · `npm run lint` · `check:secrets|presets|knowledge|skills|baseline|prompts|taste` ·
`npm run build && npm run bundle:budget` · Docker-сборка + `/api/health` · Playwright smoke.

---

## 7. ЧЕГО НЕТ — сводка для планирования

**Есть (переиспользовать):**
- офлайн-рендер кода → метрики в браузере (детерминизм доказан, `maxAbsDiff=0`);
- свой DSP: LUFS/true peak/peak/crest/6 полос/тишина — **применим к любому декодированному файлу**;
- форма отчёта `MetricsReport` + `ACCEPTANCE` + машинно-читаемые замечания QA;
- исполнение Strudel в Node (`strudel-runtime.mjs`) → события паттернов;
- два компилятора (`spec→code`, `IR→code`), LLM-цикл улучшения (`refineSpec`, `refineMusic`, ≤3 итерации, откат);
- реестр метрик (`src/metrics/registry.js`, 43 метрики);
- приём файла через multer (`server/routes/transcribe.js:22-33`) — прецедент;
- кодировщик WAV (`src/core/wav.js`);
- SSE с этапами, микшер, транспорт, редактор, diff-панель — готовые точки интеграции.

**Отсутствует:**
- **Python-пайплайна нет вообще** (ни одного `.py`, ни numpy/scipy/librosa/torch);
- **разделения на стемы нет**; «стемы» в проекте — это партии Strudel;
- **анализа аудиофайла нет**: ни декодера, ни BPM/тональности/секций по сигналу, ни онсетов по аудио;
- **серверного аудио-рендера нет** (`OfflineAudioContext` только в браузере);
- **записи WAV на диск нет**;
- **очереди задач/фоновых job-ов нет** — всё синхронно в HTTP+SSE;
- **транспайлера «чужой трек → Strudel-код» нет**;
- **сравнения «оригинал vs мой рендер» нет**;
- **ссылки на разбор и сохранения разбора нет**;
- `renderFingerprint` в `MetricsReport` отсутствует (`docs/BRIEF.md:73` требует).

---

## 8. Связанные документы

`docs/DECISIONS.md` (журнал решений, D-001…D-071) · `docs/AUDIT.md` · `docs/HANDOFF.md` ·
`docs/BRIEF.md` · `docs/SPIKE-AUDIO.md` · `docs/AUDIO-QA.md` · `docs/MUSIC-ANALYSIS.md` ·
`docs/IR.md` · `docs/METRICS.md` · `docs/METRICS-V2.md` · `docs/COMPOSE.md` ·
`docs/DECISIONS.md` · `F:\ГЕНЕРАЦИЯ ФОТОК\producers-deep-dive-v2.md` (план владельца v2).

## 9. Музыкальный интеллект — RAG-база знаний (сессия 18.11.2026, D-134…D-141)

Новый контур `server/rag/` — «музыкальное образование» ассистента.
Не трогает существующие compose/агент/тиндер; счётчики вкуса и
DPO-экспорт изолированы (инвариант D-132).

| Модуль | Роль |
|---|---|
| `server/rag/schema.js` | Zod-схема записи знания (D-135): tonic+mode раздельно, роли из канона 12, bpm null≠0, chromatic-флаг, сверка пресетов с каталогом через zones |
| `server/rag/harmony.js` | Правила гармонии: функции T/S/D по ладам, граф переходов, каденции, замены (тритоновая/backdoor/вторичная доминанта), MODE_INTERVALS, самопроверка |
| `server/rag/music-check.js` | Нормализация тоники, питч-классы, принадлежность нот ладу по событиям queryArc |
| `server/rag/dataset/entries.json` + `dataset.js` | Золотой датасет 35 записей (D-136), загрузчик с fail-closed валидацией |
| `server/rag/search-core.js` | Ядро гибридного поиска: стадии exact→tonic→genre-roles→all, косинус/лексика, детерминированный тай-брейк |
| `server/rag/store-local.js` / `store-supabase.js` | Интерфейс KnowledgeStore: память (тесты/офлайн) и Supabase/pgvector (RPC match_knowledge, `<=>`, HNSW, RLS без политик) |
| `server/rag/migrations/001_knowledge.sql` | pgvector 0.8.2, vector(768), GIN по тегам, RPC; журнал `_rag_migrations` |
| `server/rag/embeddings.js` | Ollama nomic-embed-text 768, префиксы search_document/search_query, честная деградация |
| `server/rag/db.js` | Postgres-подключение (pooler eu-west-1), креды только env |
| `server/rag/prompt.js` | Версионированный промпт mi-1.0.0 (D-138): теория + инструментарий (белый список из system.md, пресеты из каталога) + формат ответа |
| `server/rag/parse-response.js` | Парсер: обоснование + блок кода, устойчив к вариациям |
| `server/rag/code-validator.js` | 5 классов ошибок: syntax/runtime/empty-part/scale (с тактом)/unknown-sound (D-139) |
| `server/rag/loop.js` | Петля self-correction до 3 попыток, структурный фидбек, честный отказ |
| `server/rag/explain.js` | Детерминированное объяснение кода: прогрессии, функции, каденции, советы замен (D-140) |
| `server/routes/rag.js` | /api/rag/{status,assist,explain}; feature 'rag-assist' в учёте цены |
| `src/rag-assist.js` + панель в studio.html | UI: шаги отдельно от обоснования, применение кода по кнопке |
| `scripts/rag-{migrate,upload,search-probe,eval}.mjs`, `scripts/probe-rag-ui.mjs` | Миграции, идемпотентная загрузка, зонды, оценка качества |

Тесты: `tests/unit/rag-*.test.js` (schema/harmony/music-check/dataset/
search-core/stores/embeddings/prompt/validator-loop/explain/route).
Зонды: `docs/evidence/rag/`. Решения: D-134…D-141, эксперимент E-021.
