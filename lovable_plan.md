# План реализации «Студия сайтов» (/lovable) — полный проект

Документ описывает целевую архитектуру, границы системы, API, безопасность, превью, агентов и поэтапный ввод. Предполагается развитие текущего стека: **React (Vite)**, **Express (ollama-api)**, **nginx**, **Ollama/внешние LLM**, **Linux VPS**.

---

## 1. Цели и границы

### 1.1 Цель продукта

Пользователь в веб-интерфейсе (аналог Lovable):

- формулирует задачу на создание или доработку сайта/веб-приложения в **контексте проекта** (чат + файлы);
- видит **живое превью** (статика или dev-сервер);
- управляет **очередью задач** и версиями (workspace);
- опционально получает **публичную ссылку** на демо или деплой.

Агент (LLM + оркестратор) получает **ограниченный, аудируемый** набор инструментов: работа с файлами проекта, запуск команд в изолированной среде, проверки (lint/build), выдача URL превью.

### 1.2 Вне скоупа первых версий (явно)

- Полноценный «бесконечный» хостинг продакшен-сайтов пользователей без лимитов (только контролируемые демо/staging).
- Произвольный произвольный outbound из превью без ограничений (см. безопасность).
- Гарантия 100% генерации без ошибок — нужны fallback, логи и ручной режим.

### 1.3 Принципы

1. **Изоляция по умолчанию**: каждый проект/сессия сборки — отдельная cgroup/контейнер/VM tier по политике.
2. **Минимальные привилегии**: агент не имеет доступа к хосту, только к API runner и workspace API.
3. **Воспроизводимость**: lockfile, зафиксированные образы Docker, версии Node.
4. **Аудит**: кто что запросил, какие команды выполнены, какие файлы изменены.

---

## 2. Высокоуровневая архитектура

```
[Браузер]
    │ HTTPS (ollama.site-al.ru)
    ▼
[nginx]
    ├── /           → статика SPA (ollama-web-react)
    ├── /api/chats… → существующий ollama-api (cookie auth)
    └── /api/studio/*  → расширение gateway или отдельный studio-api (:3020)
              │
              ├── Postgres/SQLite (метаданные проектов, ревизии, задачи)
              ├── Object storage или FS (snapshots workspace)
              └── [Runner orchestrator]
                        │
                        ├── очередь задач (BullMQ/Redis или встроенная pg-queue)
                        └── Worker-пул
                                  └── Docker (или Firecracker/Kata при росте)
                                        └── контейнер: Node + vite/pnpm + git worktree
```

**Рекомендация по разбиению сервисов (эволюция):**

| Этап | Состав |
|------|--------|
| MVP | Расширение **ollama-api** маршрутами `/api/studio/*`, один **runner** как child-процесс Docker CLI на том же хосте |
| Рост | Вынос **studio-api** + **runner-worker** на отдельные systemd units / второй машине |
| Scale | Kubernetes Nomad/Temporal для долгих задач |

---

## 3. Модель данных

### 3.1 Сущности

- **User** — уже есть (`user_id` cookie / сессия gateway).
- **StudioProject** — `id`, `user_id`, `name`, `slug`, `created_at`, `updated_at`, `status` (`draft`, `active`, `archived`).
- **StudioRevision** — снимок файловой системы или git commit hash внутри workspace; `project_id`, `parent_revision_id`, `message`, `created_at`.
- **StudioFile** — опционально нормализованное хранение blob (или только tarball/zstd архив ревизии).
- **StudioTask** — постановка для агента: `id`, `project_id`, `revision_id`, `title`, `payload` (JSON), `status` (`queued`, `running`, `done`, `failed`), `agent_run_id`.
- **AgentRun** — один запуск LLM с инструментами: `id`, `task_id`, `model`, `prompt_tokens`, `tool_calls` (JSONL), `finished_at`, `error`.
- **PreviewSession** — `id`, `project_id`, `revision_id`, `url`, `expires_at`, `runner_container_id`.

Хранилище файлов:

- **Вариант A (проще)**: каждая ревизия — **tar.gz** в `/var/lib/studio/projects/{project_id}/revs/{revision_id}.tar.gz`.
- **Вариант B**: Git bare внутри сервера + `git archive` для ревизий (удобнее для diff и merge).

