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
| `/var/www/ollama-api` | **Продакшен API** — Express (`index.js`), `package.json`, `.env`, `data/users/*.json`, `uploads/`, `logs/`. systemd: `ollama-api.service`, пользователь `www-data`. |
| `/var/www/ollama-web-react` | **Статика SPA** (результат `npm run build`), только `index.html` + `assets/`. Nginx: `root` для `location /`. |
| `/var/www/ollama-web` | **Устаревший** вариант — один `index.html` (старый чат без React). На прод сейчас не используется как основной UI. |
| `/var/www/ollama.site-al.ru` | Почти пусто — только каталог для **ACME** `/.well-known` в HTTP-сервере. |
| `/etc/nginx/sites-available/ollama.site-al.ru` | Прокси `/v1`, `/api`, `/chat`, `/health` → `127.0.0.1:3011`, статика `/` → `/var/www/ollama-web-react`. SSL на `127.0.0.1:9443` (типичная схема с внешним TLS-прокси/балансировщиком). |
| `/root/lovable_plan.md` | План «Студия сайтов» (/lovable). В Git — в корне `lovable_plan.md`. |

### Корень файловой системы `/` — папки `backend`, `frontend`, `catalog`, …

Каталоги **`/backend`**, **`/frontend/dist`**, **`/catalog`**, **`/gallery`**, **`/hero`**, **`/products`** на момент просмотра **не относятся** к стеку ollama.site-al.ru: даты **февраль 2025**, отдельный прототип/сайт. Их **не нужно** смешивать с репозиторием Ollama Chat / Lovable — это другой проект на том же сервере.

---

## Сервисы и расписания

- **`ollama-api.service`**: `WorkingDirectory=/var/www/ollama-api`, `EnvironmentFile=.env`, `ExecStart=node index.js`.
- В **cron** root задач под этот проект **нет** — только другие сайты (AL, parser-tg, neeklo, ai.site-al.ru и т.д.).

---

## Рекомендуемая структура Git (монорепозиторий)

Имеет смысл держать **один** репозиторий с явными ролями каталогов:

```
ollama-api/           # Исходник шлюза (как на VPS); деплой в /var/www/ollama-api
ollama-web-react/     # Исходник фронта (Vite + React); деплой: dist → /var/www/ollama-web-react
ollama-web-chat/      # Опционально: старый одностраничный HTML-чат (история/референс)
deploy/               # Снимки nginx (и при необходимости phase-конфиги)
windows-autostart/    # Автозапуск Ollama + reverse SSH на Windows (домашний ПК)
scripts/              # Вспомогательные скрипты (туннель и т.п.)
docs/                 # Документация (этот файл)
ssh-install-key/      # Утилита установки ключа (только исходники .cs/.csproj)
lovable_plan.md       # Продуктовый план
.env.example          # Шаблон переменных (корень или дублировать из ollama-api)
```

**Не коммитить:** `.env`, `node_modules/`, `dist/` (собирается при деплое), `api/data/users/*.json`, логи, загрузки, архивы `*.tgz`, временные JSON с ключами.

**Устаревшие дубликаты (локально):** каталог **`api/`** с тем же `index.js`, что и `ollama-api/`, и закоммиченная раньше **`frontend/`** как копия `dist` — в пользу структуры выше их лучше **убрать из репозитория** и ориентироваться на `ollama-api/` + сборку `ollama-web-react`.

**Имя файла nginx в `deploy/`:** на сервере файл называется `ollama.site-al.ru`; в репозитории достаточно одной копии — `deploy/ollama.site-al.ru.conf` (дубликат с другим именем удалить).

---

## Чек-лист деплоя после `git pull`

1. `ollama-api`: `npm ci`, при необходимости миграции данных — не трогать `data/users` на проде без бэкапа.
2. `ollama-web-react`: `npm ci && npm run build`, затем синхронизация `dist/` → `/var/www/ollama-web-react/`.
3. `systemctl restart ollama-api` при смене кода или `.env`.
4. Домашний ПК: Ollama запущен, туннель активен — иначе `/api` и модели недоступны.
