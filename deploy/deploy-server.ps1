# Деплой студии на боевой сервер (PowerShell-версия).
#
# Замена bash-версии deploy/deploy-server.sh для машин без bash/WSL.
# Шаги те же и в том же порядке:
#   1. архив исходников → scp → распаковка в /opt/strudel;
#   2. .env на сервере (600, вне git);
#   3. сборка образа и подъём ТОЛЬКО сервиса strudel;
#   4. блок Caddy с бэкапом и откатом;
#   5. проверка конфигурации Caddy и /api/health.
#
# Сервисы «швейки» (web, bot, admin-bot) не трогаются: `up -d strudel`
# поднимает только студию.
param(
  [string]$AppDir = '/opt/strudel',
  [string]$ComposeDir = '/opt/shveyka',
  [string]$Domain = 'music.34.88.114.146.sslip.io',
  [string]$SshKey = "$HOME/.ssh/shveyka_deploy",
  [string]$SshHost = 'root@34.88.114.146'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$archive = Join-Path $env:TEMP "strudel-deploy-$stamp.tar.gz"

function Invoke-Ssh([string]$Command) {
  & ssh -i $SshKey -o BatchMode=yes $SshHost $Command
  if ($LASTEXITCODE -ne 0) { throw "ssh вернул код ${LASTEXITCODE}: ${Command}" }
}

Write-Output '==> Архив исходников'
Push-Location $root
try {
  & tar -czf $archive --exclude='./.git' --exclude='./node_modules' --exclude='./dist' --exclude='./.env' --exclude='./.sharrowkin' --exclude='./data/timbre/audio/originals' .
  if ($LASTEXITCODE -ne 0) { throw "tar вернул код ${LASTEXITCODE}" }
} finally {
  Pop-Location
}
Write-Output ("    архив: {0} КБ" -f [math]::Round((Get-Item $archive).Length / 1KB))

Write-Output '==> Копирование на сервер'
& scp -i $SshKey -o BatchMode=yes $archive "${SshHost}:/tmp/strudel-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "scp вернул код ${LASTEXITCODE}" }

Write-Output "==> Распаковка в ${AppDir}"
Invoke-Ssh "mkdir -p ${AppDir} && tar -xzf /tmp/strudel-deploy.tar.gz -C ${AppDir} && rm -f /tmp/strudel-deploy.tar.gz"

Write-Output '==> .env на сервере'
Invoke-Ssh "test -f ${AppDir}/.env && chmod 600 ${AppDir}/.env"

# Композит-файл собирается локально (без кавычек внутри) и уходит на сервер
# как обычный файл: так не нужно экранировать кавычки дважды.
$composeYaml = @'
services:
  strudel:
    build:
      context: __APP_DIR__
      dockerfile: Dockerfile
    image: strudel-ai-composer:local
    env_file:
      - __APP_DIR__/.env
    environment:
      NODE_ENV: production
      PORT: "3001"
      HOST: "0.0.0.0"
    expose:
      - "3001"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
'@
$composeYaml = $composeYaml.Replace('__APP_DIR__', $AppDir)
$composeLocal = Join-Path $env:TEMP "docker-compose.strudel-$stamp.yml"
Set-Content -Path $composeLocal -Value $composeYaml -Encoding UTF8
& scp -i $SshKey -o BatchMode=yes $composeLocal "${SshHost}:${ComposeDir}/docker-compose.strudel.yml"
if ($LASTEXITCODE -ne 0) { throw "scp compose-файла вернул код ${LASTEXITCODE}" }

Write-Output '==> Сборка образа и подъём сервиса strudel'
Invoke-Ssh "cd ${ComposeDir} && docker compose -f docker-compose.yml -f docker-compose.strudel.yml build --progress plain strudel"
Invoke-Ssh "cd ${ComposeDir} && docker compose -f docker-compose.yml -f docker-compose.strudel.yml up -d strudel"

Write-Output '==> Caddy: бэкап конфига и проверка блока студии'
Invoke-Ssh "cp ${ComposeDir}/Caddyfile ${ComposeDir}/Caddyfile.bak-${stamp}"
Invoke-Ssh "grep -q '${Domain}' ${ComposeDir}/Caddyfile"
if ($LASTEXITCODE -ne 0) {
  $caddyBlock = @'

__DOMAIN__ {
	encode zstd gzip
	reverse_proxy strudel:3001
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
}
'@
  $caddyBlock = $caddyBlock.Replace('__DOMAIN__', $Domain)
  $caddyLocal = Join-Path $env:TEMP "caddy-block-$stamp.txt"
  Set-Content -Path $caddyLocal -Value $caddyBlock -Encoding UTF8
  & scp -i $SshKey -o BatchMode=yes $caddyLocal "${SshHost}:/tmp/caddy-block.txt"
  Invoke-Ssh "cat /tmp/caddy-block.txt >> ${ComposeDir}/Caddyfile && rm -f /tmp/caddy-block.txt"
}
Invoke-Ssh "cd ${ComposeDir} && docker compose restart caddy"

Write-Output '==> Проверка конфигурации Caddy'
& ssh -i $SshKey -o BatchMode=yes $SshHost 'docker exec $(docker ps -qf "name=shveyka-caddy-1") caddy validate --config /etc/caddy/Caddyfile'
if ($LASTEXITCODE -ne 0) {
  Write-Output '!!! Конфиг Caddy не прошёл проверку — откатываю' -ForegroundColor Red
  Invoke-Ssh "cp ${ComposeDir}/Caddyfile.bak-${stamp} ${ComposeDir}/Caddyfile"
  Invoke-Ssh "cd ${ComposeDir} && docker compose restart caddy"
  exit 1
}

Write-Output '==> Смоук: контейнер'
Start-Sleep -Seconds 10
& ssh -i $SshKey -o BatchMode=yes $SshHost 'docker exec shveyka-strudel-1 wget -qO- http://127.0.0.1:3001/api/health'
if ($LASTEXITCODE -ne 0) { throw 'Смоук контейнера не прошёл' }

Write-Output '==> Смоук: публичный адрес'
try {
  $response = Invoke-WebRequest -Uri "https://${Domain}/api/health" -UseBasicParsing -TimeoutSec 20
  Write-Output "    https://${Domain}/api/health → $($response.StatusCode) $($response.Content)"
} catch {
  Write-Output "    публичный адрес не ответил: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Output '==> Соседние сервисы не тронуты'
# Формат без пробелов: иначе PowerShell разбирает аргументы по пробелам и
# docker получает "--format {{.Names}}" как два разных аргумента.
& ssh -i $SshKey -o BatchMode=yes $SshHost 'docker ps --filter=name=shveyka --format={{.Names}}:{{.Status}}'

Remove-Item -Force $archive -ErrorAction SilentlyContinue
Remove-Item -Force $composeLocal -ErrorAction SilentlyContinue
Write-Output '==> Готово'