### 3.2 Индексы и целостность

- Уникальный `(user_id, slug)` для проекта.
- FK каскады при удалении проекта → задачи, превью, файлы.

---

## 4. API (контракты)

Все под `/api/studio`, авторизация та же что у чатов (cookie `user_id` + проверка владельца).

### 4.1 Проекты

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/studio/projects` | список проектов пользователя |
| POST | `/api/studio/projects` | создать `{ name, slug?, template?: 'vite-react-ts' }` |
| GET | `/api/studio/projects/:id` | метаданные + последняя ревизия |
| PATCH | `/api/studio/projects/:id` | переименование, архив |
| DELETE | `/api/studio/projects/:id` | удалить (с подтверждением на клиенте) |

### 4.2 Файлы и ревизии

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/studio/projects/:id/files` | дерево или flat-list текущей HEAD ревизии |
| GET | `/api/studio/projects/:id/files/**path` | содержимое файла |
| PUT | `/api/studio/projects/:id/files/**path` | записать файл (с optimistic locking `rev`/`etag`) |
| POST | `/api/studio/projects/:id/revisions` | зафиксировать снимок `{ parent_revision_id?, message }` |

Для больших правок агента предпочтительнее **один PATCH**:

`PATCH /api/studio/projects/:id/workspace`

```json
{
  "base_revision_id": "uuid",
  "operations": [
    { "op": "write", "path": "src/App.tsx", "content_base64": "..." },
    { "op": "delete", "path": "tmp/old.tsx" },
    { "op": "mkdir", "path": "src/components" }
  ]
}
```

Ответ: `{ revision_id, conflicts?: [...] }`.

### 4.3 Задачи и запуск агента

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/studio/projects/:id/tasks` | список задач |
| POST | `/api/studio/projects/:id/tasks` | создать задачу `{ title, prompt, images?: [...] }` |
| POST | `/api/studio/projects/:id/agent/run` | запуск агента по задаче или инлайн `{ task_id \| prompt }` |

Стрим статуса (для UI как чат):

- **SSE**: `GET /api/studio/projects/:id/agent/stream/:runId`
  - события: `delta`, `tool_start`, `tool_end`, `revision`, `preview_url`, `error`, `done`.

Альтернатива: WebSocket для двусторонности (остановка run).

### 4.4 Превью

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/studio/projects/:id/preview` | `{ revision_id?, mode: 'static' \| 'dev' }` |
| GET | `/api/studio/projects/:id/preview` | текущая активная сессия + URL |
| DELETE | `/api/studio/projects/:id/preview` | остановить контейнер |

Ответ содержит **внутренний или публичный URL**:

- Публичный: `https://preview.{main-domain}/{token}/` через nginx → upstream контейнера.
- Или одноразовый JWT в path для TTL и отзыва.

---

## 5. Runner и превью (тонкости)

### 5.1 Режимы превью

1. **`static`** — `npm ci && npm run build`, раздача `dist/` через nginx внутри контейнера или через общий nginx с volume.
   - Плюсы: безопаснее, предсказуемый CSP.
   - Минусы: медленнее на каждое изменение.

2. **`dev`** — `npm ci && npm run dev -- --host 0.0.0.0 --port 5173`.
   - Плюсы: быстрая итерация, HMR (если разрешить).
   - Минусы: больше поверхность атаки; нужен строгий network policy.

**Рекомендация MVP:** только **static** для внешних пользователей; **dev** — флаг «доверенный пользователь» или только localhost через SSH-туннель.

### 5.2 Образ Docker (baseline)

- Базовый образ: `node:20-bookworm-slim`.
- Предустановленные CLI: `pnpm` или `npm`, опционально `playwright` только для CI-джобы без браузера в превью.
- Запуск от пользователя **non-root** (`uid 10001`).
- **read-only** root filesystem где возможно; **tmpfs** для `/tmp`; лимиты:
  - `--memory`, `--cpus`, `--pids-limit`, `--network` (см. ниже).

### 5.3 Сеть контейнеров

