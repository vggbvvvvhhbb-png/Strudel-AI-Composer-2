# LICENSES — реестр лицензий режима «Разбор» (Deep Dive)

*Обновлено 14.11.2026. Правило стека: по умолчанию допустимы только MIT / BSD / ISC / Apache-2.0 (в т.ч. LGPL-2.1 как библиотека). AGPL-3.0, GPL-3.0, CC BY-NC*, CC BY-ND и любые кастомные лицензии — только по явному решению владельца с письменным обоснованием.*

Реестр — основание для выбора стека, а не юридическое заключение. Каждая строка ссылается на первоисточник (LICENSE-файл в репозитории, страницу лицензирования, карточку модели на Hugging Face) и на дату проверки.

## Правило и легитимные статусы

Каждый компонент разбирается в **три слоя**, потому что они почти никогда не совпадают:

1. **Лицензия кода** — что именно мы берём из репозитория.
2. **Лицензия весов / моделей / данных** — отдельная лицензия на чекпойнты, датасеты и обучающие корпуса. Лицензия кода её **не** покрывает.
3. **Вердикт** для нашего стека.

| Статус | Значение |
|---|---|
| `разрешено по умолчанию` | MIT / BSD / ISC / Apache-2.0 (или LGPL-2.1 без изменения условий) — коммерческое использование, включая распространение, разрешено. Обязательно: сохранить текст лицензии и copyright-уведомление |
| `требует решения владельца` | Есть неопределённость, NC-ограничение, copyleft (GPL/AGPL), кастомная лицензия либо первоисточник не подтверждён. Без письменного решения владельца в стек не идёт |
| `не берём` | AGPL-код или NC-веса без полученного исключения. Отклонено окончательно |
| `≈` | Метка «не подтверждено первоисточником». Рядом всегда названо, какой именно риск и как его закрыть |

### Правило «лицензия кода ≠ лицензия весов»

Пример, ради которого этот документ и написан: у Demucs код — MIT, а веса — «только для научных целей» по прямому заявлению автора. Если смотреть только на `LICENSE` в репозитории, вывод будет неверным в ту сторону, которая дороже всего стоит.

Второй пример: у Spleeter код — MIT, а README прямо пишет *«The code of Spleeter is MIT-licensed»*, оставляя веса за скобками, хотя JOSS-статья утверждает MIT и на веса. Расхождение формулировок не разрешено мейнтейнером до сих пор.

---

## 1. Ядро разбора (MVP)

