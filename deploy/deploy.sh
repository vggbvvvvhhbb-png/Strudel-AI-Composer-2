#!/usr/bin/env bash
# Деплой Strudel AI Composer на VM (директория /opt/strudel).
# Запускать из корня репозитория: bash deploy/deploy.sh
#
# Скрипт НЕ трогает конфиги nginx основного сайта и не останавливает его сервисы:
# новый server-блок ставится отдельным файлом, старый pm2-процесс не затрагивается.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/strudel}"
DOMAIN="${DOMAIN:-music.EXAMPLE.COM}"

echo "==> Сборка и тесты"
npm ci
npm test
npm run build

echo "==> Копирование в ${APP_DIR}"
sudo mkdir -p "${APP_DIR}"
# Исключаем .env: на сервере свой файл с ключами.
sudo rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '.env.example' \
  --exclude 'data/timbre/audio/originals' \
  ./ "${APP_DIR}/"

# .env на сервере создаётся один раз и дальше не перетирается деплоем.
if [ ! -f "${APP_DIR}/.env" ]; then
  echo "==> Создаю ${APP_DIR}/.env из шаблона — впишите ключи вручную"
  sudo cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  sudo chmod 600 "${APP_DIR}/.env"
fi

echo "==> Установка зависимостей на сервере"
cd "${APP_DIR}"
sudo npm ci --omit=dev
sudo npm run build

echo "==> Проверка, что секреты не попали в репозиторий"
if grep -rn "sk-\|gsk_" "${APP_DIR}" --exclude-dir=node_modules --exclude=.env; then
  echo "!!! Найдены похожие на ключи строки. Исправьте и повторите деплой." >&2
  exit 1
fi

echo "==> pm2"
if pm2 describe strudel >/dev/null 2>&1; then
  pm2 restart strudel --update-env
else
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save

echo "==> nginx (новый server-блок, конфиг основного сайта не меняется)"
sudo cp "${APP_DIR}/deploy/nginx-music.conf" /etc/nginx/sites-available/music.conf
sudo ln -sf /etc/nginx/sites-available/music.conf /etc/nginx/sites-enabled/music.conf
sudo nginx -t
sudo systemctl reload nginx

echo "==> Готово. Проверка:"
echo "    curl -s https://${DOMAIN}/api/health"
