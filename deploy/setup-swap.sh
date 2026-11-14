#!/usr/bin/env bash
# Swap 4 ГБ — страховка от OOM на тяжёлых разборах.
#
# КОНТЕКСТ. На сервере 3.8 ГБ RAM, swap = 0. Demucs занимает ~1.75 ГБ RSS,
# и если рядом проснётся что-то тяжёлое — OOM-killer убивает разбор (rc=137
# в замере, где сборка образа шла одновременно). Swap не заменяет мьютекс:
# мьютекс не даёт тяжёлым задачам совпадать, swap не даёт им умереть.
#
# ПОРЯДОК. Мьютекс — основное средство, swap — страховка (D-091).
#
# ЗАПУСК:  bash deploy/setup-swap.sh          (на хосте, от root)
set -euo pipefail

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-4G}"

echo "==> Состояние ДО"
free -h
swapon --show || true
df -h / | tail -1

if swapon --show | grep -q "$SWAP_FILE"; then
  echo "==> Swap уже подключён — ничего не меняем"
else
  if [ ! -f "$SWAP_FILE" ]; then
    fallocate -l "$SWAP_SIZE" "$SWAP_FILE"
  fi
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE"
  swapon "$SWAP_FILE"
  if ! grep -q "^$SWAP_FILE " /etc/fstab; then
    echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
  fi
fi

# Небольшая склонность к подкачке: память используется первой, swap — страховка.
sysctl -w vm.swappiness=10 >/dev/null
if [ ! -f /etc/sysctl.d/99-swap.conf ]; then
  echo "vm.swappiness=10" > /etc/sysctl.d/99-swap.conf
fi

echo "==> Состояние ПОСЛЕ"
free -h
swapon --show
df -h / | tail -1
