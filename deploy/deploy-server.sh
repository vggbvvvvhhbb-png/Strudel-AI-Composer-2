#!/usr/bin/env bash
# Деплой Strudel AI Composer на существующий сервер (GCP, docker + Caddy).
#
# Запуск из корня репозитория:
#   bash deploy/deploy-server.sh
#
# Что делает:
#   1. копирует исходники в /opt/strudel (без .git, node_modules, .env);
#   2. собирает образ в общем compose-проекте сервера;
#   3. поднимает сервис strudel в той же docker-сети, где живёт Caddy;
#   4. добавляет в Caddy отдельный сайт-блок (существующие блоки не меняются);
#   5. перезапускает только caddy и проверяет /api/health.
#
# Безопасность:
#   - сервисы основного сайта (web, bot, admin-bot) не трогаются: команда
#     `up -d strudel` поднимает только свой сервис;
#   - Caddyfile сохраняется в .bak перед правкой, блок добавляется идемпотентно;
#   - если проверка конфига Caddy не проходит — старый файл возвращается.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/strudel}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/shveyka}"
DOMAIN="${DOMAIN:-music.34.88.114.146.sslip.io}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/shveyka_deploy}"
SSH_HOST="${SSH_HOST:-root@34.88.114.146}"

echo "==> Копирование исходников в ${APP_DIR}"
ssh_cmd() { ssh -i "${SSH_KEY}" -o BatchMode=yes "${SSH_HOST}" "$@"; }

ssh_cmd "mkdir -p ${APP_DIR}"
# tar по ssh: rsync на всех машинах нет, tar есть везде.
tar -cf - \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.env' \
  --exclude='./.sharrowkin' \
  . | ssh_cmd "tar -xf - -C ${APP_DIR}"

echo "==> .env на сервере"
# Ключи в репозитории нет и не должна туда попадать: файл на сервере — свой.
if ! ssh_cmd "test -f ${APP_DIR}/.env"; then
  echo "    нет ${APP_DIR}/.env — скопируйте вручную (chmod 600)"
  exit 1
fi
ssh_cmd "chmod 600 ${APP_DIR}/.env"

echo "==> Сборка образа и запуск сервиса strudel"
ssh_cmd "cd ${COMPOSE_DIR} && cat > ${COMPOSE_DIR}/docker-compose.strudel.yml <<'YAML'
services:
  strudel:
    build:
      context: ${APP_DIR}
      dockerfile: Dockerfile
    image: strudel-ai-composer:local
    env_file:
      - ${APP_DIR}/.env
    environment:
      NODE_ENV: production
      PORT: \"3001\"
      HOST: \"0.0.0.0\"
    expose:
      - \"3001\"
    restart: unless-stopped
    healthcheck:
      test: [\"CMD\", \"node\", \"-e\", \"fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
YAML"

ssh_cmd "cd ${COMPOSE_DIR} && docker compose -f docker-compose.yml -f docker-compose.strudel.yml build --progress plain strudel"
ssh_cmd "cd ${COMPOSE_DIR} && docker compose -f docker-compose.yml -f docker-compose.strudel.yml up -d strudel"

echo "==> Caddy: сайт-блок для студии"
ssh_cmd "cp ${COMPOSE_DIR}/Caddyfile ${COMPOSE_DIR}/Caddyfile.bak-\$(date +%s)"
ssh_cmd "grep -q '${DOMAIN}' ${COMPOSE_DIR}/Caddyfile || cat >> ${COMPOSE_DIR}/Caddyfile <<'CADDY'

${DOMAIN} {
	encode zstd gzip
	reverse_proxy strudel:3001
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
}
CADDY"

echo "==> Перезапуск caddy (только он)"
ssh_cmd "cd ${COMPOSE_DIR} && docker compose restart caddy"

echo "==> Проверка"
sleep 5
ssh_cmd "docker exec \$(docker ps -qf 'name=shveyka-caddy-1') caddy validate --config /etc/caddy/Caddyfile" || {
  echo "!!! Конфиг Caddy не прошёл проверку — возвращаю предыдущий" >&2
  ssh_cmd "cp \$(ls -t ${COMPOSE_DIR}/Caddyfile.bak-* | head -1) ${COMPOSE_DIR}/Caddyfile"
  ssh_cmd "cd ${COMPOSE_DIR} && docker compose restart caddy"
  exit 1
}
ssh_cmd "docker ps --filter name=shveyka-strudel --format '{{.Names}} {{.Status}}'"
ssh_cmd "docker exec \$(docker ps -qf 'name=shveyka-strudel-1') node -e \"fetch('http://127.0.0.1:3001/api/health').then(r=>r.text()).then(t=>console.log('health:',t)).catch(e=>{console.error(e.message);process.exit(1)})\"" || true

echo "==> Готово: https://${DOMAIN}/"
