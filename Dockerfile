# Образ приложения: сборка фронта + сервер на Node.
# Один запуск: docker compose up --build

FROM node:22-alpine AS build
WORKDIR /app

# Зависимости — отдельным слоем, чтобы пересобирались только при изменении lock-файла.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
# src/ нужен серверу: маршруты импортируют схемы и разбор кода из src/
# (src/schemas, src/core). Отдельного "серверного" пакета у проекта нет.
COPY src ./src
COPY scripts ./scripts

# Ключи — только через окружение (docker compose env_file), в образе их нет.
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
