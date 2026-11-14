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
  --exclude='./.scratch' \
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
# Compose-файл берём из репозитория: так сервис воркера анализа нельзя
# случайно потерять (в старой версии скрипта он был зашит здесь же).
ssh_cmd "cp ${APP_DIR}/deploy/docker-compose.strudel.yml ${COMPOSE_DIR}/docker-compose.strudel.yml"

# ---------------------------------------------------------------------------
# МЬЮТЕКС: разбор и деплой не могут идти одновременно.
#
# На сервере 2 ядра и 3.8 ГБ RAM. Demucs занимает ~1.75 ГБ, и сборка образа
# рядом с ним — это OOM (замер: rc=137). «Не гонять разбор и деплой вместе»
# было правилом в описании; здесь это МЕХАНИЗМ:
#
#   job.lock    — каталог-лок (mkdir атомарен). Его держит приложение, пока
#                 идёт разбор со стемами. Создаёт и обновляет его Node
#                 (server/deepdive/lock.js) — тот же протокол, что здесь.
#   heavy.lock  — flock(1). Его держит Python-воркер вокруг запуска Demucs
#                 (server/deepdive/analysis/ddworker/http.py).
#   running/    — маркеры «разбор идёт». Приложение создаёт файл на время
#                 задачи: видно даже те разборы, которые ещё не взяли лок.
#
# Порядок: сначала ждём завершения текущих разборов, потом берём локи, потом
# собираем. Так не возникает взаимоблокировки: разбор, который уже идёт,
# локов не ждёт, а новый — ждёт.
# ---------------------------------------------------------------------------
LOCK_DIR="${LOCK_DIR:-/opt/dd-lock}"
LOCK_WAIT_S="${LOCK_WAIT_S:-7200}"

echo "==> Мьютекс: ждём завершения текущих разборов"
ssh_cmd "mkdir -p ${LOCK_DIR}/running ${LOCK_DIR}"

# 1. Ждём, пока не останется живых маркеров разбора.
ssh_cmd "deadline=\$(( \$(date +%s) + ${LOCK_WAIT_S} )); while [ -n \"\$(ls -A ${LOCK_DIR}/running 2>/dev/null)\" ]; do if [ \$(date +%s) -ge \$deadline ]; then echo 'РАЗБОР ИДЁТ ДОЛЬШЕ ${LOCK_WAIT_S} С — ДЕПЛОЙ ОТМЕНЁН' >&2; exit 1; fi; echo '    ждём разбор: ' \$(ls -A ${LOCK_DIR}/running 2>/dev/null | tr '\n' ' '); sleep 10; done"

# 2. Забираем лок задачи: новые разборы не смогут дойти до разделения.
#    Heartbeat обновляем, пока идёт сборка, — иначе лок посчитают протухшим.
ssh_cmd "set -e; mkdir ${LOCK_DIR}/job.lock && echo \$\$ > ${LOCK_DIR}/job.lock/pid && date +%s > ${LOCK_DIR}/job.lock/heartbeat && echo '    job.lock взят'"

# 3+4. Сборка и перезапуск — ПОД flock тяжёлых операций: пока держим лок,
#     Demucs не запустится (а если запустился — дождётся конца сборки).
#     Heartbeat лока задачи обновляем на это время, иначе лок посчитают
#     протухшим и кто-то другой его снимет.
ssh_cmd "nohup bash -c 'for i in \$(seq 1 800); do date +%s > ${LOCK_DIR}/job.lock/heartbeat 2>/dev/null || exit 0; sleep 15; done' >/dev/null 2>&1 &"

echo "==> Сборка образов (под мьютексом)"
ssh_cmd "flock -w ${LOCK_WAIT_S} ${LOCK_DIR}/heavy.lock -c 'cd ${COMPOSE_DIR} && docker compose -f docker-compose.yml -f docker-compose.strudel.yml build --progress plain strudel deepdive-worker && docker compose -f docker-compose.yml -f docker-compose.strudel.yml up -d strudel deepdive-worker' || { echo 'СБОРКА НЕ УСПЕЛА: МЬЮТЕКС ТЯЖЁЛЫХ ОПЕРАЦИЙ ЗАНЯТ — ДЕПЛОЙ ОТМЕНЁН' >&2; exit 1; }"

# Локи отпускаем: сборка закончилась, разборы могут идти.
ssh_cmd "rm -rf ${LOCK_DIR}/job.lock" || true

echo "==> Caddy: сайт-блок для студии"
ssh_cmd "cp ${COMPOSE_DIR}/Caddyfile ${COMPOSE_DIR}/Caddyfile.bak-\$(date +%s)"
ssh_cmd "grep -q '${DOMAIN}' ${COMPOSE_DIR}/Caddyfile || cat >> ${COMPOSE_DIR}/Caddyfile <<'CADDY'

${DOMAIN} {
	# SSE-поток режима «Разбор»: без буферизации и без сжатия (разбор на CPU
	# идёт десятки минут — буферизация задерживает события потока).
	@deepdive path /api/deepdive/*
	handle @deepdive {
		reverse_proxy strudel:3001 {
			flush_interval -1
		}
	}

	handle {
		encode zstd gzip
		reverse_proxy strudel:3001
	}
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
# Режим «Разбор»: воркер анализа и рендерер. Если воркер недоступен — студия
# работает, но разбор честно сообщает, что сервис анализа недоступен.
ssh_cmd "docker ps --filter name=shveyka-deepdive --format '{{.Names}} {{.Status}}'" || true
ssh_cmd "docker exec \$(docker ps -qf 'name=shveyka-strudel-1') node -e \"fetch('http://127.0.0.1:3001/api/deepdive/health').then(r=>r.text()).then(t=>console.log('deepdive:',t)).catch(e=>console.log('deepdive: ошибка', e.message))\"" || true

echo "==> Готово: https://${DOMAIN}/"