| Компонент | Версия | Лицензия кода | Лицензия весов / данных | Ссылка (первоисточник) | Проверено | Вердикт |
|---|---|---|---|---|---|---|
| **Demucs** (Meta, `facebookresearch/demucs`) — архив | v4; репозиторий заархивирован 01.01.2025 | **MIT** | **Не определена автором.** Веса не покрыты MIT: «The model weights are not covered by the MIT license, and are provided only for scientific purposes» (adefossez, issue #327, 23.05.2022). Обучены на MUSDB HQ + внутреннем наборе Meta (800 треков) | [LICENSE](https://github.com/facebookresearch/demucs/blob/main/LICENSE) · [issue #327](https://github.com/facebookresearch/demucs/issues/327#issuecomment-1134828611) | 14.11.2026 | код — `разрешено по умолчанию`; **веса — `требует решения владельца`** |
| **Demucs** (поддерживаемый форк `adefossez/demucs`) | v4.1.0 (11.07.2026) | **MIT** | **Та же неопределённость.** README форка: «The license of the weights is not clear: MusDB contains some data that were only usable for research purpose… The 6 source variant of htdemucs was trained only on Meta internal dataset, which likely means CC-NC-BY license is applicable» | [LICENSE](https://github.com/adefossez/demucs/blob/main/LICENSE) · [README §License](https://github.com/adefossez/demucs#license) | 14.11.2026 | код — `разрешено по умолчанию`; **веса — `требует решения владельца`** |
| **Где хостятся веса Demucs** | — | — | Классические: `dl.fbaipublicfiles.com/demucs/hybrid_transformer/` (`htdemucs` = `955717e8-8726e21a.th`; `htdemucs_ft` = 4 чекпойнта `f7e0c4bc…`, `d12395a8…`, `92cfc3b6…`, `04573f0d…`; `htdemucs_6s` = `5c90dfd2…`). С v4.1.0 (11.07.2026) форк публикует модели на Hugging Face — **точный ID репозитория на HF в этой сессии не подтверждён (≈)** | [release notes форка](https://github.com/adefossez/demucs) | 14.11.2026 | — (инфраструктура, а не лицензия) |
| **librosa** | 0.11.x | **ISC** | Примеры/датасеты в пакет не входят; библиотека их не распространяет | [LICENSE.md](https://github.com/librosa/librosa/blob/main/LICENSE.md) | 14.11.2026 | `разрешено по умолчанию` |
| **pyloudnorm** | 0.1.1 | **MIT** | — (модель — ITU-R BS.1770-4, спецификация, не лицензируемый артефакт) | [LICENSE](https://github.com/csteinmetz1/pyloudnorm/blob/master/LICENSE) | 14.11.2026 | `разрешено по умолчанию` |
| **Basic Pitch** (`spotify/basic-pitch`) | 0.4.x | **Apache-2.0** | Карточка HF — `apache-2.0`, ограничений на коммерческое использование в README нет. **Но:** обучение шло на MAESTRO (**CC BY-NC-SA 4.0**) и iKala (**CC BY-NC-SA 4.0**); в репозитории есть загрузчики этих корпусов. NC-происхождение обучающих данных ≈ делает статус весов неоднозначным | [LICENSE](https://github.com/spotify/basic-pitch/blob/main/LICENSE) · [карточка HF](https://huggingface.co/spotify/basic-pitch) · [MAESTRO](https://arxiv.org/abs/1810.12247) | 14.11.2026 | код — `разрешено по умолчанию`; **веса — `требует решения владельца`** |
| **ffmpeg** (через npm `ffmpeg-static` 5.2.0 → gyan.dev essentials 6.0) | 6.0 | **GPL-3.0, а не LGPL.** Собран с `--enable-gpl --enable-version3` и `--enable-libx264 --enable-libx265 --enable-libvmaf`. Именно эта сборка лежит в `node_modules/ffmpeg-static/ffmpeg.exe` | — (не модель; «веса» здесь — сам бинарь. §6 GPL требует поставлять исходники FFmpeg по commit `ea3d24bbe3`) | [LICENSE пакета (GPL-3.0)](https://github.com/eugeneware/ffmpeg-static/blob/master/LICENSE) · локально: `node_modules/ffmpeg-static/ffmpeg.exe.LICENSE` (GPL-3.0) и `ffmpeg.exe.README` («License: GPL v3», Source Code: `github.com/FFmpeg/FFmpeg/commit/ea3d24bbe3`) | 14.11.2026 | **`требует решения владельца`** |
| **NumPy** | 2.x | **BSD-3-Clause** | — | [LICENSE.txt](https://github.com/numpy/numpy/blob/main/LICENSE.txt) | 14.11.2026 | `разрешено по умолчанию` |
| **SciPy** | 1.x | **BSD-3-Clause** | — | [LICENSE.txt](https://github.com/scipy/scipy/blob/main/LICENSE.txt) | 14.11.2026 | `разрешено по умолчанию` |
| **SoundFile / libsndfile** | 0.13 / 1.2.x | **LGPL-2.1** | — | [COPYING](https://github.com/libsndfile/libsndfile/blob/master/COPYING) | 14.11.2026 | `разрешено по умолчанию` (динамическая линковка; не модифицировать и не статически линковать в закрытый бинарь) |
| **PyTorch / torchaudio** | 2.x | **BSD-3-Clause** | Официальные аудио-модели PyTorch — CC BY 4.0; сторонние веса — по своим лицензиям | [LICENSE PyTorch](https://github.com/pytorch/pytorch/blob/main/LICENSE) | 14.11.2026 | `разрешено по умолчанию` |
| **ONNX Runtime** | 1.x | **MIT** | — | [LICENSE](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) | 14.11.2026 | `разрешено по умолчанию` |

### Замечания к ядру

- **ffmpeg — самый дорогой пункт.** `ffmpeg-static` тянет **GPL-3.0** сборку, а не LGPL. Для серверного деплоя это нужно решать явно: либо перейти на LGPL-сборку (gyan.dev `lgpl` build или собственная сборка без `--enable-gpl`), либо оставить бинарь как **отдельный процесс** и выполнять §6 GPL (поставлять текст GPL-3.0 + исходники FFmpeg по commit `ea3d24bbe3`, на который указывает `ffmpeg.exe.README`). Отказ от `--enable-gpl` означает отказ от libx264/libx265/libvmaf — это отдельный продуктовый компромисс, а не только юридический.
- **Demucs — веса, а не код.** Даже если метаданные в сторонних репозиториях (например, конвертации в safetensors/ONNX) помечены как MIT, конвертация **не меняет** лицензию исходных весов.
- **Basic Pitch — NC в родословной.** Формально Spotify не накладывает NC-ограничений, но MAESTRO и iKala — NC. Это тот случай, где «Apache-2.0 на карточке» не равно «чисто».

---

## 2. Кандидаты и отклонённые

| Компонент | Лицензия кода | Лицензия весов / данных | Почему отклонён | Ссылка | Проверено | Вердикт |
|---|---|---|---|---|---|---|
| **Essentia** (MTG) | **AGPL-3.0** | Все модели MTG — **CC BY-NC-SA 4.0**; доступна коммерческая лицензия по запросу | AGPL на сетевом сервере обязывает публиковать исходники сервиса. Модели — NC. Коммерческая лицензия возможна, но это переговоры и деньги | [COPYING.txt](https://github.com/MTG/essentia/blob/master/COPYING.txt) · [models.html](https://essentia.upf.edu/models.html) | 14.11.2026 | `не берём` (без отдельно купленной коммерческой лицензии) |
| **madmom** (CPJKU) | **BSD** | Данные и модели — **CC BY-NC-SA 4.0** (сам LICENSE-файл разделяет слои: «Source code files…» / «Data and model files…») | Код чистый, но все модели NC | [LICENSE](https://github.com/CPJKU/madmom/blob/master/LICENSE) | 14.11.2026 | `не берём` |
| **ADTOF** (MZehren) | — (весь репозиторий) | **CC BY-NC-SA 4.0** | NC на чекпойнт `Frame_RNN`; на HF-конверсии то же самое | [LICENSE](https://github.com/MZehren/ADTOF/blob/master/LICENSE) | 14.11.2026 | `не берём` |
| **Spleeter** (Deezer) | **MIT** | **≈ MIT.** JOSS-статья: «Spleeter source code and pre-trained models are available on github and distributed under a MIT license». Но README пишет только *«The code of Spleeter is MIT-licensed»*, а мейнтейнер не ответил на вопросы о весах (issues #898, #957, #959). Модели обучены на внутреннем «Bean»-наборе Deezer (24 097 треков) | Расхождение формулировок не закрыто | [LICENSE](https://github.com/deezer/spleeter/blob/master/LICENSE) · [JOSS](https://doi.org/10.21105/joss.02154) | 14.11.2026 | `требует решения владельца` |
| **MUSDB18 / SiSEC18-MUS** | — | 7-секундные выдержки — **CC BY 4.0** (Zenodo 3270814); полный MUSDB18 — только исследовательский | Датасет для бенчмарка разделителей, а не материал для публикации. Как эталон — можно, как контент — нет | [Zenodo 3270814](https://zenodo.org/records/3270814) | 14.11.2026 | `не берём` |
| **Spotify Web API** | не применимо (SaaS) | audio-features / audio-analysis | С **27.11.2024** новые Web API-приложения не могут обращаться к Audio Features и Audio Analysis. Работают только приложения с extended mode, зарегистрированные ранее. Отдельный запрет: Spotify-контент нельзя использовать для обучения ML-моделей | [Introducing some changes to our Web API](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api/) | 14.11.2026 | `не берём` |
| **SAM Audio** (`facebookresearch/sam-audio`) | **SAM License** (кастомная Meta) | Чекпойнты — по запросу; ограничения §5.b.iv (нельзя использовать SAM Materials/выводы для обучения или улучшения ML-моделей) | Кастомная лицензия с ограничениями на обучение и на защиту патентов. Прямого разрешения на коммерческий сервис нет; нужен индивидуальный договор | [LICENSE](https://github.com/facebookresearch/sam-audio/blob/main/LICENSE) | 14.11.2026 | `требует решения владельца` |
| **Open-Unmix** (sigsep) | **MIT** | Чекпойнты обучены на MUSDB → ≈ исследовательские | Та же цепочка, что у Demucs: код MIT, веса — по MUSDB | [LICENSE](https://github.com/sigsep/open-unmix-pytorch/blob/master/LICENSE) | 14.11.2026 | `не берём` |
| **Beat This!** (`CPJKU/beat_this`) | **MIT** | **MIT (явно):** «The code and the published model weights are released under the MIT license» | Единственный кандидат, у которого веса и код лицензированы одинаково и явно. README добавляет: «some of the training files are fully copyrighted or under limited Creative Commons licenses, and it is up to the user to assess whether this may impact their use case» — это про обучающий корпус, не про веса | [LICENSE](https://github.com/CPJKU/beat_this/blob/main/LICENSE) · [README §License](https://github.com/CPJKU/beat_this#license) | 14.11.2026 | **`разрешено по умолчанию`** (код + веса) |
| **CLAP** (LAION-AI/CLAP, `laion/clap-htsat-fused`) | MIT / Apache-2.0 | `apache-2.0` на карточке HF, но обучение на LAION-Audio-630K — корпус со смешанными лицензиями, включая NC-конфиг | Данные не NC-чистые; коммерческая пригодность весов зависит от трактовки | [README карточки](https://huggingface.co/laion/clap-htsat-fused/blob/main/README.md) | 14.11.2026 | `требует решения владельца` (≈) |
| **All-In-One Music Structure Analyzer** | ≈ | ≈ | Первоисточник в этой сессии не найден и не подтверждён — ни репозиторий, ни карточка весов, ни версия лицензии | — | 14.11.2026 | `требует решения владельца` (≈, не подтверждено) |

**Итого по разделу 2:** `не берём` — Essentia, madmom, ADTOF, MUSDB18, Spotify Web API, Open-Unmix. `требует решения владельца` — Spleeter, SAM Audio, CLAP, All-In-One. `разрешено по умолчанию` — только Beat This!.

---

## 3. Сэмплы и звуковые банки

Этот блок — **блокер публикации**, а не техническая деталь. Студия уже тянет эти банки в проде: `scripts/sync-sample-banks.mjs` синхронизирует `github:tidalcycles/dirt-samples` (через `raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json`) и `shabda:piano` (через `shabda.ndre.gr/piano.json?strudel=1`).

| Ресурс | Что внутри | Лицензия | Ссылка | Проверено | Риск |
|---|---|---|---|---|---|
| `github:tidalcycles/dirt-samples` | `arpy`, `gretsch`, `bd`, `co`, `breaks125`, `amencutup` — одиночные удары, лупы и нарезки | **Не подтверждено.** LICENSE-файла в репозитории нет (GitHub API отдаёт `license: null`), README про лицензию не упоминает ничего | [tidalcycles/Dirt-Samples](https://github.com/tidalcycles/Dirt-Samples) · [README](https://github.com/tidalcycles/Dirt-Samples/blob/master/README.md) | 14.11.2026 | **Высокий.** Лицензии нет ни на уровне репозитория, ни на уровне папок. README прямо пишет: «There are duplicates among the files. We keep everything as it is to not break existing artwork» — то есть состав фиксирован, а происхождение не документировано. Папка `breaks125` — лупы, которые по своей природе часто нарезаны из чужих записей; их происхождение нигде не зафиксировано. **Без письменного разрешения от TidalCycles/авторов банк нельзя распространять** |
| `shabda:piano` (`shabda.ndre.gr`) | Короткие (< 5 с) семплы, собранные из **Freesound** по семантическому запросу | Лицензия **каждого семпла своя**, она наследуется от Freesound. Инструмент умеет фильтр `--licenses cc0 \| by \| by-nc` — то есть **NC-семплы попадают в тот же банк** | [shabda.ndre.gr](https://shabda.ndre.gr/) · [ilesinge/shabda](https://github.com/ilesinge/shabda) · [labs.freesound.org](https://labs.freesound.org/apps/2025/11/27/shabda.html) | 14.11.2026 | **Высокий.** `shabda:piano` без фильтра может отдать `by-nc` семплы. Фильтрация на стороне студии обязательна; каждый загруженный семпл должен хранить свою лицензию в манифесте |
| **Free Music Archive** | Треки с пер-тречной CC-лицензией (BY / BY-SA / BY-ND / BY-NC\* / CC0 / FMA-Limited) | «The page for each song or album… will indicate the type of license that applies». FMA не выдаёт лицензий сам: «FMA cannot license original work to you for commercial, private, or other use» | [License Guide](https://freemusicarchive.org/license_guide) · [Terms of Use](https://freemusicarchive.org/terms_of_use) | 14.11.2026 | **Средний.** NC- и ND-треки присутствуют и непригодны для коммерческой публикации. **Проверено на практике: URL-фильтр `?license=cc0` в поиске FMA не фильтрует** — трек, выданный как CC0, на своей странице оказался CC BY-NC-ND 4.0. Лицензию читать только с бейджа на странице трека |
| **ccMixter** | Ремиксы, а капеллы (pell), сэмплы, пеллы | Пер-тречная CC-лицензия. Внутренняя система тегов: `attribution` = CC BY, `non_commercial` = CC BY-NC, `attribution_sharealike` = CC BY-SA, `ccplus` = платная опция CC+ поверх CC. Плюс «CCPlus Licensing» — коммерческое использование по договору | [Terms](https://ccmixter.org/terms) · [API `query`](https://ccmixter.org/api/query) | 14.11.2026 | **Средний.** **Проверено: фильтр `licenses=cc0` в API ccMixter не надёжен** — в выдачу попал трек с лицензией CC BY-NC 3.0. Надёжный селектор — тег `attribution`; проверять лицензию по `https://ccmixter.org/api/query?f=atom&ids=<id>` (поле `<link rel="license">`) или по странице трека. Треки с тегом `ccplus` требуют отдельной проверки |
| **Musopen** | Классические записи и ноты | Лицензия **per recording**: Public Domain Mark 1.0 / CC0 — но есть и CC BY-NC-SA 3.0. Musopen не гарантирует: «Musopen does not warrant that all content is in the public domain. Users are responsible for determining the copyright status» | [Terms of Use](https://musopen.org/tos/) · [Music Dedicator Terms](https://musopen.org/page/dedicate/) · [FAQ](https://musopen.org/faq/) | 14.11.2026 | **Средний.** Лицензия меняется от записи к записи внутри одного и того же произведения — Public Domain композиции не означает Public Domain записи. Смотреть иконку лицензии у конкретной записи. Для наших трёх критериев (электроника / живая гитара / вокальный соул) источник не подходит |

### Общие подводные камни

- **Фильтры по лицензии в URL у FMA и ccMixter не работают.** Оба проверены на практике 14.11.2026 и оба выдали треки с неверной лицензией. Любая автоматическая загрузка золотого набора обязана читать бейдж/`<link rel="license">` на странице самого трека и падать (fail-closed), если лицензия не прочитана.
- **NC и ND — это не «сложно, но можно».** NC запрещает коммерческое использование, ND запрещает распространение модифицированного материала. Для режима «Разбор», который будет разбирать чужой трек и отдавать производные артефакты, ND-трек непригоден в принципе.
- **Атрибуция — не формальность.** CC BY требует указать название, автора, источник и лицензию (шаблон TASL). Для каждого трека золотого набора нужен отдельный манифест с этими четырьмя полями.

---

## 4. Контрастные CC-треки для золотого набора

Кандидаты под три критерия плана владельца. Лицензия каждого прочитана с первоисточника (`<link rel="license">` в Atom-выдаче ccMixter — это тот же блок лицензии, что на странице трека). Аудио не скачивалось.

| # | Название | Автор | Источник | Лицензия | Ссылка на страницу | URL аудио | Год | Длит. | Критерий |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Music Connects Us | DJ Yura | ccMixter | **CC BY 3.0** | https://ccmixter.org/files/Yura/67677 | https://ccmixter.org/content/Yura/Yura_-_Music_Connects_Us.mp3 | 2024 | 2:01 | (a) house / techno / electro, 125–130 bpm |
| 2 | Trancemutate | Rataxes feat. Snowflake | ccMixter | **CC BY 3.0** | https://ccmixter.org/files/Rataxes/65705 | https://ccmixter.org/content/Rataxes/Rataxes_-_Trancemutate.mp3 | 2022 | 8:17 | (a) deep house, 120–125 bpm, вокал + струнные |
| 3 | Slow Down Productions | Slow Down Productions | ccMixter | **CC BY 3.0** | https://ccmixter.org/files/slowdownproductions/18274 | https://ccmixter.org/content/slowdownproductions/slowdownproductions_-_Slow_Down_Productions.mp3 | 2008 | 1:52 | (b) теги `live` / `guitar` / `drums` / `vocals`; автор: «this music does not contain any samples» |
| 4 | The Same Light Shines | SackJo22 | ccMixter | **CC BY 3.0** | https://ccmixter.org/files/SackJo22/40534 | https://ccmixter.org/content/SackJo22/SackJo22_-_The_Same_Light_Shines.mp3 | 2012 | 6:18 | (c) female vocals / choir / acoustic guitar / bass, folk + soul. Есть раздельные стемы (акустика и бас, вокальные дорожки). ⚠ тег `ccplus` — платная альтернатива |
| 5 | Soul Searching | Jeris (VJ_Memes) | ccMixter | **CC BY 3.0** | https://ccmixter.org/files/VJ_Memes/62203 | https://ccmixter.org/content/VJ_Memes/VJ_Memes_-_Soul_Searching.mp3 | 2020 | 4:04 | (c) soul / male vocals / guitar / acoustic / rhodes, 80–85 bpm. Стемы: Rhodes, Horns, Bass |

**Запасные кандидаты** (та же проверка лицензии, та же таблица правил):

- *Tell Somebody* — Admiral Bob — CC BY 3.0 — https://ccmixter.org/files/admiralbob77/26995 — https://ccmixter.org/content/admiralbob77/admiralbob77_-_Tell_Somebody.mp3 — 2010 — 2:56 — acoustic + rhythm/lead guitar + male vocals, soul. ⚠ тег `ccplus`
- *Hope is a Dangerous Thing* — Admiral Bob — CC BY 3.0 — https://ccmixter.org/files/admiralbob77/57345 — https://ccmixter.org/content/admiralbob77/admiralbob77_-_Hope_is_a_Dangerous_Thing.mp3 — 2018 — 2:44 — soul / acoustic / piano / drums / bass, стемы инструментов. ⚠ тег `ccplus`
- *The path to glory* — MalreDeszik — CC BY 4.0 — https://ccmixter.org/files/MalreDeszik/71334 — https://ccmixter.org/content/MalreDeszik/MalreDeszik_-_The_path_to_glory.mp3 — 2026 — 4:10 — есть стемы Guitar.flac и Drums.flac. ⚠ вокал помечен `AI_generated` / `AI_assisted`

**Осторожно с `ccplus`.** Тег означает, что правообладатель открыл платную коммерческую лицензию (CC+) поверх базовой CC-лицензии. Сама базовая CC BY-3.0/4.0 даёт коммерческое использование с атрибуцией и **без** оплаты, поэтому для наших целей `ccplus`-треки годятся — но если владелец студии захочет когда-либо монетизировать золотой набор, CC+ может оказаться обязательным.

**Чего в таблице нет и почему.** Треки под критерием (b) «живая гитара + барабаны» в CC BY на ccMixter оказались редкостью: большинство ремиксов с живой гитарой помечены `non_commercial` (BY-NC 3.0/4.0). Например, *Jazz Backing Track* (JeffSpeed68, BY-NC 4.0 + `ccplus`), *Immortality (Long Tail Version)* (Ben Blohowiak, BY-NC 4.0), *You were a puppet master* (JeffSpeed68, BY-NC 4.0). Для критерия (c) ситуация та же — *Frozen Lace* и *Inner Light* (Wiseman) — BY-NC 4.0. Это не дефект поиска, а структурный факт: CC-архивы насыщены NC.

---

## 5. Открытые вопросы владельцу

Каждый пункт требует **письменного** решения; пока решения нет, соответствующий компонент не идёт в стек.

1. **Demucs-веса: коммерческий статус.** Это блокер ядра. Варианты: (a) не использовать `htdemucs`/`htdemucs_ft`/`htdemucs_6s` в публичном коммерческом деплое; (b) запросить письменное разрешение у Meta AI Research; (c) заменить модель на ту, у которой веса лицензированы явно и чисто. Формулировка автора «provided only for scientific purposes» не оставляет места для коммерческого использования без отдельного гранта. **Нужно решение + обоснование для реестра.**
2. **ffmpeg: GPL-3.0 вместо LGPL.** Нужен выбор: LGPL-сборка (цена — потеря libx264/libx265/libvmaf) или GPL-3.0 с исполнением §6 (поставка текста GPL-3.0 и исходников FFmpeg по commit `ea3d24bbe3`; ffmpeg запускается как отдельный процесс, а не линкуется в наш код — тогда копирайт на студию не распространяется). **Нужно решение.**
3. **Basic Pitch и NC-происхождение.** MAESTRO (CC BY-NC-SA 4.0) и iKala (CC BY-NC-SA 4.0) в обучающей смеси. Готовы ли мы принять риск, что веса «заражаются» NC-ограничением? Или берём только код и пишем собственную модель/используем другую?
4. **Банк `tidalcycles/dirt-samples` — лицензии нет вообще.** Что делаем: пишем запрос TidalCycles/авторам, заменяем банк своими CC0-сэмплами или исключаем его из публичного релиза? Отдельно — папка `breaks125`: подтверждённого происхождения нет.
5. **`shabda:piano` — фильтрация NC.** План: фильтровать по лицензии на стороне студии и хранить лицензию каждого семпла в манифесте. Подтвердить или запретить.
6. **Spleeter: MIT на веса по JOSS, но не подтверждён.** Готовы ли считать JOSS-статью достаточным основанием? Или считать веса ≈ неподтверждёнными и не брать?
7. **CLAP: LAION-Audio-630K со смешанными лицензиями.** Та же развилка, что в п. 3.
8. **Общий вопрос, меняющий почти всё: будет ли студия коммерческой?** Если режим «Разбор» публикуется как некоммерческий/исследовательческий проект, то NC-компоненты (madmom, ADTOF, модели Essentia, большинство ccMixter-треков) формально становятся допустимы, и список «не берём» сокращается радикально. Если планируется коммерческое использование — текущий реестр остаётся в силе. **Это решение нужно первым: от него зависит весь выбор стека.**
9. **Формат манифеста атрибуции.** Для каждого элемента золотого набора и каждого семпла: название, автор, источник, лицензия (TASL). Нужен формат и место хранения, а также место для пользовательского интерфейса «атрибуция/лицензия» в режиме «Разбор».
10. **All-In-One Music Structure Analyzer** — первоисточник не найден. Либо владелец даёт ссылку, либо компонент исключается.

---

## Приложение: как проверять лицензию трека надёжно

```bash
# ccMixter: лицензия из Atom-выдачи (тот же блок, что на странице трека)
curl -s 'https://ccmixter.org/api/query?f=atom&ids=67677' | grep -o '<link rel="license"[^>]*>'

# FMA: читать бейдж на странице трека, НЕ доверять параметру ?license=
curl -s 'https://freemusicarchive.org/music/<artist>/<track>/' | grep -o 'licenses/by[^"]*'

# GitHub: наличие LICENSE-файла и его тип
curl -s 'https://api.github.com/repos/<owner>/<repo>' | grep '"license"'
```

Правило: если лицензия не прочитана из первоисточника — компонент считается `≈ не подтверждено` и не попадает в стек. «Не нашёл запрета» ≠ «разрешено».

---

## Приложение: ассеты, которые мы сделали сами

| Ассет | Что это | Лицензия | Источник |
|---|---|---|---|
| `public/demo/preview.wav` | Демо обложки: 4,0 с, mono 24 кГц, −18,2 LUFS | **наша** — сгенерировано из нашего кода нашим движком | `demo/preview.js` → `npm run build:demo` (рендер в headless Chromium, тот же движок, что в студии) |

Демо собрано **только из чистых осцилляторов** (`s("sawtooth"/"square"/"sine"/"triangle")`), без сэмплов: ни один сторонний банк в него не попадает, поэтому файл не создаёт лицензионного риска и играет офлайн. Паспорт рендера (движок, sha256 кода, sample rate) лежит рядом в `public/demo/preview.json` и проверяется тестом `tests/unit/landing-demo.test.js`.
