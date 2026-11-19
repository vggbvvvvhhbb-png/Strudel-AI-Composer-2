# Образ приложения: сборка фронта + сервер на Node.
# Один запуск: docker compose up --build

FROM node:22-alpine AS build
WORKDIR /app

# Зависимости — отдельным слоем, чтобы пересобирались только при изменении lock-файла.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
# Бандл офлайн-рендера: режим «Разбор» рендерит Strudel-код в WAV через
# headless Chromium. В рантайме esbuild нет, поэтому бандл собирается здесь.
RUN npm run build:render

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Chromium нужен офлайн-рендеру, ffmpeg — конвертации загруженного трека в WAV.
RUN apk add --no-cache chromium ffmpeg

COPY --from=build /app/dist ./dist
COPY server ./server
COPY --from=build /app/server/deepdive/render/dist ./server/deepdive/render/dist
# src/ нужен серверу: маршруты импортируют схемы и разбор кода из src/
# (src/schemas, src/core). Отдельного "серверного" пакета у проекта нет.
COPY src ./src
COPY scripts ./scripts
# skills/ — скил-карты: сервер читает их при запуске (учебник для LLM,
# версия пака в отчёте). Без каталога /api/skills и планировщик падают.
COPY skills ./skills
# local/ — клиент локального демона: server/routes/local.js импортирует
# local/client.mjs на старте. Без этого каталога сервер не поднимается
# (ERR_MODULE_NOT_FOUND, контейнер уходит в рестарт).
COPY local ./local
# lib/ — общий слой доступа к браузеру: server/deepdive/render/render-worker.mjs
# импортирует lib/browser.mjs (путь к Chrome и уборка профилей Playwright).
# Без этого каталога сервер не поднимается (ERR_MODULE_NOT_FOUND).
COPY lib ./lib
# data/timbre/audio/ — аудио каталога Timbre Palette (D-128, D-130). Без него
# пресеты в рантайме есть, а звука нет: /api/timbre/presets отдаёт каталог,
# но same-origin раздача сэмплов (server/routes/samples.js) ищет файлы в
# <root>/data/timbre/audio/<alias>/<file>. OGG-пресеты (41 файл, 6.2 МБ,
# CC0-1.0) лежат в git — иначе CI, собирающий образ из чистого checkout,
# падал бы на этой строке с "COPY failed: no such file or directory".
# Исходный банк (data/timbre/audio/originals, WAV 74.7 МБ) — импортный слой,
# в рантайме не нужен и исключён из контекста сборки (.dockerignore).
COPY data/timbre/audio ./data/timbre/audio

# Ключи — только через окружение (docker compose env_file), в образе их нет.
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