- По умолчанию **изолированная сеть** Docker `studio_isolated` без доступа к metadata cloud, внутренним IP VPS, Ollama.
- Разрешить исходящий **только**:

  - реестры npm (`registry.npmjs.org`), при необходимости зеркало;
  - фиксированный allowlist DNS (опционально через прокси).

- Запретить доступ к `169.254.169.254`, RFC1918 хосту (кроме явного proxy), `metadata.google.internal`.

### 5.4 Публичный URL превью

Варианты:

1. **Path-based**: `https://ollama.site-al.ru/preview/{token}/` → nginx `proxy_pass` на `127.0.0.1:{dynamic_port}` где слушает контейнер.
2. **Subdomain**: `https://{token}.preview.ollama.site-al.ru` — нужен wildcard TLS (Let’s Encrypt DNS-01).

Механика:

- При `POST /preview` orchestrator поднимает контейнер, биндует порт на **loopback** хоста `127.0.0.1:3xxxx`, региструет mapping `token → port` в Redis или локальном store.
- nginx upstream обновляется:

  - либо **lua/openresty** + shared dict (сложнее),
  - либо **отдельный маленький reverse proxy** (Caddy/traefik) с on-demand конфигом,
  - либо единый **HAProxy** с runtime map (как уже используется для SNI) — консистентно с вашей инфраструктурой.

**TTL:** превью живёт 15–60 минут неактивности; cron снимает контейнеры.

### 5.5 Ресурсы и стоимость

- Лимит параллельных превью на пользователя (например 1) и глобально (например 20).
- Очередь Fair queue (per user) чтобы один не забил весь хост.

---

## 6. Агент: инструменты (tool-calling)

### 6.1 Минимальный набор инструментов для LLM

| Tool | Назначение |
|------|------------|
| `studio.read_file` | чтение файла из workspace (с лимитом размера) |
| `studio.write_file` | запись/создание |
| `studio.delete_path` | удаление файла/пустой папки |
| `studio.list_dir` | листинг |
| `studio.search` | rg-подобный поиск по проекту (индекс или spawn `rg` в контейнере) |
| `studio.run_command` | белый список команд: `npm ci`, `npm run build`, `npm run lint`, `node -v` |
| `studio.request_preview` | триггер сборки static preview, возврат URL |
| `studio.read_build_log` | последние N строк stdout/stderr |

**Запрет:** произвольный `sh -c`, `curl`, `wget` без allowlist.

### 6.2 Реализация `run_command`

- Выполнение **только** внутри контейнера workspace (тот же образ, другой контейнер от одного snapshot).
- Timeout 3–10 минут, убийство по SIGKILL.
- Парсинг exit code; при ненулевом — сообщение агенту + лог.

### 6.3 Промпт и модель

- Системный промпт: стек проекта, правила дизайна, ограничения по зависимостям (можно ли `npm install lodash` — политика).
- Vision: если пользователь приложил макет — передача изображений в multimodal модель (у вас уже есть цепочка vision).
- Разделение: **планирование** (дешёвая модель) → **код** (сильная модель) — опциональный pipeline.

### 6.4 Связка с существующим чатом

- Опционально: кнопка «Открыть в чате» создаёт связь `project_id` в метаданных сессии чата.
- Или единый «контекстный объект» в БД: `ChatLink { type: 'studio', ref_id }`.

---

## 7. Безопасность (все тонкости)

### 7.1 SSRF и preview

- Превью не должно дергать внутренние сервисы по IP пользователя (не применимо к static dist, но применимо если в будущем embed внешние URL в iframe).

### 7.2 CSP и iframe

- Превью на **отдельном origin** (`preview.*`) облегчает изоляцию.
- Заголовки: `Content-Security-Policy` по умолчанию строгие; для пользовательского HTML — sandboxed **subframe** с `sandbox` атрибутами на родителе + изолированный origin.

### 7.3 Supply chain

- `npm audit` в CI-пайплайне агента (информировать пользователя).
- Опционально: запрет install новых пакетов без подтверждения UI.

### 7.4 Секреты

- Никакие `.env` с реальными ключами в ревизиях по умолчанию; шаблон `.env.example`.
- Если нужны ключи пользователя — отдельное зашифрованное хранилище (KMS или libsodium с ключом сервера).

