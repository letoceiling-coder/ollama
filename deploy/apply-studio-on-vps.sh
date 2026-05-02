#!/usr/bin/env bash
# Применение студии (фаза 2) на VPS после git pull.
# Запуск от root или от пользователя с правами на nginx/systemctl (при необходимости sudo).
set -euo pipefail

SUDO=""
if [[ "$(id -u)" != "0" ]] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo "
fi
API_DIR="${API_DIR:-/var/www/ollama-api}"
# Корень монорепозитория на сервере, если вы деплоите из одного clone (иначе не используется)
REPO_ROOT="${REPO_ROOT:-/var/www/ollama}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/ollama.site-al.ru}"
DEPLOY_CONF_IN_REPO="$REPO_ROOT/deploy/ollama.site-al.ru.conf"

echo "==> API dir: $API_DIR"

if [[ ! -f "$API_DIR/package.json" ]]; then
  echo "Ошибка: нет $API_DIR/package.json — задайте API_DIR=..."
  exit 1
fi

cd "$API_DIR"
if [[ -d .git ]]; then
  git pull
else
  echo "Нет .git в $API_DIR — обновите файлы вручную (rsync/scp) и продолжите без pull."
fi

echo "==> npm ci (ollama-api)"
npm ci --omit=dev

if command -v docker >/dev/null 2>&1; then
  echo "==> Docker: сборка образа студии (ollama-studio-runner:local)"
  npm run studio-runner:build
else
  echo "Предупреждение: docker не найден. Сборка превью останется на хосте (STUDIO_BUILD_EXECUTOR=auto) или задайте STUDIO_BUILD_EXECUTOR=host."
fi

ENV_FILE="$API_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Создайте $ENV_FILE из .env.example (корень репозитория) и задайте переменные."
  exit 1
fi

if ! grep -qE '^STUDIO_PREVIEW_SECRET=.{16,}' "$ENV_FILE"; then
  SECRET="$(openssl rand -hex 32)"
  echo ""
  echo "В $ENV_FILE нет устойчивого STUDIO_PREVIEW_SECRET. Добавьте строку (пример):"
  echo "STUDIO_PREVIEW_SECRET=$SECRET"
  echo ""
  if [[ "${STUDIO_APPEND_SECRET:-}" == "1" ]]; then
    echo "" >>"$ENV_FILE"
    echo "STUDIO_PREVIEW_SECRET=$SECRET" >>"$ENV_FILE"
    echo "Записано в $ENV_FILE (STUDIO_APPEND_SECRET=1)"
  else
    read -r -p "Добавить автоматически в конец $ENV_FILE? [y/N] " ok || true
    if [[ "${ok:-}" == "y" || "${ok:-}" == "Y" ]]; then
      echo "" >>"$ENV_FILE"
      echo "STUDIO_PREVIEW_SECRET=$SECRET" >>"$ENV_FILE"
      echo "Записано в $ENV_FILE"
    else
      echo "Добавьте STUDIO_PREVIEW_SECRET вручную и перезапустите ollama-api."
    fi
  fi
else
  echo "==> STUDIO_PREVIEW_SECRET уже задан в .env"
fi

echo "==> nginx: проверьте блок location /preview/ (как в репозитории deploy/ollama.site-al.ru.conf)"
if [[ -f "$DEPLOY_CONF_IN_REPO" ]] && [[ -f "$NGINX_SITE" ]]; then
  if ! grep -q 'location /preview/' "$NGINX_SITE" 2>/dev/null; then
    echo "В $NGINX_SITE не найден location /preview/ — вставьте фрагмент из $DEPLOY_CONF_IN_REPO вручную."
  else
    echo "В $NGINX_SITE уже есть /preview/"
  fi
else
  echo "Сверьте $NGINX_SITE с develop/репо: должен быть proxy на 127.0.0.1:3011 для /preview/"
fi

${SUDO}nginx -t
${SUDO}systemctl reload nginx

echo "==> Перезапуск ollama-api"
${SUDO}systemctl restart ollama-api
${SUDO}systemctl --no-pager status ollama-api || true

echo "Готово."
