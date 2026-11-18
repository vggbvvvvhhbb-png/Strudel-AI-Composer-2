# Локальный демон — тяжёлое считается на машине владельца

*Фаза B гайда «ПРОРЫВ» (D-097): LLM остаётся облачным, а рендер, разделение на
стемы и анализ считаются локально.*

## Что это

Демон — отдельный процесс Node на машине владельца. Он берёт тяжёлые задачи
(рендер, разделение на стемы, анализ) и возвращает результат с метриками и
паспортом рендера (`renderFingerprint`).

Ключевое свойство: демон **не пишет свой рендер и свой анализ**. Он вызывает
те же модули, что и сервер:

* рендер — `server/deepdive/render/render-worker.mjs` (headless Chromium, тот
  же движок Strudel, тот же DSP);
* анализ и разделение — `server/deepdive/analysis/client.js` (Python-воркер с
  Demucs).

Поэтому «локальный» результат сравним с серверным, а не «похож на него».

## Запуск

```bash
# 1. Токен. Без него демон не стартует: открытый в сеть рендерер — дыра.
export LOCAL_DAEMON_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 2. Демон (по умолчанию 127.0.0.1:3213).
node local/daemon.mjs

# 3. Проверить, что он живой.
curl -H "Authorization: Bearer $LOCAL_DAEMON_TOKEN" http://127.0.0.1:3213/health
```

Переменные окружения:

| Переменная | По умолчанию | Что значит |
|---|---|---|
| `LOCAL_DAEMON_TOKEN` | — | **обязателен**: без него демон не стартует |
| `LOCAL_DAEMON_PORT` | `3213` | порт демона |
| `LOCAL_DAEMON_HOST` | `127.0.0.1` | адрес (по умолчанию только локально) |
| `LOCAL_DAEMON_STATE` | `local/.state` | каталог журнала очереди |
| `DD_WORKER_URL` | `http://127.0.0.1:8010` | адрес Python-воркера анализа |

## Связь с сервером

Сервер узнаёт о демоне из своих переменных:

```bash
export LOCAL_DAEMON_URL=http://127.0.0.1:3213
export LOCAL_DAEMON_TOKEN=<тот же токен>
```

И тогда:

* `GET /api/local/status` — демон настроен, что умеет, что в очереди;
* `POST /api/local/tasks` — поставить задачу;
* `GET /api/local/tasks/:id` — статус;
* `GET /api/local/tasks/:id/stream` — прогресс в SSE.

Если демон не настроен, сервер отвечает честно: «демон не настроен» (503), а
не «задача ушла».

## Офлайн-режим

Демон работает без сервера: фронт может ходить в `http://127.0.0.1:3213`
напрямую. Сервер нужен только для витрины и облачного LLM.

## Очередь не теряется

Журнал очереди — `local/.state/queue.jsonl`. Каждая принятая задача и каждый
её финал — строка журнала. Если демон выключился или связь пропала, при
следующем старте незавершённые задачи возвращаются в работу:

```
[local] после перезапуска возвращено задач: 1
```

## Python-воркер (разделение на стемы)

Разделение требует `numpy`, `torch` и `demucs`.

### Windows (машина владельца): окружение на F:

На диске C: закончилось место, поэтому Python-окружение живёт **на F:**:

* окружение: `F:\strudel-env` (Python 3.12.16);
* базовый интерпретатор: `F:\uv-python\cpython-3.12.16-windows-x86_64-none`
  (`pyvenv.cfg` и лаунчеры `Scripts\python.exe` указывают на F:, не на C:);
* проверено 18.11.2026: torch 2.5.1+cu121, `torch.cuda.is_available() = True`,
  GPU: NVIDIA GeForce RTX 2060 SUPER, demucs 4.1.0 импортируется;
* замер сепарации (htdemucs, 60 с аудио): cold 12.3 с, warm 7.9 с
  (nvidia-smi: 94% GPU во время прогона); first-twin = сепарация + рендер
  16 тактов ≈ 10 с при лимите 420 с. Evidence:
  `docs/evidence/agent/separation-gpu.json`.

Запуск воркера (PowerShell):

```powershell
# 1. Активировать окружение (или вызывать python по полному пути — см. ниже).
F:\strudel-env\Scripts\Activate.ps1

# 2. Воркер анализа (порт из DD_PORT, по умолчанию 8010).
python server\deepdive\analysis\worker.py
```

Без активации — то же самое полным путём:

```powershell
F:\strudel-env\Scripts\python.exe server\deepdive\analysis\worker.py
```

Перед запуском демона указать адрес воркера:

```powershell
$env:DD_WORKER_URL = "http://127.0.0.1:8010"
$env:LOCAL_DAEMON_TOKEN = "<токен>"
node local/daemon.mjs
```

`PYTHONPATH` не нужен: демон общается с воркером по HTTP (`DD_WORKER_URL`),
а воркер запускается интерпретатором окружения, где пакеты уже установлены.

Если нужно доустановить пакеты — кэш pip держать на F: (C: заполнен):

```powershell
$env:PIP_CACHE_DIR = "F:\pip-cache"
F:\strudel-env\Scripts\python.exe -m pip install <пакет>
```

### Прочие платформы

```bash
pip install numpy soundfile librosa
pip install demucs            # потянет torch (CUDA-колёса ~2.5 ГБ)
python server/deepdive/analysis/worker.py     # порт из DD_PORT, по умолчанию 8010
```

Пока воркер не запущен, `/health` демона честно показывает
`analysis.available = false` с причиной, а задача `separate` падает с
понятным текстом. Демон не притворяется, что умеет разделение.

## Замеры

```bash
npm run gate:b     # гейт фазы B: тайминги, сверка с сервером, устойчивость очереди
```

Отчёт: `docs/evidence/agent/gate-b.json`.
