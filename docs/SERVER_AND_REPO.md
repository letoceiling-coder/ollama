# Аудит VPS и сопоставление с репозиторием

**Сервер:** `89.169.39.244` (hostname `titdsftsmw`)  
**Сайт:** https://ollama.site-al.ru/  
**Дата аудита:** 2026-05-02

## Как устроен доступ к Ollama (туннель)

На **VPS Ollama не крутится как демон**. В `.env` шлюза указано:

`OLLAMA_URL=http://127.0.0.1:11434`

На самом сервере порт **127.0.0.1:11434** слушает **sshd** (обратный SSH-туннель): трафик с VPS на `localhost:11434` попадает на **домашний ПК**, где запущены `ollama serve` и скрипт туннеля (см. `windows-autostart/` и `scripts/ollama-reverse-tunnel.ps1`). Проверка: `ss -tlnp` показывает `sshd` на `127.0.0.1:11434`, при этом `curl http://127.0.0.1:11434/api/tags` на VPS отдаёт модели с домашней машины.

**Итог:** железо и модели — дома; VPS — nginx, Node-шлюз и точка входа из интернета.

---

## Каталоги на сервере, относящиеся к этому проекту

| Путь на VPS | Назначение |
|-------------|------------|
| `/var/www/ollama` | **Git clone монорепозитория** `git@github.com:letoceiling-coder/ollama.git` — единый источник кода на сервере (рекомендуется). |
| `/var/www/ollama-api` | **Продакшен API** — Express; предпочтительно **симлинк** на `/var/www/ollama/ollama-api`, иначе отдельная копия + ручной sync. Файлы **не в Git:** `.env`, `data/users/`, `uploads/`, `logs/`. systemd: `ollama-api.service`, пользователь `www-data`. |
| `/var/www/ollama-web-react` | **Статика SPA** (результат `npm run build`), только `index.html` + `assets/`. Nginx: `root` для `location /`. |
| `/var/www/ollama-web` | **Устаревший** вариант — один `index.html` (старый чат без React). На прод сейчас не используется как основной UI. |
| `/var/www/ollama.site-al.ru` | Почти пусто — только каталог для **ACME** `/.well-known` в HTTP-сервере. |
| `/etc/nginx/sites-available/ollama.site-al.ru` | Прокси `/v1`, `/api`, `/chat`, `/health` → `127.0.0.1:3011`, статика `/` → `/var/www/ollama-web-react`. SSL на `127.0.0.1:9443` (типичная схема с внешним TLS-прокси/балансировщиком). |
| `/root/lovable_plan.md` | План «Студия сайтов» (/lovable). В Git — в корне `lovable_plan.md`. |

### Корень файловой системы `/` — папки `backend`, `frontend`, `catalog`, …

Каталоги **`/backend`**, **`/frontend/dist`**, **`/catalog`**, **`/gallery`**, **`/hero`**, **`/products`** на момент просмотра **не относятся** к стеку ollama.site-al.ru: даты **февраль 2025**, отдельный прототип/сайт. Их **не нужно** смешивать с репозиторием Ollama Chat / Lovable — это другой проект на том же сервере.

---

## Сервисы и расписания

- **`ollama-api.service`**: `WorkingDirectory=/var/www/ollama-api` (или `/var/www/ollama/ollama-api` при прямом пути), `EnvironmentFile=.env`, `ExecStart=node index.js`.
- В **cron** root задач под этот проект **нет** — только другие сайты (AL, parser-tg, neeklo, ai.site-al.ru и т.д.).

---

## Git: единый источник правды

**Удалённый репозиторий:** `git@github.com:letoceiling-coder/ollama.git`  
**Ветка:** `main`. Локальная рабочая копия и коммиты — в корне монорепо; на проде код обновляется **только** через `git pull` (без ручного расхождения «сервер vs Git»).

Роли каталогов:

```
ollama-api/           # Шлюз Express
ollama-web-react      # SPA (Vite + React) — на прод выкладывается только dist/
deploy/               # nginx, скрипты деплоя (`git-deploy-vps.sh`)
docs/                 # Документация
lovable_plan.md
.env.example
```

**В Git не попадают** (см. корневой `.gitignore`): `.env`, `node_modules/`, `ollama-web-react/dist/`, `ollama-api/data/users/*.json`, `ollama-api/data/studio-workspaces/`, логи и загрузки API.

### Первичная настройка VPS под Git

Один раз на сервере (от root), с **бэкапом** текущих `data/` и `.env`:

```bash
# пример: бэкап старого API
mv /var/www/ollama-api /var/www/ollama-api.bak-$(date +%Y%m%d)

cd /var/www
git clone git@github.com:letoceiling-coder/ollama.git ollama
cd ollama && git checkout main

# симлинк — systemd и привычные пути не меняются
ln -sfn /var/www/ollama/ollama-api /var/www/ollama-api

# восстановить данные и секреты (не из Git!)
mkdir -p /var/www/ollama-api/data/users
cp -a /var/www/ollama-api.bak-*/data/users/. /var/www/ollama-api/data/users/ 2>/dev/null || true
cp /var/www/ollama-api.bak-*/.env /var/www/ollama-api/.env 2>/dev/null || true
chown -R www-data:www-data /var/www/ollama-api/data /var/www/ollama-api/uploads /var/www/ollama-api/logs 2>/dev/null || true
```

Синхронизировать **`deploy/ollama.site-al.ru.conf`** с `/etc/nginx/sites-available/ollama.site-al.ru`, затем `nginx -t && systemctl reload nginx`.

Пользователь **`www-data`** в группе **`docker`**, если используется Docker-сборка студии.

### Деплой после изменений в Git

На сервере:

```bash
cd /var/www/ollama
chmod +x deploy/git-deploy-vps.sh
./deploy/git-deploy-vps.sh
```

Скрипт выполняет: `git pull --ff-only`, `npm ci` в API и фронте, `npm run build` SPA, `rsync` в `/var/www/ollama-web-react/`, `npm run studio-runner:build` при наличии Docker, `systemctl restart ollama-api`.

Переменные окружения: `REPO` (по умолчанию `/var/www/ollama`), `WEB_OUT` (по умолчанию `/var/www/ollama-web-react`), `BRANCH` (по умолчанию `main`).

**Локально перед push:** в корне `npm run build` в `ollama-web-react` по желанию — на проде сборка всегда повторяется скриптом.

### Студия (фаза 2): `STUDIO_PREVIEW_SECRET` и nginx `/preview/`

В **`/var/www/ollama-api/.env`** (файл на сервере, не в Git) задайте устойчивый **`STUDIO_PREVIEW_SECRET`** (`openssl rand -hex 32`). В nginx должен быть блок **`location /preview/`** из **`deploy/ollama.site-al.ru.conf`**. Дополнительно: **`deploy/apply-studio-on-vps.sh`** — разовая подводка окружения.

### Синхронизация с удалённым репозиторием без расхождений

- Разработка и коммиты — **только в локальном clone**, затем **`git push origin main`**.
- На VPS — только **`git pull --ff-only`** (или скрипт деплоя); правки кода напрямую на сервере **не вносить** (иначе снова появится расхождение).
- Если история на GitHub должна полностью совпасть с локальной: на свой страх и риск **`git push --force-with-lease origin main`** (после согласования с командой).

**Домашний ПК:** Ollama и SSH-туннель на `127.0.0.1:11434` на VPS должны быть активны — иначе чат и модели с прода не работают (см. раздел «Как устроен доступ к Ollama» выше).
