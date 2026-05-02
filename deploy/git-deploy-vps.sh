#!/usr/bin/env bash
# Деплой на VPS из Git: репозиторий = единственный источник правды (кроме .env и data/ на сервере).
# Требования: Node, npm; опционально Docker (образ runner студии); rsync.
# Использование на сервере (после clone в /var/www/ollama):
#   chmod +x deploy/git-deploy-vps.sh
#   REPO=/var/www/ollama WEB_OUT=/var/www/ollama-web-react ./deploy/git-deploy-vps.sh
set -euo pipefail

REPO="${REPO:-/var/www/ollama}"
WEB_OUT="${WEB_OUT:-/var/www/ollama-web-react}"
BRANCH="${BRANCH:-main}"
SUDO=""
if [[ "$(id -u)" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo "
fi

if [[ ! -d "$REPO/.git" ]]; then
  echo "Ошибка: не Git-репозиторий — $REPO (задайте REPO= путь к clone ollama)"
  exit 1
fi

cd "$REPO"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only "origin" "$BRANCH"

echo "==> ollama-api: npm ci"
cd "$REPO/ollama-api"
npm ci --omit=dev

if command -v docker >/dev/null 2>&1; then
  echo "==> studio-runner Docker image"
  npm run studio-runner:build
else
  echo "Предупреждение: docker не найден — образ runner не собран (сборки превью на хосте или установите Docker)."
fi

echo "==> ollama-web-react: build"
cd "$REPO/ollama-web-react"
npm ci
npm run build

echo "==> выкладка SPA в $WEB_OUT"
${SUDO}mkdir -p "$WEB_OUT"
${SUDO}rsync -a --delete "$REPO/ollama-web-react/dist/" "$WEB_OUT/"

echo "==> перезапуск API"
${SUDO}systemctl restart ollama-api
${SUDO}systemctl status ollama-api --no-pager || true
echo "Готово."
