#!/usr/bin/env bash
# Правка Caddyfile на существующей установке: SSE-поток режима «Разбор»
# без буферизации и без сжатия.
#
# ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. deploy/deploy-server.sh дописывает сайт-блок только
# если домена ещё нет в Caddyfile. На уже развёрнутом сервере блок есть, и
# обновления не будет — поэтому блок правится этим скриптом.
#
# ПОЧЕМУ ОТДЕЛЬНЫЙ ОБРАБОТЧИК. Разбор на CPU идёт десятки минут (замер:
# 240 с аудио → 1356 с разделения). Буферизация прокси задерживает события
# потока, а сжатие добавляет задержку первого байта. flush_interval -1 —
# «сразу, как пришло».
#
# ЗАПУСК:  bash deploy/patch-caddy-sse.sh [путь к Caddyfile]
set -euo pipefail

CADDYFILE="${1:-/opt/shveyka/Caddyfile}"
MARKER='music.34.88.114.146.sslip.io'

if grep -q "flush_interval -1" "$CADDYFILE"; then
  echo "==> SSE-обработчик уже настроен — ничего не меняем"
else
  cp "$CADDYFILE" "$CADDYFILE.bak-sse-$(date +%s)"
  python3 - "$CADDYFILE" "$MARKER" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
marker = sys.argv[2]
text = path.read_text(encoding="utf-8")
idx = text.index(marker)
head = text[:idx]
block = (
    marker + " {\n"
    "\t# SSE-поток режима «Разбор»: без буферизации и без сжатия.\n"
    "\t# Разбор на CPU идёт десятки минут — буферизация задерживает события.\n"
    "\t@deepdive path /api/deepdive/*\n"
    "\thandle @deepdive {\n"
    "\t\treverse_proxy strudel:3001 {\n"
    "\t\t\tflush_interval -1\n"
    "\t\t}\n"
    "\t}\n"
    "\n"
    "\thandle {\n"
    "\t\tencode zstd gzip\n"
    "\t\treverse_proxy strudel:3001\n"
    "\t}\n"
    "\theader {\n"
    "\t\tX-Content-Type-Options nosniff\n"
    "\t\tReferrer-Policy strict-origin-when-cross-origin\n"
    "\t}\n"
    "}\n"
)
path.write_text(head + block, encoding="utf-8")
print("Caddyfile patched")
PY
fi

docker exec shveyka-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker restart shveyka-caddy-1 >/dev/null
sleep 3
curl -s -o /dev/null -w "health:%{http_code}\n" https://music.34.88.114.146.sslip.io/api/health