### 7.5 Утечки между пользователями

- Обязательная проверка `project.user_id === session.user_id` на каждом запросе.
- Runner подписывает JWT на один `project_id` + `revision_id` + `exp`.

---

## 8. Фронтенд (/lovable)

### 8.1 Страницы и состояние

- Маршруты: `/lovable`, `/lovable/project/:id`, опционально `/lovable/project/:id/rev/:revId`.
- Глобальный store: TanStack Query для серверного состояния; локальный UI для панелей.
- Monaco Editor или CodeMirror 6 для редактирования файла (постепенно).

### 8.2 Превью во фрейме

- `iframe src={previewUrl}` с тем же isolated origin.
- Обработка ошибок загрузки, спиннер пока runner работает.
- Кнопка «Открыть в новой вкладке».

### 8.3 UX паттерны как у Lovable

- Чат закреплён справа; слева файлы; центр превью — уже заложено в MVP layout.
- Diff перед применением больших патчей (просмотр изменений).

---

## 9. Наблюдаемость и эксплуатация

- Структурированные логи JSON: `run_id`, `project_id`, `duration_ms`, `exit_code`.
- Метрики: Prometheus node_exporter + custom counters (`studio_preview_started_total`, …).
- Трейсинг: OpenTelemetry при выносе сервисов.
- Алерты: очередь > threshold, доля failed builds, утечка контейнеров (`docker ps` watch).

---

## 10. Резервное копирование

- Ежедневный snapshot каталога `/var/lib/studio` + БД.
- Retention 7–30 дней.

---

## 11. Поэтапный план внедрения

### Фаза 0 — уже есть

SPA маршрут `/lovable`, статический каркас UI.

### Фаза 1 — «пассивный проект»

- CRUD проектов, шаблон `vite-react-ts` из архива.
- Загрузка/чтение файлов через API.
- Ручное редактирование одного файла в UI (опционально).

### Фаза 2 — runner static preview

- Docker образ, сборка `npm ci && npm run build`.
- Выдача URL через nginx map.
- TTL и лимиты.

### Фаза 3 — агент

- Интеграция tool-calling с существующим LLM gateway.
- SSE стрим в UI.
- Задачи `StudioTask` + история.

### Фаза 4 — качество

- Lint/test в пайплайне, отчёт в чат.
- Diff UI, откат ревизии.

### Фаза 5 — масштаб

- Вынос worker, очередь Redis, HA preview proxy.

---

## 12. Изменения nginx (черновик)

Дополнительно к существующему `location /api/`:

```nginx
# Пример: превью по пути (токен проверяется в studio-api перед выдачей upstream)
location ~ ^/preview/(?<ptoken>[a-zA-Z0-9_-]+)(?<puri>/.*)$ {
    proxy_pass http://127.0.0.1:3020/internal/preview/$ptoken$puri;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}
```

Точная схема зависит от выбора **path** vs **subdomain** и от того, где живёт routing (nginx vs sidecar).

---

## 13. Риски и митигации

| Риск | Митигация |
|------|-----------|
| Утечка контейнеров | watchdog, TTL, `docker rm -f` по schedule |
| DoS через тяжёлые сборки | квоты CPU/RAM, очередь, rate limit по user |
| Модель ломает проект | ревизии + откат; обязательный `build` перед preview |
| Юридический контент на превью | ToS, abuse reporting, блокировка аккаунта |

---

## 14. Связанные файлы в репозитории

- Фронт: `ollama-web-react/src/pages/LovableStudio.tsx`, маршрутизация `App.tsx`.
- Gateway (расширение): `ollama-api/index.js` или новый сервис `studio-api/`.
- Инфра: `deploy/ollama.site-al.ru.conf`.

---

## 15. Решения «зафиксировать на ревью»

Перед кодированием утвердить:

1. Path-based vs subdomain для preview.
2. Git внутри сервера vs только tar-ревизии.
3. Один процесс Node vs отдельный `studio-api`.
4. Политика зависимостей (allow all public npm vs allowlist).

---

*Версия документа: 1.0 · сгенерировано для развёртывания студии сайтов на инфраструктуре ollama.site-al.ru / ollama.site-ai.ru.*
