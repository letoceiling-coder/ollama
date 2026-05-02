# Ollama Web Chat (React + Vite + Tailwind)

Production-ready интерфейс в стиле ChatGPT для вашего OpenAI-совместимого endpoint `POST /v1/chat/completions`.

## Стек

- React 19 · Vite 6 · TypeScript · TailwindCSS  
- Без UI-фреймворков и лишних runtime-зависимостей

## Запуск локально

```bash
cd ollama-web-react
npm install
cp .env.example .env
npm run dev
```

В режиме разработки `vite.config.ts` проксирует `/v1/*` на `https://ollama.site-al.ru`, чтобы не упираться в CORS.

## Сборка

```bash
npm run build
```

Артефакты — каталог `dist/`.

## Деплой на сервер

Скопируйте содержимое **`dist/`** в **`/var/www/ollama-web-react`** и отдавайте как статический root в nginx для домена чата (или смонтируйте как `alias`/`root`). Убедитесь, что **`location /v1/`** по-прежнему проксируется на ваш gateway (`127.0.0.1:3011`), чтобы браузер вызывал **`fetch('/v1/chat/completions')`** с того же origin.

Переменные для прод-сборки задавайте при сборке или через `.env`:

- `VITE_API_BASE=` — пусто при том же домене и nginx-proxy на `/v1`
- `VITE_API_AUTH=Bearer key1`
- `VITE_TEXT_MODEL` / `VITE_VISION_MODEL`

## Vision и документы

- **Изображения** (jpg/png): конвертация в base64 и поле **`images`** в теле запроса к `/v1/chat/completions`; модель по умолчанию **`llava:latest`** (должна быть разрешена на gateway и установлена в Ollama).
- **TXT**: текст файла добавляется к промпту блоком «Вот документ…».
- **PDF**: грубое извлечение строк без сторонних библиотек; сканы и сложная вёрстка могут не распознаться — тогда сохраните как `.txt`.

## Компоненты

`ChatLayout`, `Sidebar`, `MessageList`, `MessageItem`, `ChatInput`, `FileUpload` — в `src/components/`.
