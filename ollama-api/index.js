'use strict';

const path = require('path');
const envFile = process.env.DOTENV_CONFIG_PATH
  ? path.isAbsolute(process.env.DOTENV_CONFIG_PATH)
    ? process.env.DOTENV_CONFIG_PATH
    : path.join(__dirname, process.env.DOTENV_CONFIG_PATH)
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envFile });

const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const multer = require('multer');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3011);
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'llama3:latest';
/** Таймаут каждого запроса к Ollama (мс). Переменная окружения UPSTREAM_TIMEOUT_MS, по умолчанию 15000. */
const OLLAMA_FETCH_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);
const OLLAMA_FETCH_ATTEMPTS = 3;
/** Для POST /api/generate stream: один fetch, без retry; ожидание заголовков ответа. */
const OLLAMA_STREAM_FETCH_TIMEOUT_MS = Number(process.env.OLLAMA_STREAM_TIMEOUT_MS || 120000);
/** После заголовков от Ollama — лимит ожидания первой строки тела (мс). Env: OLLAMA_FIRST_CHUNK_TIMEOUT_MS */
const OLLAMA_FIRST_CHUNK_TIMEOUT_MS = Number(process.env.OLLAMA_FIRST_CHUNK_TIMEOUT_MS || 60000);
/** Фоновое обновление кеша для GET /api/health/ollama */
const OLLAMA_HEALTH_REFRESH_MS = 5000;
const MAX_PROMPT_CHARS = 5000;
/** Лимит текста поля content в POST /api/chats/.../message */
const MAX_USER_MESSAGE_CHARS = 2000;
/** Последние N сообщений чата уходят в контекст модели */
const MAX_HISTORY_MESSAGES = 10;
/** Текст одного документа в промпт и при сохранении */
const MAX_DOC_CHARS_PER_FILE = 1500;
/** Не более двух документов (txt/pdf) за один запрос */
const MAX_DOCUMENT_FILES_PER_MESSAGE = 2;
/** Изображения больше этого размера отклоняются */
const MAX_IMAGE_UPLOAD_BYTES = 3 * 1024 * 1024;
/** Итоговый текст запроса к Ollama для UI-чата */
const MAX_UNIFIED_PROMPT_CHARS = 8000;

const API_KEYS = new Set(
  (process.env.API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Разрешённые модели Ollama */
const ALLOWED_MODELS = [
  'llama3:latest',
  'mistral:latest',
  'deepseek-coder:latest',
  'llava:latest',
  'qwen2.5vl:3b',
  'qwen2.5vl:7b',
];
const ALLOWED_SET = new Set(ALLOWED_MODELS);

const LLAVA_MODEL = 'llava:latest';

/** Vision для чата с картинками (env VISION_CHAT_MODEL). По умолчанию 3B — меньше RAM/VRAM, чем 7B; Docker это не уменьшает. */
const VISION_CHAT_MODEL = (process.env.VISION_CHAT_MODEL || 'qwen2.5vl:7b').trim();

/** Роутинг моделей для UI-чата: картинки → VL-модель, иначе llama3. */
function selectModel({ hasImages }) {
  return hasImages ? VISION_CHAT_MODEL : 'llama3:latest';
}

function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch (_) {
      /* keep */
    }
    out[k] = v;
  });
  return out;
}

function isUuidLike(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  );
}

const USER_COOKIE = 'user_id';
const USER_COOKIE_MAX_AGE_SEC = 365 * 24 * 3600;

function userCookieMiddleware(req, res, next) {
  const jar = parseCookies(req.headers.cookie || '');
  let uid = jar[USER_COOKIE];
  if (!uid || !isUuidLike(uid)) {
    uid = crypto.randomUUID();
    const parts = [
      `${USER_COOKIE}=${encodeURIComponent(uid)}`,
      'Path=/',
      `Max-Age=${USER_COOKIE_MAX_AGE_SEC}`,
      'SameSite=Lax',
    ];
    res.append('Set-Cookie', parts.join('; '));
  }
  req.userId = uid;
  next();
}

const userTxnTail = new Map();
function userTxn(userId, fn) {
  const prev = userTxnTail.get(userId) || Promise.resolve();
  const next = prev.then(() => fn());
  userTxnTail.set(userId, next);
  return next;
}

function loadUserFile(userId) {
  const fp = path.join(DATA_USERS_DIR, `${userId}.json`);
  if (!fs.existsSync(fp)) return { chats: [], studioProjects: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!raw || typeof raw !== 'object') return { chats: [], studioProjects: [] };
    if (!Array.isArray(raw.chats)) raw.chats = [];
    if (!Array.isArray(raw.studioProjects)) raw.studioProjects = [];
    for (const p of raw.studioProjects) {
      if (!p || typeof p !== 'object') continue;
      if (!p.plan || typeof p.plan !== 'object') {
        p.plan = defaultStudioPlan();
      } else {
        if (typeof p.plan.markdown !== 'string') p.plan.markdown = '';
        if (!['none', 'draft', 'pending_approval', 'approved'].includes(p.plan.status)) {
          p.plan.status = 'none';
        }
        if (typeof p.plan.updatedAt !== 'number') p.plan.updatedAt = 0;
      }
      if (typeof p.taskStatus !== 'string') p.taskStatus = 'idle';
      if (typeof p.previewShareExpiresAt !== 'number' || !Number.isFinite(p.previewShareExpiresAt)) {
        delete p.previewShareExpiresAt;
      }
      if (p.studioHeadRevisionId != null && !isUuidLike(String(p.studioHeadRevisionId))) {
        delete p.studioHeadRevisionId;
      }
      normalizeStudioProjectTasks(p);
      normalizeStudioAgentChat(p);
    }
    return raw;
  } catch {
    return { chats: [], studioProjects: [] };
  }
}

function saveUserFile(userId, data) {
  const fp = path.join(DATA_USERS_DIR, `${userId}.json`);
  fs.mkdirSync(DATA_USERS_DIR, { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

/** Slug для URL и путей студии (латиница, дефисы). */
function slugifyStudioName(name) {
  const s = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'project';
}

function studioUniqueSlug(base, projects, excludeId) {
  let slug = base;
  let n = 2;
  while (projects.some((p) => p.slug === slug && p.id !== excludeId)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

function defaultStudioPlan() {
  return { markdown: '', status: 'none', updatedAt: 0 };
}

function roughPdfTextBuffer(buf) {
  const raw = buf.toString('latin1');
  const chunks = raw.match(/\((?:\\.|[^\\)])*\)/g) ?? [];
  const extracted = chunks
    .map((s) =>
      s
        .slice(1, -1)
        .replace(/\\([nrtbf()]|\\)/g, (_, x) => {
          if (x === 'n') return '\n';
          if (x === 't') return '\t';
          if (x === 'r') return '\r';
          return x;
        }),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return extracted.length >= 20 ? extracted.slice(0, 120_000) : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Вызов fetch к Ollama с повторами: сетевые ошибки и HTTP 502/504 — до attempts раз;
 * HTTP 503 без повторов (offline).
 */
async function fetchOllamaWithRetry(url, fetchOpts, attempts = OLLAMA_FETCH_ATTEMPTS) {
  const { method, headers, body } = fetchOpts;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(OLLAMA_FETCH_TIMEOUT_MS),
      });
      if (res.status === 503) return res;
      const retryHttp = res.status === 502 || res.status === 504;
      if (retryHttp && attempt < attempts - 1) {
        try {
          await res.text();
        } catch (_) {
          /* ignore */
        }
        await sleep(200 + attempt * 200);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        await sleep(200 + attempt * 200);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Один запрос к Ollama для streaming /api/generate (без retry).
 * Таймер только на этап ожидания заголовков; после resolve вызывающий код ставит таймер на first chunk.
 * @returns {{ response: Response, abort: () => void }}
 */
async function fetchOllamaStream(url, fetchOpts = {}) {
  const { signal: _ignored, ...rest } = fetchOpts;
  const controller = new AbortController();
  const headersTimer = setTimeout(() => controller.abort(), OLLAMA_STREAM_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...rest,
      signal: controller.signal,
    });
    clearTimeout(headersTimer);
    return {
      response,
      abort: () => controller.abort(),
    };
  } catch (err) {
    clearTimeout(headersTimer);
    throw err;
  }
}

/**
 * Отменить ReadableStream тела ответа fetch безопасно: после Readable.fromWeb поток locked,
 * вызов cancel() синхронно бросает или даёт rejected promise → падение процесса.
 */
function safeCancelFetchBody(body) {
  if (!body || typeof body.cancel !== 'function') return;
  try {
    if (body.locked) return;
    const ret = body.cancel();
    if (ret != null && typeof ret.catch === 'function') void ret.catch(() => {});
  } catch (_) {
    /* ignore */
  }
}

/** Кеш имён моделей из GET /api/tags (Ollama). */
let modelsCache = [];
let lastModelsFetch = 0;
const OLLAMA_MODELS_CACHE_MS = 10000;

async function getOllamaModels() {
  const now = Date.now();
  if (lastModelsFetch > 0 && now - lastModelsFetch < OLLAMA_MODELS_CACHE_MS) {
    return modelsCache;
  }

  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(Math.min(OLLAMA_FETCH_TIMEOUT_MS, 10000)),
    });
    lastModelsFetch = Date.now();
    if (!res.ok) {
      console.error('[MODEL] /api/tags HTTP', res.status);
      modelsCache = [];
      return modelsCache;
    }
    const data = await res.json();
    modelsCache = Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
    if (modelsCache.length) {
      console.log('[MODEL] installed:', modelsCache.join(', '));
    }
    return modelsCache;
  } catch (e) {
    console.error('[MODEL] tags fetch failed', e.message || e);
    lastModelsFetch = Date.now();
    modelsCache = [];
    return modelsCache;
  }
}

async function ensureModelAvailable(model) {
  const models = await getOllamaModels();

  if (models.length === 0) return;

  if (!models.includes(model)) {
    console.error('[MODEL] not found:', model);
    throw Object.assign(new Error('MODEL_NOT_FOUND'), { code: 'MODEL_NOT_FOUND' });
  }
}

/** Проверка /api/tags; при отсутствии модели — стабильный fallback на llama3:latest. */
async function resolveModel(model) {
  try {
    await ensureModelAvailable(model);
    return model;
  } catch {
    console.error('[MODEL] fallback → llama3');
    return 'llama3:latest';
  }
}

async function resolveVisionModel(primary) {
  const p = String(primary || '').trim();
  /** Запрошенная модель → более лёгкий Qwen VL → 7B → llava (всё из ALLOWED_MODELS). */
  const chain = [];
  const add = (x) => {
    if (x && !chain.includes(x)) chain.push(x);
  };
  add(p);
  if (p !== 'qwen2.5vl:3b') add('qwen2.5vl:3b');
  if (p !== 'qwen2.5vl:7b') add('qwen2.5vl:7b');
  add(LLAVA_MODEL);

  for (const m of chain) {
    if (!ALLOWED_SET.has(m)) continue;
    try {
      await ensureModelAvailable(m);
      if (m !== p) console.warn('[MODEL] vision fallback →', m);
      return m;
    } catch (_) {
      /* следующий кандидат */
    }
  }
  console.error('[MODEL] vision unavailable → llama3 (images будут отрезаны)');
  return 'llama3:latest';
}

/** Убираем images, только если модель не поддерживает мультимодальный /api/generate в Ollama. */
function modelSupportsVisionImages(modelName) {
  const raw = String(modelName || '');
  const m = raw.toLowerCase();
  if (m.includes('llava') || m.includes('bakllava')) return true;
  if (m.includes('moondream')) return true;
  if (m.includes('minicpm-v')) return true;
  if (m.includes('qwen') && m.includes('vl')) return true;
  if (/[:/_-]vl\b/.test(raw) || /\bvl\d/i.test(raw)) return true;
  return false;
}

function stripImagesIfUnsupported(payload, modelName) {
  if (!payload.images?.length) return;
  if (!modelSupportsVisionImages(modelName)) {
    delete payload.images;
    console.warn('[MODEL] stripped images for model', modelName);
  }
}

/** Текст ошибки Ollama про нехватку RAM (из HTTP body или NDJSON `error`). */
function isOllamaOutOfMemoryMessage(s) {
  const t = String(s || '').toLowerCase();
  return (
    t.includes('requires more system memory') ||
    t.includes('more system memory') ||
    t.includes('system memory')
  );
}

/** Из строки NDJSON ответа /api/generate. */
function ollamaErrorTextFromGenerateJson(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const e = obj.error;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  return '';
}

/** Кеш статуса Ollama для /api/health/ollama (обновление раз в OLLAMA_HEALTH_REFRESH_MS). */
let ollamaHealthCached = { status: 'offline', updatedAt: 0 };

async function refreshOllamaHealthCache() {
  try {
    const res = await fetchOllamaWithRetry(
      OLLAMA_URL,
      { method: 'GET', headers: {} },
      OLLAMA_FETCH_ATTEMPTS,
    );
    try {
      await res.text();
    } catch (_) {
      /* ignore */
    }
    ollamaHealthCached = {
      status: res.ok ? 'ok' : 'offline',
      updatedAt: Date.now(),
    };
  } catch {
    ollamaHealthCached = { status: 'offline', updatedAt: Date.now() };
  }
}

function rollbackAssistantMessage(userId, chatId, assistantMsgId) {
  return userTxn(userId, async () => {
    const data = loadUserFile(userId);
    const chat = data.chats.find((c) => c.id === chatId);
    if (!chat || !Array.isArray(chat.messages)) return;
    chat.messages = chat.messages.filter((m) => m.id !== assistantMsgId);
    chat.updatedAt = Date.now();
    saveUserFile(userId, data);
  });
}

function truncateChars(str, maxLen) {
  const s = typeof str === 'string' ? str : '';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 2))}\n…`;
}

/**
 * Единый промпт для мультимодального ответа (история + запрос + документы + подсказка по картинкам).
 * @param {{ role: string, content: string }[]} messages — уже обрезанная история (обычно последние 10)
 * @param {string} userMessage — текущий текст запроса без тела документов
 * @param {{ name: string, text: string }[]} docs — тексты вложений (каждый до MAX_DOC_CHARS_PER_FILE)
 * @param {number} imagesCount — число изображений во вложении
 */
function buildUnifiedPrompt({ messages, userMessage, docs, imagesCount }) {
  const safeMsgs = Array.isArray(messages) ? messages : [];
  const historyLines = safeMsgs.map((m) => `${m.role}: ${String(m.content || '')}`);
  const history = historyLines.join('\n').trim() || '(нет предыдущих реплик в этом окне)';

  const um = String(userMessage || '').trim() || '(без текстового запроса — опирайся на документы и изображения)';

  const docList = Array.isArray(docs) ? docs : [];
  const docsText = docList
    .map((d, i) => {
      const label = d.name ? `[${d.name}]` : `[Документ ${i + 1}]`;
      const body = truncateChars(String(d.text || ''), MAX_DOC_CHARS_PER_FILE);
      return `${label}\n${body}`;
    })
    .join('\n\n');

  const imgLine =
    imagesCount > 0 ? `Есть ${imagesCount} изображений — опиши и интерпретируй их содержание.` : '';

  const visionBlock =
    imagesCount > 0
      ? `
Опиши изображение по-русски: кто и что в кадре, фон, свет, цвета, заметный текст на картинке.
Не выдумывай детали. Без приветствий и официоза («уважаемый», «добрый день») — сразу по сути.
Формат: 6–12 маркированных пунктов или 2–3 связных абзаца. Обычные понятия только русскими словами, без англицизмов и транслита.
`.trim()
      : '';

  let prompt = `
Ты умный ассистент интерфейса на русском языке.

Язык ответа (обязательно): только русский литературный язык.
Отвечай по делу, без лишних обращений к «пользователю» и без шаблонных вступлений.
Не смешивай русский с польским, украинским суржиком и латиницей; не делай искусственного транслита.
Пиши связные грамотные предложения.

История:
${history}

Запрос пользователя:
${um}

${docList.length ? `Документы:\n${docsText}` : ''}

${imagesCount ? imgLine : ''}

${visionBlock ? `${visionBlock}\n` : ''}

Инструкция:

* анализируй всё вместе
* связывай текст, изображения и документы
* отвечай максимально точно и связно
* для акцентов можно использовать Markdown (**жирный**, списки)
`.trim();

  prompt = prompt.replace(/\n{3,}/g, '\n\n');

  if (prompt.length > MAX_UNIFIED_PROMPT_CHARS) {
    prompt = truncateChars(prompt, MAX_UNIFIED_PROMPT_CHARS);
  }

  return prompt;
}

function promptFromMessageRows(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n').trim();
}

const logsDir = path.join(__dirname, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const accessPath = path.join(logsDir, 'access.log');
const errorPath = path.join(logsDir, 'error.log');

const DATA_USERS_DIR = path.join(__dirname, 'data', 'users');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
/** Фаза 2: рабочие копии превью (не коммитить). Сборка в Docker — см. `studio-runner/Dockerfile`. */
const STUDIO_WORKSPACES_ROOT = path.join(__dirname, 'data', 'studio-workspaces');
const STUDIO_TEMPLATE_DIR = path.join(__dirname, 'studio-template');
const STUDIO_BUILD_TIMEOUT_MS = Number(process.env.STUDIO_BUILD_TIMEOUT_MS || 600000);
const STUDIO_DOCKER_IMAGE = (process.env.STUDIO_DOCKER_IMAGE || 'ollama-studio-runner:local').trim();
/** `auto` | `docker` | `host` — в `auto` при доступном Docker используется контейнер. */
const STUDIO_BUILD_EXECUTOR = (process.env.STUDIO_BUILD_EXECUTOR || 'auto').toLowerCase();
const STUDIO_DOCKER_MEMORY = (process.env.STUDIO_DOCKER_MEMORY || '2g').trim();
const STUDIO_DOCKER_CPUS = (process.env.STUDIO_DOCKER_CPUS || '2').trim();
/**
 * npm ci требует полного совпадения package.json и lock. Агент правит зависимости — lock устаревает.
 * По умолчанию для превью используем npm install. STUDIO_PREVIEW_USE_NPM_CI=1 — ci, если lock есть и санитизация не трогала package.json.
 */
const STUDIO_PREVIEW_USE_NPM_CI = String(process.env.STUDIO_PREVIEW_USE_NPM_CI || '').trim() === '1';
/** TTL подписанной ссылки /preview/... (мс), план §5.4–5.5. */
const STUDIO_PREVIEW_TTL_MS = Number(process.env.STUDIO_PREVIEW_TTL_MS || 45 * 60 * 1000);
const STUDIO_MAX_BUILDS_GLOBAL = Math.max(1, Number(process.env.STUDIO_MAX_BUILDS_GLOBAL || 20));
const STUDIO_MAX_BUILDS_PER_USER = Math.max(1, Number(process.env.STUDIO_MAX_BUILDS_PER_USER || 2));
const STUDIO_FILE_MAX_READ = Math.min(Number(process.env.STUDIO_FILE_MAX_READ || 1_500_000), 5_000_000);
const STUDIO_FILE_MAX_WRITE = Math.min(Number(process.env.STUDIO_FILE_MAX_WRITE || 1_500_000), 5_000_000);
const STUDIO_WORKSPACE_IGNORE = new Set(['node_modules', 'dist', '.git', '.vite', '.DS_Store']);
const STUDIO_REVISIONS_ROOT = path.join(__dirname, 'data', 'studio-revisions');
const STUDIO_REVISIONS_MAX_PER_PROJECT = Math.max(5, Number(process.env.STUDIO_REVISIONS_MAX_PER_PROJECT || 80));
const STUDIO_WORKSPACE_PATCH_MAX_OPS = Math.max(1, Number(process.env.STUDIO_WORKSPACE_PATCH_MAX_OPS || 50));
/** Лимит операций в одном ответе LLM при agent/implement (§6.1 pseudo-tool studio.patch_workspace). */
const STUDIO_AGENT_IMPLEMENT_MAX_OPS = Math.max(
  1,
  Math.min(STUDIO_WORKSPACE_PATCH_MAX_OPS, Number(process.env.STUDIO_AGENT_IMPLEMENT_MAX_OPS || 15)),
);
const STUDIO_AGENT_CODE_MODEL = (process.env.STUDIO_AGENT_CODE_MODEL || 'deepseek-coder:latest').trim();
/** После ошибки сборки: сколько раз вызвать LLM-патч и повторить npm run build (0 — без автопочинки). */
const STUDIO_BUILD_RECOVERY_MAX_ROUNDS = Math.max(
  0,
  Math.min(12, Number(process.env.STUDIO_BUILD_RECOVERY_MAX_ROUNDS ?? 3)),
);
const STUDIO_BUILD_RECOVERY_MAX_OPS = Math.max(
  1,
  Math.min(STUDIO_WORKSPACE_PATCH_MAX_OPS, Number(process.env.STUDIO_BUILD_RECOVERY_MAX_OPS ?? 25)),
);
/** Порядок облачных вызовов: см. STUDIO_LLM_ORDER_STREAM / STUDIO_LLM_ORDER_JSON / STUDIO_LLM_FALLBACK_ORDER в env. */
const STUDIO_CLOUD_MAX_TOKENS = Math.min(
  32768,
  Math.max(512, Number(process.env.STUDIO_CLOUD_MAX_TOKENS || 8192)),
);
/** Диапазон для lucide-react, если модель указала несуществующий (типично ^0.5.0). */
const STUDIO_NPM_LUCIDE_REACT = (process.env.STUDIO_NPM_LUCIDE_REACT || '^1.0.0').trim() || '^1.0.0';
/** Неверные ключи в dependencies/devDependencies (на npm другое имя). */
const STUDIO_NPM_PACKAGE_KEY_FIXES = {
  'tailwind-css': 'tailwindcss',
  tailwind_css: 'tailwindcss',
  /** Галлюцинация LLM (пакета нет в registry). */
  'react-reliable': 'react',
  'react-reliabel': 'react',
  'react-relyable': 'react',
};
/** Если модель указала несуществующую ветку framer-motion (напр. ^4.84.0). */
const STUDIO_FRAMER_MOTION_FALLBACK =
  (process.env.STUDIO_FRAMER_MOTION_FALLBACK || '^11.0.0').trim() || '^11.0.0';
/** Если модель запросила несуществующий patch tailwind v3 (напр. ^3.12.1). */
const STUDIO_TAILWIND_V3_FALLBACK = (process.env.STUDIO_TAILWIND_V3_FALLBACK || '^3.4.17').trim() || '^3.4.17';
fs.mkdirSync(DATA_USERS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(STUDIO_WORKSPACES_ROOT, { recursive: true });
fs.mkdirSync(STUDIO_REVISIONS_ROOT, { recursive: true });

/** @type {Set<string>} */
const studioBuildInProgress = new Set();

function studioLockKey(userId, projectId) {
  return `${userId}:${projectId}`;
}

function studioWorkspaceDir(userId, projectId) {
  return path.join(STUDIO_WORKSPACES_ROOT, userId, projectId);
}

function ensureStudioWorkspaceScaffold(userId, projectId) {
  const ws = studioWorkspaceDir(userId, projectId);
  const marker = path.join(ws, 'package.json');
  if (fs.existsSync(marker)) return ws;
  fs.mkdirSync(ws, { recursive: true });
  if (!fs.existsSync(STUDIO_TEMPLATE_DIR)) {
    throw new Error('studio_template_missing');
  }
  fs.cpSync(STUDIO_TEMPLATE_DIR, ws, {
    recursive: true,
    filter: (src) => {
      const normalized = src.replace(/\\/g, '/');
      return !normalized.includes('/node_modules/') && !normalized.endsWith('/node_modules');
    },
  });
  return ws;
}

/**
 * У lucide-react версии вида 0.4xx/0.5xx; диапазон ^0.5.0 в semver означает <0.6.0 и даёт пустое множество на npm (ETARGET).
 */
function studioLucideReactRangeLooksInvalid(range) {
  const raw = String(range || '').trim();
  if (!raw) return true;
  const v = raw.replace(/^(\^|~|>=|>|<=|<|=|\s)+/, '');
  if (/^0\.5\./.test(v)) return true;
  const m = /^0\.(\d+)\./.exec(v);
  if (m) {
    const minor = parseInt(m[1], 10);
    if (minor > 0 && minor < 100) return true;
  }
  return false;
}

let studioTemplatePkgCache = null;
function studioReadTemplatePackageJson() {
  if (studioTemplatePkgCache) return studioTemplatePkgCache;
  const fp = path.join(STUDIO_TEMPLATE_DIR, 'package.json');
  try {
    studioTemplatePkgCache = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    studioTemplatePkgCache = null;
  }
  return studioTemplatePkgCache;
}

/** Удаляет обратный слэш перед недопустимой в JSON escape-последовательностью (модель пишет \\w и т.д.). */
function studioRepairInvalidJsonBackslashes(s) {
  let t = s;
  for (let i = 0; i < 24; i++) {
    const next = t.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '');
    if (next === t) break;
    t = next;
  }
  return t;
}

function studioRenameMalformedNpmPackageKeys(pkg) {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  let changed = false;
  for (const sec of sections) {
    const o = pkg[sec];
    if (!o || typeof o !== 'object') continue;
    for (const [bad, good] of Object.entries(STUDIO_NPM_PACKAGE_KEY_FIXES)) {
      if (typeof o[bad] !== 'string') continue;
      const v = o[bad];
      delete o[bad];
      if (typeof o[good] !== 'string') o[good] = v;
      changed = true;
    }
  }
  return changed;
}

function studioDropBogusDependencies(pkg) {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  let changed = false;
  for (const sec of sections) {
    const o = pkg[sec];
    if (!o || typeof o !== 'object') continue;
    if (typeof o.test === 'string' && /juest/i.test(o.test)) {
      delete o.test;
      changed = true;
    }
  }
  return changed;
}

/** Символы вне допустимого для диапазона версий npm + типичный мусор LLM (W^…], кавычки). */
function studioScrubNpmVersionValue(ver) {
  let s = String(ver || '').trim();
  s = s.replace(/[[\]`'"]/g, '');
  s = s.replace(/^[^\d^~<>=]+/u, '');
  return s.trim();
}

function studioScrubAllDependencyVersionRanges(pkg) {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  let changed = false;
  for (const sec of sections) {
    const o = pkg[sec];
    if (!o || typeof o !== 'object') continue;
    for (const k of Object.keys(o)) {
      if (typeof o[k] !== 'string') continue;
      const n = studioScrubNpmVersionValue(o[k]);
      if (n !== o[k]) {
        o[k] = n;
        changed = true;
      }
    }
  }
  return changed;
}

/** В линии tailwind v3 не было 3.11+; типичная галлюцинация ^3.12.1. */
function studioNormalizeTailwindcssVersion(ver) {
  const s = studioScrubNpmVersionValue(ver);
  if (!s) return STUDIO_TAILWIND_V3_FALLBACK;
  if (/^[\^~]?\s*4\./.test(s)) return s;
  if (/3\.(1[1-9]|[2-9]\d)(\.\d+)?/i.test(s)) return STUDIO_TAILWIND_V3_FALLBACK;
  return s;
}

function studioNormalizeLucideReactVersion(ver) {
  let s = studioScrubNpmVersionValue(ver);
  if (!s || !/[\d]/.test(s)) return STUDIO_NPM_LUCIDE_REACT;
  if (studioLucideReactRangeLooksInvalid(s)) return STUDIO_NPM_LUCIDE_REACT;
  return s;
}

/** В линии v4 на npm есть только 4.0.x–4.1.x; ^4.84.0 и т.п. дают ETARGET. */
function studioNormalizeFramerMotionVersion(ver) {
  const s = studioScrubNpmVersionValue(ver);
  if (!s) return s;
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (m) {
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    const patch = m[3] !== undefined ? parseInt(m[3], 10) : 0;
    if (major === 4 && (minor > 1 || (minor === 1 && patch > 17))) return STUDIO_FRAMER_MOTION_FALLBACK;
  }
  return s;
}

function studioEnsurePackageScripts(pkg) {
  const tpl = studioReadTemplatePackageJson();
  if (!tpl || !tpl.scripts || typeof tpl.scripts !== 'object') return false;
  if (!pkg.scripts || typeof pkg.scripts !== 'object') pkg.scripts = {};
  let changed = false;
  if (!String(pkg.scripts.build || '').trim()) {
    pkg.scripts.build = typeof tpl.scripts.build === 'string' ? tpl.scripts.build : 'vite build';
    changed = true;
  }
  if (!String(pkg.scripts.dev || '').trim() && typeof tpl.scripts.dev === 'string') {
    pkg.scripts.dev = tpl.scripts.dev;
    changed = true;
  }
  return changed;
}

/** Удаляет production=true / omit=dev из .npmrc в workspace (иначе npm отрезает devDeps — нет vite). */
function studioSanitizeWorkspaceNpmrc(wsRoot) {
  const fp = path.join(wsRoot, '.npmrc');
  if (!fs.existsSync(fp)) return false;
  let raw;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch {
    return false;
  }
  const lines = raw.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return true;
    if (/^production\s*=\s*true\s*$/i.test(t)) return false;
    if (/^omit\s*=\s*dev\s*$/i.test(t)) return false;
    if (/^omit\[\]\s*=\s*dev\s*$/i.test(t)) return false;
    return true;
  });
  const next = kept.join('\n');
  if (next === raw) return false;
  fs.writeFileSync(fp, `${next.endsWith('\n') ? next.slice(0, -1) : next}\n`, 'utf8');
  logAccess(`STUDIO_NPMRC_SANITIZE ${wsRoot}`);
  return true;
}

/**
 * Превью раздаётся под /preview/<token>/; при Vite base: '/' в index.html идут /assets/... с корня домена → 404 и белый iframe.
 */
function studioWorkspaceUsesVite(wsRoot) {
  const fp = path.join(wsRoot, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return false;
  }
  const s = `${pkg.scripts?.build || ''} ${pkg.scripts?.dev || ''} ${pkg.scripts?.preview || ''}`;
  return /\bvite\b/.test(s) || Boolean(pkg.dependencies?.vite || pkg.devDependencies?.vite);
}

function studioPatchViteConfigContent(raw) {
  if (/base\s*:\s*['"]\.\/?['"]/.test(raw)) return raw;
  let next = raw;
  if (/base\s*:/.test(next)) {
    next = next.replace(/base\s*:\s*['"`][^'"`]*['"`]/g, "base: './'");
    if (/base\s*:/.test(next) && !/base\s*:\s*['"]\.\/?['"]/.test(next)) {
      next = next.replace(/base\s*:\s*[^,\r\n}\]]+/g, "base: './'");
    }
  }
  if (!/base\s*:/.test(next)) {
    if (/defineConfig\s*\(\s*\{/.test(next)) {
      next = next.replace(/defineConfig\s*\(\s*\{/, "defineConfig({\n  base: './',");
    } else if (/export\s+default\s*\{/.test(next)) {
      next = next.replace(/export\s+default\s*\{/, "export default {\n  base: './',");
    }
  }
  return next;
}

/** Перед сборкой: base: './' в vite.config.* или копия шаблона, если конфига нет. */
function studioEnsureViteRelativeBase(wsRoot) {
  if (!studioWorkspaceUsesVite(wsRoot)) return false;
  const names = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
  let changed = false;
  let found = false;
  for (const name of names) {
    const fp = path.join(wsRoot, name);
    if (!fs.existsSync(fp)) continue;
    found = true;
    let raw;
    try {
      raw = fs.readFileSync(fp, 'utf8');
    } catch {
      continue;
    }
    const next = studioPatchViteConfigContent(raw);
    if (next !== raw) {
      fs.writeFileSync(fp, next, 'utf8');
      changed = true;
      logAccess(`STUDIO_VITE_BASE_RELATIVE ${name} ${wsRoot}`);
    }
  }
  if (!found) {
    const tpl = path.join(STUDIO_TEMPLATE_DIR, 'vite.config.ts');
    if (fs.existsSync(tpl)) {
      try {
        fs.copyFileSync(tpl, path.join(wsRoot, 'vite.config.ts'));
        changed = true;
        logAccess(`STUDIO_VITE_BASE_RELATIVE template vite.config.ts ${wsRoot}`);
      } catch {
        /* */
      }
    }
  }
  return changed;
}

/** Пины vite + @vitejs/plugin-react + typescript из шаблона (снимает vite@3 + plugin@4). */
function studioEnsureViteToolchain(pkg) {
  const tpl = studioReadTemplatePackageJson();
  if (!tpl?.devDependencies || typeof tpl.devDependencies !== 'object') return false;
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const joined = `${String(scripts.build || '')} ${String(scripts.dev || '')} ${String(scripts.preview || '')}`;
  const usesViteScript = /\bvite\b/.test(joined);
  const hasViteishDep = Boolean(
    pkg.dependencies?.vite ||
      pkg.devDependencies?.vite ||
      pkg.dependencies?.['@vitejs/plugin-react'] ||
      pkg.devDependencies?.['@vitejs/plugin-react'] ||
      pkg.dependencies?.tailwindcss ||
      pkg.devDependencies?.tailwindcss,
  );
  if (!usesViteScript && !hasViteishDep) return false;

  if (!pkg.devDependencies || typeof pkg.devDependencies !== 'object') pkg.devDependencies = {};
  let changed = false;
  const need = ['vite', '@vitejs/plugin-react', 'typescript'];
  for (const name of need) {
    const vtpl = tpl.devDependencies[name];
    if (typeof vtpl !== 'string') continue;
    if (pkg.devDependencies[name] !== vtpl) {
      pkg.devDependencies[name] = vtpl;
      changed = true;
    }
    if (pkg.dependencies && typeof pkg.dependencies[name] === 'string') {
      delete pkg.dependencies[name];
      changed = true;
    }
  }
  return changed;
}

/**
 * Vite + plugin-react без react/react-dom в dependencies → Rollup: cannot resolve "react-dom/client".
 * Добавляет недостающие пакеты из studio-template; убирает их из devDependencies.
 */
function studioEnsureReactRuntimeDeps(pkg) {
  const tpl = studioReadTemplatePackageJson();
  if (!tpl?.dependencies || typeof tpl.dependencies !== 'object') return false;
  const hasReactPlugin = Boolean(
    pkg.devDependencies?.['@vitejs/plugin-react'] || pkg.dependencies?.['@vitejs/plugin-react'],
  );
  const hasReactish = Boolean(
    pkg.dependencies?.react ||
      pkg.devDependencies?.react ||
      pkg.dependencies?.['react-dom'] ||
      pkg.devDependencies?.['react-dom'],
  );
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const scriptsStr = `${String(scripts.build || '')} ${String(scripts.dev || '')} ${String(scripts.preview || '')}`;
  const usesVite = /\bvite\b/.test(scriptsStr);
  const hasViteDep = Boolean(pkg.dependencies?.vite || pkg.devDependencies?.vite);
  if (!hasReactPlugin && !(hasReactish && (usesVite || hasViteDep))) return false;

  if (!pkg.dependencies || typeof pkg.dependencies !== 'object') pkg.dependencies = {};
  let changed = false;
  for (const name of ['react', 'react-dom']) {
    const want = tpl.dependencies[name];
    if (typeof want !== 'string' || !want.trim()) continue;
    const cur = pkg.dependencies[name];
    if (typeof cur !== 'string' || !studioScrubNpmVersionValue(cur)) {
      pkg.dependencies[name] = want;
      changed = true;
    }
    if (pkg.devDependencies && typeof pkg.devDependencies === 'object' && pkg.devDependencies[name]) {
      delete pkg.devDependencies[name];
      changed = true;
    }
  }
  return changed;
}

/** Удаляет управляющие символы из всех строк в дереве package.json (LLM иногда вставляет U+0012 в версии). */
function studioStripControlCharsFromPackageJsonStrings(pkg) {
  const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  let changed = false;
  function walk(x) {
    if (x == null || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        if (typeof v === 'string') {
          const n = v.replace(CTRL, '');
          if (n !== v) {
            x[i] = n;
            changed = true;
          }
        } else {
          walk(v);
        }
      }
      return;
    }
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (typeof v === 'string') {
        const n = v.replace(CTRL, '');
        if (n !== v) {
          x[k] = n;
          changed = true;
        }
      } else {
        walk(v);
      }
    }
  }
  walk(pkg);
  return changed;
}

/** После vite build: вычищает остатки /assets/ в index и чанках (если base не применился). */
function studioRewriteBuiltPreviewAbsolutes(distRoot) {
  if (!distRoot || !fs.existsSync(distRoot)) return;
  const idx = path.join(distRoot, 'index.html');
  if (fs.existsSync(idx)) {
    let html = fs.readFileSync(idx, 'utf8');
    const next = html
      .replace(/(src|href)=(["'])\/assets\//gi, '$1=$2./assets/')
      .replace(/(src|href)=(["'])\/vite\//gi, '$1=$2./vite/');
    if (next !== html) {
      fs.writeFileSync(idx, next, 'utf8');
      logAccess(`STUDIO_DIST_REWRITE index.html ${distRoot}`);
    }
  }
  const assetsDir = path.join(distRoot, 'assets');
  if (fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) {
    for (const name of fs.readdirSync(assetsDir)) {
      if (!name.endsWith('.js') && !name.endsWith('.mjs') && !name.endsWith('.css')) continue;
      const fp = path.join(assetsDir, name);
      let s;
      try {
        s = fs.readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      const o = s;
      s = s.replace(/(["'`])\/assets\//g, '$1./assets/');
      s = s.replace(/(["'`])\/vite\//g, '$1./vite/');
      if (s !== o) {
        fs.writeFileSync(fp, s, 'utf8');
        logAccess(`STUDIO_DIST_REWRITE ${name}`);
      }
    }
  }
}

/** Модель иногда пишет "a" - "b" в массиве вместо "a", "b". */
function studioRepairHyphenBetweenJsonStrings(s) {
  let t = s;
  for (let i = 0; i < 32; i++) {
    const next = t.replace(/("(?:[^"\\]|\\.)*")\s*-\s*("(?:[^"\\]|\\.)*")/g, '$1, $2');
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Если package.json битый (не парсится) — убираем управляющие символы из текста и перезаписываем.
 * Возвращает true, если файл изменён (нужен npm install, lock удаляется).
 */
function studioRepairCorruptWorkspacePackageJson(wsRoot) {
  const fp = path.join(wsRoot, 'package.json');
  if (!fs.existsSync(fp)) return false;
  let raw = fs.readFileSync(fp, 'utf8');
  if (raw.length && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    JSON.parse(raw);
    return false;
  } catch {
    /* */
  }
  const stripped = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, '')
    .replace(/\uFEFF/g, '');
  const candidates = [
    stripped,
    studioRepairHyphenBetweenJsonStrings(stripped),
    studioRepairInvalidJsonBackslashes(stripped),
    studioRepairInvalidJsonBackslashes(studioRepairHyphenBetweenJsonStrings(stripped)),
    studioRepairHyphenBetweenJsonStrings(studioRepairInvalidJsonBackslashes(stripped)),
  ];
  let pkg = null;
  for (const body of candidates) {
    try {
      const p = JSON.parse(body);
      if (p && typeof p === 'object') {
        pkg = p;
        break;
      }
    } catch {
      /* */
    }
  }
  if (!pkg) return false;
  studioStripControlCharsFromPackageJsonStrings(pkg);
  fs.writeFileSync(fp, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  try {
    const lock = path.join(wsRoot, 'package-lock.json');
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  } catch {
    /* */
  }
  logAccess(`STUDIO_PACKAGE_JSON_REPAIR corrupt-json ${wsRoot}`);
  return true;
}

/**
 * Исправляет типичные галлюцинации в package.json перед npm ci/install. Возвращает true, если lockfile нужно пересобрать.
 */
function studioSanitizeWorkspacePackageJson(wsRoot) {
  const fp = path.join(wsRoot, 'package.json');
  if (!fs.existsSync(fp)) return false;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return false;
  }
  if (!pkg || typeof pkg !== 'object') return false;
  let changed = studioStripControlCharsFromPackageJsonStrings(pkg);
  changed = studioRenameMalformedNpmPackageKeys(pkg) || changed;
  changed = studioDropBogusDependencies(pkg) || changed;
  changed = studioScrubAllDependencyVersionRanges(pkg) || changed;
  changed = studioEnsurePackageScripts(pkg) || changed;
  changed = studioEnsureViteToolchain(pkg) || changed;
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  for (const sec of sections) {
    const o = pkg[sec];
    if (!o || typeof o !== 'object') continue;
    if (typeof o['licide-react'] === 'string') {
      const v = o['licide-react'];
      delete o['licide-react'];
      if (typeof o['lucide-react'] !== 'string') o['lucide-react'] = v;
      changed = true;
    }
    if (typeof o['tailwindcss'] === 'string') {
      const n = studioNormalizeTailwindcssVersion(o['tailwindcss']);
      if (n !== o['tailwindcss']) {
        o['tailwindcss'] = n;
        changed = true;
      }
    }
    if (typeof o['lucide-react'] === 'string') {
      const n = studioNormalizeLucideReactVersion(o['lucide-react']);
      const fin = studioLucideReactRangeLooksInvalid(n) ? STUDIO_NPM_LUCIDE_REACT : n;
      if (fin !== o['lucide-react']) {
        o['lucide-react'] = fin;
        changed = true;
      }
    }
    if (typeof o['framer-motion'] === 'string') {
      const n = studioNormalizeFramerMotionVersion(o['framer-motion']);
      if (n && n !== o['framer-motion']) {
        o['framer-motion'] = n;
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(fp, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    const lock = path.join(wsRoot, 'package-lock.json');
    try {
      if (fs.existsSync(lock)) fs.unlinkSync(lock);
    } catch {
      /* */
    }
    logAccess(`STUDIO_PACKAGE_SANITIZE ${wsRoot}`);
  }
  return changed;
}

function studioWorkspaceHasNpmLockfile(wsRoot) {
  return (
    fs.existsSync(path.join(wsRoot, 'package-lock.json')) ||
    fs.existsSync(path.join(wsRoot, 'npm-shrinkwrap.json'))
  );
}

function studioSanitizeRelativePath(relRaw) {
  const s = String(relRaw || '').replace(/\\/g, '/');
  const parts = s.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

function studioResolveWorkspacePath(wsRoot, relPortable) {
  const root = path.resolve(wsRoot);
  const joined = path.resolve(path.join(root, ...relPortable.split('/')));
  if (joined !== root && !joined.startsWith(root + path.sep)) return null;
  return joined;
}

function studioListWorkspaceFiles(wsRoot) {
  const out = [];
  function walk(dir, prefix) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (STUDIO_WORKSPACE_IGNORE.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(fp, rel);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(fp);
          out.push({ path: rel, type: 'file', size: st.size, mtime: st.mtimeMs });
        } catch {
          /* */
        }
      }
    }
  }
  walk(path.resolve(wsRoot), '');
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out.slice(0, 800);
}

function studioRevisionDir(userId, projectId) {
  return path.join(STUDIO_REVISIONS_ROOT, userId, projectId);
}

function studioTarWorkspaceToFile(wsRoot, destGz) {
  const ws = path.resolve(wsRoot);
  const out = path.resolve(destGz);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(
    'tar',
    ['-czf', out, '--exclude=node_modules', '--exclude=dist', '--exclude=.git', '-C', ws, '.'],
    { encoding: 'utf8', maxBuffer: 10_000_000 },
  );
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim() || `tar exit ${r.status}`;
    throw new Error(msg);
  }
}

function studioReadRevisionMetaFile(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function studioListRevisionMetas(revDir) {
  if (!fs.existsSync(revDir)) return [];
  const names = fs.readdirSync(revDir).filter((n) => n.endsWith('.meta.json'));
  const out = [];
  for (const n of names) {
    const m = studioReadRevisionMetaFile(path.join(revDir, n));
    if (m && m.id) out.push(m);
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

/** Фаза 1: ограничение числа snapshотов на проект (старые meta+tar.gz удаляются). */
function studioPruneOldRevisions(revDir) {
  const metas = studioListRevisionMetas(revDir);
  if (metas.length <= STUDIO_REVISIONS_MAX_PER_PROJECT) return;
  const toRemove = metas.slice(STUDIO_REVISIONS_MAX_PER_PROJECT);
  for (const m of toRemove) {
    const arch = m.archiveFile || `${m.id}.tar.gz`;
    try {
      fs.unlinkSync(path.join(revDir, `${m.id}.meta.json`));
    } catch {
      /* */
    }
    try {
      fs.unlinkSync(path.join(revDir, arch));
    } catch {
      /* */
    }
  }
}

/** Путь тома для `docker -v` (Windows → стиль /c/... для Docker Desktop). */
function hostPathForDockerVolume(absPath) {
  const abs = path.resolve(absPath);
  if (process.platform !== 'win32') return abs;
  const m = /^([A-Za-z]):[/\\](.*)$/.exec(abs);
  if (!m) return abs;
  const rest = m[2].split(/[/\\]/).filter(Boolean).join('/');
  return `/${m[1].toLowerCase()}/${rest}`;
}

function dockerDaemonReachable() {
  try {
    const r = spawnSync('docker', ['info'], {
      stdio: 'ignore',
      timeout: 12000,
      encoding: 'utf8',
    });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

/** @returns {'docker' | 'host'} */
function resolveStudioExecutor() {
  if (STUDIO_BUILD_EXECUTOR === 'host') return 'host';
  if (STUDIO_BUILD_EXECUTOR === 'docker') {
    if (!dockerDaemonReachable()) {
      logError('STUDIO_BUILD_EXECUTOR=docker but Docker is not available; falling back to host npm');
      return 'host';
    }
    return 'docker';
  }
  if (dockerDaemonReachable()) return 'docker';
  return 'host';
}

function runNpmInDocker(cwd, npmArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mountSrc = hostPathForDockerVolume(cwd);
    const dockerArgs = ['run', '--rm'];
    const dockerNet = (process.env.STUDIO_DOCKER_NETWORK || '').trim();
    if (dockerNet) dockerArgs.push('--network', dockerNet);
    /** Образ `node` часто завершается на `USER node` (uid 1000); workspace создаёт процесс API (`www-data` и т.д.). Совмещаем uid/gid с API, иначе npm на смонтированном томе — EACCES. */
    const dockerUserExplicit = (process.env.STUDIO_DOCKER_USER || '').trim();
    let dockerMatchHostOwner = false;
    if (process.platform !== 'win32') {
      if (dockerUserExplicit) {
        dockerArgs.push('--user', dockerUserExplicit);
        dockerMatchHostOwner = true;
      } else {
        try {
          const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
          const gid = typeof process.getgid === 'function' ? process.getgid() : -1;
          if (uid >= 0 && gid >= 0) {
            dockerArgs.push('--user', `${uid}:${gid}`);
            dockerMatchHostOwner = true;
          }
        } catch {
          /* */
        }
      }
    }
    if (dockerMatchHostOwner) {
      const u0 = dockerUserExplicit
        ? Number((dockerUserExplicit.split(':')[0] || '').trim())
        : typeof process.getuid === 'function'
          ? process.getuid()
          : 0;
      if (!Number.isFinite(u0) || u0 !== 0) {
        dockerArgs.push('-e', 'HOME=/tmp');
      }
    }
    dockerArgs.push(
      '--pull',
      'missing',
      '-v',
      `${mountSrc}:/workspace`,
      '-w',
      '/workspace',
      '--memory',
      STUDIO_DOCKER_MEMORY,
      '--cpus',
      STUDIO_DOCKER_CPUS,
      '--pids-limit',
      '256',
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      '-e',
      'NPM_CONFIG_PRODUCTION=false',
      '-e',
      'NODE_ENV=development',
      '-e',
      'CI=1',
      '-e',
      'NPM_CONFIG_UPDATE_NOTIFIER=false',
      STUDIO_DOCKER_IMAGE,
      'npm',
      ...npmArgs,
    );
    const child = spawn('docker', dockerArgs, {
      shell: false,
      env: process.env,
    });
    let log = '';
    const push = (d) => {
      log += d.toString();
      if (log.length > 200000) log = log.slice(-100000);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (_) {
            /* ignore */
          }
        }, 8000);
      } catch (_) {
        /* ignore */
      }
      resolve({ code: -1, log: `${log}\n[studio docker build timeout ${timeoutMs}ms]` });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, log });
    });
  });
}

function runNpmInWorkspace(cwd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        CI: '1',
        NODE_ENV: 'development',
        NPM_CONFIG_PRODUCTION: 'false',
      },
    });
    let log = '';
    const push = (d) => {
      log += d.toString();
      if (log.length > 200000) log = log.slice(-100000);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (_) {
            /* ignore */
          }
        }, 8000);
      } catch (_) {
        /* ignore */
      }
      resolve({ code: -1, log: `${log}\n[studio build timeout ${timeoutMs}ms]` });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, log });
    });
  });
}

function studioWritePlanArtifact(userId, projectId, markdown) {
  const ws = studioWorkspaceDir(userId, projectId);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'STUDIO_PLAN.md'),
    String(markdown || '').slice(0, 100000),
    'utf8',
  );
}

async function persistStudioBuildResult(userId, projectId, ok, exitCode, log, executor) {
  await userTxn(userId, async () => {
    const data = loadUserFile(userId);
    const p = data.studioProjects.find((x) => x.id === projectId);
    if (!p) return;
    p.lastBuild = {
      at: Date.now(),
      ok: !!ok,
      exitCode,
      executor: executor === 'docker' || executor === 'host' ? executor : undefined,
      log: String(log || '').slice(-14000),
    };
    p.taskStatus = ok ? 'ready_for_review' : 'failed';
    p.updatedAt = Date.now();
    if (ok) {
      p.previewShareExpiresAt = Date.now() + STUDIO_PREVIEW_TTL_MS;
    } else {
      delete p.previewShareExpiresAt;
    }
    saveUserFile(userId, data);
  });
}

async function runStudioPreviewBuildAttempt(userId, projectId, runNpm, executor) {
  const ws = ensureStudioWorkspaceScaffold(userId, projectId);
  const data = loadUserFile(userId);
  const project = data.studioProjects.find((p) => p.id === projectId);
  const planMd = project?.plan?.markdown || '';
  if (planMd) studioWritePlanArtifact(userId, projectId, planMd);

  const npmrcSanitized = studioSanitizeWorkspaceNpmrc(ws);
  const pkgRepaired = studioRepairCorruptWorkspacePackageJson(ws);
  const pkgSanitized = studioSanitizeWorkspacePackageJson(ws);
  const viteBaseOk = studioEnsureViteRelativeBase(ws);
  const lockPresent = studioWorkspaceHasNpmLockfile(ws);
  const useNpmInstall =
    !STUDIO_PREVIEW_USE_NPM_CI ||
    pkgRepaired ||
    pkgSanitized ||
    !lockPresent ||
    npmrcSanitized;
  const headerExtra = [
    !STUDIO_PREVIEW_USE_NPM_CI ? '[studio] npm install (по умолчанию: lock подстраивается под package.json)' : null,
    npmrcSanitized ? '[studio] очищен .npmrc (production/omit=dev)' : null,
    pkgRepaired ? '[studio] исправлен повреждённый package.json (управляющие символы)' : null,
    pkgSanitized ? '[studio] скорректирован package.json (typos/ lucide); lock пересоздаётся' : null,
    viteBaseOk ? "[studio] vite base → './' (ассеты превью под /preview/…)" : null,
    lockPresent && useNpmInstall && STUDIO_PREVIEW_USE_NPM_CI ? '[studio] переключение на npm install' : null,
    !lockPresent && !pkgSanitized && !pkgRepaired ? '[studio] нет package-lock.json — выполняется npm install' : null,
  ]
    .filter(Boolean)
    .join('\n');
  const header = `${headerExtra ? `${headerExtra}\n` : ''}[studio executor=${executor} image=${executor === 'docker' ? STUDIO_DOCKER_IMAGE : 'n/a'}]\n`;
  const npmInstallCmd = useNpmInstall
    ? ['install', '--no-audit', '--no-fund', '--include=dev', '--legacy-peer-deps']
    : ['ci', '--no-audit', '--no-fund', '--include=dev', '--legacy-peer-deps'];
  const r1 = await runNpm(ws, npmInstallCmd, STUDIO_BUILD_TIMEOUT_MS);
  const r1Label = useNpmInstall ? '=== npm install ===' : '=== npm ci ===';
  if (r1.code !== 0) {
    return { ok: false, exitCode: r1.code, chunk: `${header}${r1Label}\n${r1.log}` };
  }
  const r2 = await runNpm(ws, ['run', 'build'], STUDIO_BUILD_TIMEOUT_MS);
  if (r2.code === 0) {
    try {
      studioRewriteBuiltPreviewAbsolutes(path.join(ws, 'dist'));
    } catch (e) {
      logError(`STUDIO_DIST_REWRITE ${e.message}`);
    }
  }
  const combined = `${header}${r1Label}\n${r1.log}\n=== npm run build ===\n${r2.log}`;
  return { ok: r2.code === 0, exitCode: r2.code || 0, chunk: combined };
}

async function executeStudioPreviewBuild(userId, projectId) {
  const key = studioLockKey(userId, projectId);
  const executor = resolveStudioExecutor();
  const runNpm =
    executor === 'docker'
      ? (cwd, args, ms) => runNpmInDocker(cwd, args, ms)
      : (cwd, args, ms) => runNpmInWorkspace(cwd, args, ms);
  const logs = [];
  try {
    for (let recoveryRound = 0; ; recoveryRound += 1) {
      const attempt = await runStudioPreviewBuildAttempt(userId, projectId, runNpm, executor);
      logs.push(`=== сборка (попытка ${recoveryRound + 1}) ===\n${attempt.chunk}`);
      if (attempt.ok) {
        await persistStudioBuildResult(userId, projectId, true, 0, logs.join('\n\n'), executor);
        return;
      }
      if (recoveryRound >= STUDIO_BUILD_RECOVERY_MAX_ROUNDS) {
        await persistStudioBuildResult(userId, projectId, false, attempt.exitCode, logs.join('\n\n'), executor);
        return;
      }
      if (!studioLlmUpstreamAvailable()) {
        logs.push('[studio] автопочинка пропущена: нет Ollama и облачных ключей для JSON-модели');
        await persistStudioBuildResult(userId, projectId, false, attempt.exitCode, logs.join('\n\n'), executor);
        return;
      }
      const rec = await studioTryRecoverWorkspaceFromBuildLog(userId, projectId, attempt.chunk);
      logs.push(`=== агент: правки после ошибки (раунд ${recoveryRound + 1}) ===\n${rec.note}`);
      if (!rec.applied) {
        await persistStudioBuildResult(userId, projectId, false, attempt.exitCode, logs.join('\n\n'), executor);
        return;
      }
    }
  } catch (e) {
    logError(`STUDIO_BUILD ${userId} ${projectId} ${e.stack || e.message}`);
    logs.push(`[studio exception]\n${String(e.message || e)}`);
    await persistStudioBuildResult(userId, projectId, false, -2, logs.join('\n\n'), executor);
  } finally {
    studioBuildInProgress.delete(key);
  }
}

function writeLine(file, line) {
  fs.appendFile(file, `${new Date().toISOString()} ${line}\n`, (err) => {
    if (err) console.error('log write failed', err.message);
  });
}

function logAccess(line) {
  writeLine(accessPath, line);
}

function logError(line) {
  writeLine(errorPath, line);
}

let studioPreviewSecretCached = null;
function studioPreviewSecret() {
  if (studioPreviewSecretCached) return studioPreviewSecretCached;
  let s = String(process.env.STUDIO_PREVIEW_SECRET || '').trim();
  if (s.length < 16) {
    s = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[studio] STUDIO_PREVIEW_SECRET unset or short; using ephemeral secret (restart invalidates /preview links). Set STUDIO_PREVIEW_SECRET in production.',
    );
  }
  studioPreviewSecretCached = s;
  return studioPreviewSecretCached;
}

/** @param {{ u: string, p: string, e: number }} payload */
function signStudioPreviewToken(payload) {
  const tw = JSON.stringify(payload);
  const payloadB64 = Buffer.from(tw, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', studioPreviewSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/** @returns {{ userId: string, projectId: string, exp: number } | null} */
function verifyStudioPreviewToken(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const payloadB64 = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', studioPreviewSecret()).update(payloadB64).digest('base64url');
  const sb = Buffer.from(sig, 'utf8');
  const eb = Buffer.from(expected, 'utf8');
  if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object') return null;
    if (!isUuidLike(obj.u) || !isUuidLike(obj.p) || typeof obj.e !== 'number') return null;
    if (Date.now() > obj.e) return null;
    return { userId: obj.u, projectId: obj.p, exp: obj.e };
  } catch (_) {
    return null;
  }
}

function enrichStudioProjectForClient(userId, project) {
  const exp = project.previewShareExpiresAt;
  const o = JSON.parse(JSON.stringify(project));
  delete o.previewShareExpiresAt;
  o.headRevisionId =
    project.studioHeadRevisionId && isUuidLike(String(project.studioHeadRevisionId))
      ? project.studioHeadRevisionId
      : null;
  delete o.studioHeadRevisionId;
  delete o.studioAgentChat;
  if (project.taskStatus === 'ready_for_review' && typeof exp === 'number' && exp > Date.now()) {
    o.previewSharePath = `/preview/${signStudioPreviewToken({ u: userId, p: project.id, e: exp })}/`;
  } else {
    o.previewSharePath = null;
  }
  return o;
}

function studioActiveBuildCountGlobal() {
  return studioBuildInProgress.size;
}

function studioActiveBuildCountForUser(userId) {
  const prefix = `${userId}:`;
  let n = 0;
  for (const k of studioBuildInProgress) {
    if (k.startsWith(prefix)) n += 1;
  }
  return n;
}

/** ---------- Studio §4.3: задачи, agent/run, SSE ---------- */

const STUDIO_TASKS_MAX_PER_PROJECT = Math.max(10, Number(process.env.STUDIO_TASKS_MAX_PER_PROJECT || 200));
const STUDIO_AGENT_MAX_RUNS_PER_USER = Math.max(1, Number(process.env.STUDIO_AGENT_MAX_RUNS_PER_USER || 3));
const STUDIO_AGENT_CHAT_MAX_MESSAGES = Math.max(4, Number(process.env.STUDIO_AGENT_CHAT_MAX_MESSAGES || 40));

const STUDIO_TASK_STATUSES = new Set([
  'open',
  'planning',
  'awaiting_task_plan_approval',
  'approved',
  'implementing',
  'done',
  'error',
]);

/** @type {Map<string, { userId: string, projectId: string, taskId: string, mode: string, events: object[], subscribers: Set<import('http').ServerResponse>, done: boolean }>} */
const studioAgentRuns = new Map();

function normalizeStudioProjectTasks(project) {
  if (!project || typeof project !== 'object') return;
  if (!Array.isArray(project.tasks)) project.tasks = [];
  const next = [];
  for (const t of project.tasks) {
    if (!t || typeof t !== 'object') continue;
    if (!isUuidLike(String(t.id))) continue;
    const status = STUDIO_TASK_STATUSES.has(t.status) ? t.status : 'open';
    next.push({
      id: t.id,
      title: typeof t.title === 'string' ? t.title.slice(0, 200) : 'Задача',
      prompt: typeof t.prompt === 'string' ? t.prompt.slice(0, 20_000) : '',
      images: Array.isArray(t.images) ? t.images.filter((x) => typeof x === 'string').slice(0, 8) : [],
      status,
      planMarkdown: typeof t.planMarkdown === 'string' ? t.planMarkdown.slice(0, 80_000) : '',
      activeRunId: t.activeRunId && isUuidLike(String(t.activeRunId)) ? t.activeRunId : null,
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : Date.now(),
    });
  }
  project.tasks = next.slice(0, STUDIO_TASKS_MAX_PER_PROJECT);
}

function normalizeStudioAgentChat(project) {
  if (!project || typeof project !== 'object') return;
  if (!Array.isArray(project.studioAgentChat)) project.studioAgentChat = [];
  const next = [];
  for (const m of project.studioAgentChat) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof m.content === 'string' ? m.content.slice(0, 16_000) : '';
    if (!content.trim()) continue;
    const entry = {
      role,
      content,
      at: typeof m.at === 'number' ? m.at : Date.now(),
    };
    if (role === 'assistant' && Array.isArray(m.chips)) {
      const chips = m.chips
        .filter((x) => typeof x === 'string' && x.trim())
        .slice(0, 6)
        .map((x) => x.trim().slice(0, 240));
      if (chips.length) entry.chips = chips;
    }
    next.push(entry);
  }
  project.studioAgentChat = next.slice(-STUDIO_AGENT_CHAT_MAX_MESSAGES);
}

function findStudioTask(project, taskId) {
  if (!project || !Array.isArray(project.tasks)) return null;
  return project.tasks.find((t) => t.id === taskId) || null;
}

function studioTasksForClient(project) {
  normalizeStudioProjectTasks(project);
  return project.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    imagesCount: t.images.length,
    status: t.status,
    planMarkdown: t.planMarkdown || '',
    activeRunId: t.activeRunId || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
}

function studioAgentActiveRunCountForUser(userId) {
  let n = 0;
  for (const r of studioAgentRuns.values()) {
    if (r.userId === userId && !r.done) n += 1;
  }
  return n;
}

function taskHasActiveAgentRun(task) {
  if (!task.activeRunId) return false;
  const run = studioAgentRuns.get(task.activeRunId);
  return !!(run && !run.done);
}

function emitStudioAgentEvent(runId, type, payload) {
  const run = studioAgentRuns.get(runId);
  if (!run) return;
  const ev = { type, payload: payload && typeof payload === 'object' ? payload : {} };
  run.events.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of run.subscribers) {
    try {
      if (!res.writableEnded) res.write(line);
    } catch (_) {
      /* */
    }
  }
}

function finishStudioAgentRun(runId) {
  const run = studioAgentRuns.get(runId);
  if (!run || run.done) return;
  run.done = true;
  emitStudioAgentEvent(runId, 'done', {});
  for (const res of run.subscribers) {
    try {
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (_) {
      /* */
    }
  }
  run.subscribers.clear();
  setTimeout(() => studioAgentRuns.delete(runId), 60_000);
}

function buildStudioPlanModePrompt(title, userPrompt) {
  return `Ты архитектор фронтенд-проекта (Vite, React, TypeScript). Составь структурированный план в Markdown: цели, экраны и компоненты, данные, шаги реализации, риски. Без приветствий и без блоков кода. Язык: русский.

Название задачи: ${title}

Описание:
${userPrompt}`.trim();
}

function buildStudioImplementModePrompt(title, userPrompt, taskPlanMd, projectPlanMd) {
  return `Ты ведущий разработчик. Кратко опиши в Markdown, какие файлы в Vite+React+TS проекте нужно создать или изменить и суть правок (без полного кода). Язык: русский.

Задача: ${title}
Запрос: ${userPrompt}

Утверждённый план задачи:
${taskPlanMd || '(нет)'}

Согласованный план проекта:
${projectPlanMd || '(нет)'}`.trim();
}

/** Диалог премиум-агента (без «задач» в UI): уточнения, chips, plan_markdown. */
function buildStudioAgentChatPrompt(historyTranscript, latestUser) {
  return `Ты lead product engineer **премиум-студии** уровня Lovable / v0: клиент получает готовый работающий продукт, а не черновик.

Поведение:
- Язык: **русский**, тон уверенный и тёплый, без воды и штампов.
- Если неясны цели, аудитория, ключевые экраны, стиль или функциональность — задай один сжатый блок уточнения и заполни **chips** (2–4 коротких варианта, как кнопки выбора в Lovable).
- Когда информации достаточно для реализации — заполни **plan_markdown**: продакшн-план (Цели, Аудитория, Экраны и сценарии, UX, Визуал и тон, Стек Vite+React+TS, Контент, SEO/доступность где уместно, Критерии приёмки, Риски). Пиши так, будто отдаёшь ТЗ студии **класса premium**.
- Не предлагай пользователю создавать задачи, тикеты или «подзадачи» — веди диалог до готового ТЗ.
- Не обещай то, что нельзя собрать на Vite+React+TS без бэкенда, если бэкенд не оговорён.

Формат ответа: **только один JSON-объект** без markdown-ограждений и без текста снаружи:
{"reply":"текст пользователю (markdown в строке разрешён)","chips":[],"plan_markdown":null}

Правила JSON:
- chips: [] если варианты не нужны; иначе 2–4 коротких строк.
- plan_markdown: строка с полным планом или null, пока рано.

История диалога:
${historyTranscript || '(начало диалога)'}

Текущее сообщение пользователя:
${latestUser}`.trim();
}

function parseStudioAgentChatResponse(raw) {
  const s = String(raw || '').trim();
  const fallback = {
    reply: s.length > 0 ? s : 'Не удалось разобрать ответ модели. Повторите сообщение.',
    chips: [],
    plan_markdown: null,
  };
  if (!s) return fallback;
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i === -1 || j <= i) return fallback;
    try {
      obj = JSON.parse(s.slice(i, j + 1));
    } catch {
      return fallback;
    }
  }
  if (!obj || typeof obj !== 'object') return fallback;
  const reply = typeof obj.reply === 'string' ? obj.reply.trim() : fallback.reply;
  const chips = Array.isArray(obj.chips)
    ? obj.chips
        .filter((x) => typeof x === 'string' && x.trim())
        .slice(0, 6)
        .map((x) => x.trim().slice(0, 240))
    : [];
  const pm = obj.plan_markdown != null && typeof obj.plan_markdown === 'string' ? obj.plan_markdown.trim() : '';
  const plan_markdown = pm.length >= 120 ? pm.slice(0, 50_000) : null;
  return { reply, chips, plan_markdown };
}

function buildStudioJsonOpsPrompt({
  title,
  userPrompt,
  taskPlan,
  projectPlan,
  narrative,
  headRevisionId,
  fileSummary,
  maxOps,
}) {
  const headLine = headRevisionId
    ? `Текущий HEAD ревизии workspace: ${headRevisionId}. Поле base_revision_id в JSON должно совпадать с этим UUID.`
    : `Ревизий HEAD нет — укажи base_revision_id как пустую строку "".`;
  return `Ты отвечаешь ТОЛЬКО одним JSON-объектом (без Markdown, без текста до или после, без \`\`\`).

Формат:
{"base_revision_id":"<uuid или пустая строка>","operations":[...]}

Элементы operations (не больше ${maxOps}):
- {"op":"write","path":"относительный/путь.ts","content_base64":"<base64 UTF-8 содержимого файла>"}
- {"op":"delete","path":"путь"}
- {"op":"mkdir","path":"каталог"}

Правила:
- Пути POSIX, без ".." и без ведущего /.
- Не используй корни node_modules, dist, .git, .vite.
- В package.json для иконок: **lucide-react** только как \`^1.0.0\` или \`^0.469.0\` (или другой реальный 0.4xx). **Не указывай \`^0.5.0\`** — на npm нет подходящих версий (npm ci падает с ETARGET). Имя пакета: **lucide-react**, не \`licide-react\`. Tailwind: пакет **tailwindcss**, не \`tailwind-css\`.
- Версии в dependencies: только печатные символы, без управляющих Unicode (иначе npm не прочитает package.json).
${headLine}

Файлы в workspace (фрагмент списка):
${fileSummary}

Название задачи: ${title}
Запрос: ${userPrompt}

План задачи (утверждён):
${truncateChars(String(taskPlan || ''), 6000)}

План проекта:
${truncateChars(String(projectPlan || ''), 4000)}

Резюме правок (из предыдущего ответа-модели):
${truncateChars(String(narrative || ''), 8000)}

Сгенерируй минимальный набор операций для Vite+React+TypeScript. Только JSON.`.trim();
}

function buildStudioBuildRecoveryPrompt({ headRevisionId, fileSummary, projectPlan, buildLogTail, maxOps }) {
  const headLine = headRevisionId
    ? `Текущий HEAD ревизии workspace: ${headRevisionId}. Поле base_revision_id в JSON должно совпадать с этим UUID.`
    : `Ревизий HEAD нет — укажи base_revision_id как пустую строку "".`;
  return `Ты отвечаешь ТОЛЬКО одним JSON-объектом (без Markdown, без текста до или после, без \`\`\`).

Формат:
{"base_revision_id":"<uuid или пустая строка>","operations":[...]}

Сборка превью (npm install / npm run build) упала. По логу исправь проект **минимальными правками**, чтобы установка и \`vite build\` проходили без ошибок.

Элементы operations (не больше ${maxOps}):
- {"op":"write","path":"относительный/путь.ts","content_base64":"<base64 UTF-8>"}
- {"op":"delete","path":"путь"}
- {"op":"mkdir","path":"каталог"}

Правила:
- Пути POSIX, без ".." и без ведущего /.
- Не трогай node_modules, dist, .git, .vite.
- **lucide-react**: только \`^1.0.0\` или реальный 0.4xx (\`^0.469.0\`); не \`^0.5.0\`. Не пиши \`licide-react\` (опечатка). **tailwindcss**, не \`tailwind-css\`.
- Если не хватает lockfile — допусти правку только package.json; сервер сам выполнит npm install.
- Строки версий в dependencies: только обычные printable-символы, **без** управляющих символов (0x00–0x1F).
${headLine}

Файлы workspace:
${fileSummary}

План проекта:
${truncateChars(String(projectPlan || ''), 4000)}

Лог сборки (ошибки npm / tsc / vite):
${truncateChars(String(buildLogTail || ''), 12000)}

Только JSON.`.trim();
}

function parseAgentWorkspaceOperations(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, err: 'empty', operations: [], base_revision_id: null };
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i === -1 || j <= i) return { ok: false, err: 'json_parse', operations: [], base_revision_id: null };
    try {
      obj = JSON.parse(s.slice(i, j + 1));
    } catch {
      return { ok: false, err: 'json_parse', operations: [], base_revision_id: null };
    }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.operations)) {
    return { ok: false, err: 'bad_shape', operations: [], base_revision_id: null };
  }
  const base_revision_id =
    obj.base_revision_id != null && String(obj.base_revision_id).trim().length > 0
      ? String(obj.base_revision_id).trim()
      : null;
  return { ok: true, err: null, operations: obj.operations, base_revision_id };
}

/** Эвристика: простые реплики → дешёвые облачные модели; сложные → Sonnet / 4o и т.д. */
function estimateCloudTaskTier(promptText) {
  const s = String(promptText || '').trim();
  if (!s) return 'lite';
  if (s.length > 2600) return 'standard';
  const lines = s.split(/\r?\n/).length;
  if (s.length > 700 && lines > 10) return 'standard';
  if (/```/.test(s)) return 'standard';
  if (
    /\b(refactor|docker|kubernetes|microservice|postgres|mongodb|prisma|graphql|openapi|tailwind\s*config|vite\.config|webpack|nginx|systemd|middleware)\b/i.test(
      s,
    )
  ) {
    return 'standard';
  }
  if (
    /(напиши|создай|собери|реализуй|спроектируй).{0,48}(приложен|сайт|проект|сервис|интерфейс|backend|бэкенд|фронт|лендинг|dashboard|бота)/i.test(
      s,
    )
  ) {
    return 'standard';
  }
  if (/(полн(ый|ого)|целиком|production|продакшн).{0,24}(код|проект|стек|репозитор)/i.test(s)) {
    return 'standard';
  }
  if (/\b(base_revision_id|studio\.patch|operations\"\s*:|content_base64)\b/i.test(s)) {
    return 'standard';
  }
  if (
    /(техническ(ое|ий)\s+задан|ТЗ\s|архитектур|многостраничн|интеграци(?:я|ю)\s+с\s+api)/i.test(
      s,
    )
  ) {
    return 'standard';
  }
  return 'lite';
}

/** Модели по ролям: стрим = связные планы; json = строгая схема PATCH workspace. */
function studioStreamAnthropicModel() {
  return String(
    process.env.ANTHROPIC_MODEL_STREAM || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
  ).trim();
}
function studioStreamAnthropicModelLite() {
  return String(
    process.env.ANTHROPIC_MODEL_STREAM_LITE ||
      process.env.ANTHROPIC_MODEL_LITE ||
      'claude-3-5-haiku-20241022',
  ).trim();
}
function studioJsonAnthropicModel() {
  return String(
    process.env.ANTHROPIC_MODEL_JSON || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
  ).trim();
}
function studioStreamOpenAiModel() {
  return String(
    process.env.OPENAI_STUDIO_MODEL_STREAM || process.env.OPENAI_STUDIO_MODEL || 'gpt-4o',
  ).trim();
}
function studioStreamOpenAiModelLite() {
  return String(
    process.env.OPENAI_STUDIO_MODEL_STREAM_LITE ||
      process.env.OPENAI_STUDIO_MODEL_LITE ||
      'gpt-4o-mini',
  ).trim();
}
function studioJsonOpenAiModel() {
  return String(
    process.env.OPENAI_STUDIO_MODEL_JSON || process.env.OPENAI_STUDIO_MODEL || 'gpt-4o',
  ).trim();
}
function studioStreamGeminiModel() {
  return String(
    process.env.GEMINI_STUDIO_MODEL_STREAM || process.env.GEMINI_STUDIO_MODEL || 'gemini-2.0-flash',
  ).trim();
}
function studioStreamGeminiModelLite() {
  return String(
    process.env.GEMINI_STUDIO_MODEL_STREAM_LITE ||
      process.env.GEMINI_STUDIO_MODEL_LITE ||
      'gemini-2.0-flash',
  ).trim();
}
function studioJsonGeminiModel() {
  return String(
    process.env.GEMINI_STUDIO_MODEL_JSON || process.env.GEMINI_STUDIO_MODEL || 'gemini-2.0-flash',
  ).trim();
}

/**
 * Порядок облачных провайдеров под задачу.
 * @param {'stream' | 'json' | 'chat'} purpose
 */
function studioLlmOrderForPurpose(purpose) {
  if (purpose === 'json') {
    const raw = process.env.STUDIO_LLM_ORDER_JSON || 'openai,anthropic,gemini';
    return raw
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (purpose === 'chat') {
    const raw =
      process.env.STUDIO_LLM_ORDER_CHAT ||
      process.env.STUDIO_LLM_ORDER_STREAM ||
      'anthropic,openai,gemini';
    return raw
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const raw =
    process.env.STUDIO_LLM_ORDER_STREAM ||
    process.env.STUDIO_LLM_FALLBACK_ORDER ||
    'anthropic,openai,gemini';
  return raw
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Для tier=lite можно задать отдельный порядок (например сначала gemini flash). */
function studioLlmOrderForCloud(purpose, tier) {
  if (purpose !== 'json' && tier === 'lite') {
    const raw = process.env.STUDIO_LLM_ORDER_STREAM_LITE?.trim();
    if (raw) {
      return raw
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return ['gemini', 'openai', 'anthropic'];
  }
  return studioLlmOrderForPurpose(purpose);
}

function studioLlmFallbackConfigured() {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return true;
  if (process.env.OPENAI_API_KEY?.trim()) return true;
  if ((process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY)?.trim()) return true;
  return false;
}

/** Ollama доступен или настроен хотя бы один облачный провайдер для студии. */
function studioLlmUpstreamAvailable() {
  return ollamaHealthCached.status === 'ok' || studioLlmFallbackConfigured();
}

async function studioLlmAnthropicComplete(prompt, maxTokens, modelExplicit) {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const model = String(
    modelExplicit ||
      process.env.ANTHROPIC_MODEL ||
      'claude-sonnet-4-20250514',
  ).trim();
  const mt = Math.min(maxTokens, 16384);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: mt,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(Math.min(OLLAMA_FETCH_TIMEOUT_MS * 4, 120000)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && (data.error.message || data.error)) || `HTTP ${res.status}`);
  }
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks.map((c) => (c && c.type === 'text' ? String(c.text || '') : '')).join('');
  return text.trim();
}

async function studioLlmOpenAiComplete(prompt, maxTokens, modelExplicit) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const model = String(
    modelExplicit || process.env.OPENAI_STUDIO_MODEL || 'gpt-4o',
  ).trim();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(maxTokens, 16384),
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(Math.min(OLLAMA_FETCH_TIMEOUT_MS * 4, 120000)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `HTTP ${res.status}`);
  }
  return String(data.choices?.[0]?.message?.content || '').trim();
}

async function studioLlmGeminiComplete(prompt, maxTokens, modelExplicit) {
  const key = (process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
  if (!key) return null;
  const model = String(
    modelExplicit || process.env.GEMINI_STUDIO_MODEL || 'gemini-2.0-flash',
  ).trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: Math.min(maxTokens, 8192) },
    }),
    signal: AbortSignal.timeout(Math.min(OLLAMA_FETCH_TIMEOUT_MS * 4, 120000)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `HTTP ${res.status}`);
  }
  const parts = data.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (p && p.text ? String(p.text) : '')).join('').trim();
}

async function studioLlmCompleteCloud(prompt, maxTokens, purpose = 'stream', tierOpt) {
  const tier = purpose === 'json' ? 'standard' : tierOpt ?? estimateCloudTaskTier(prompt);
  const effectiveMax =
    tier === 'lite'
      ? Math.min(maxTokens, Math.max(256, Number(process.env.STUDIO_CLOUD_MAX_TOKENS_LITE || 4096)))
      : maxTokens;
  const order = studioLlmOrderForCloud(purpose, tier);
  let lastErr = 'no_cloud_provider_configured';
  for (const p of order) {
    try {
      if (p === 'anthropic' && process.env.ANTHROPIC_API_KEY?.trim()) {
        const modelSel =
          purpose === 'json'
            ? studioJsonAnthropicModel()
            : tier === 'lite'
              ? studioStreamAnthropicModelLite()
              : studioStreamAnthropicModel();
        const t = await studioLlmAnthropicComplete(prompt, effectiveMax, modelSel);
        if (t != null) {
          logAccess(`STUDIO_LLM_CLOUD_OK purpose=${purpose} tier=${tier} provider=anthropic model=${modelSel}`);
          return { ok: true, text: t, provider: 'anthropic', model: modelSel, tier };
        }
      } else if (p === 'openai' && process.env.OPENAI_API_KEY?.trim()) {
        const modelSel =
          purpose === 'json'
            ? studioJsonOpenAiModel()
            : tier === 'lite'
              ? studioStreamOpenAiModelLite()
              : studioStreamOpenAiModel();
        const t = await studioLlmOpenAiComplete(prompt, effectiveMax, modelSel);
        if (t != null) {
          logAccess(`STUDIO_LLM_CLOUD_OK purpose=${purpose} tier=${tier} provider=openai model=${modelSel}`);
          return { ok: true, text: t, provider: 'openai', model: modelSel, tier };
        }
      } else if (
        p === 'gemini' &&
        (process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY)?.trim()
      ) {
        const modelSel =
          purpose === 'json'
            ? studioJsonGeminiModel()
            : tier === 'lite'
              ? studioStreamGeminiModelLite()
              : studioStreamGeminiModel();
        const t = await studioLlmGeminiComplete(prompt, effectiveMax, modelSel);
        if (t != null) {
          logAccess(`STUDIO_LLM_CLOUD_OK purpose=${purpose} tier=${tier} provider=gemini model=${modelSel}`);
          return { ok: true, text: t, provider: 'gemini', model: modelSel, tier };
        }
      }
    } catch (e) {
      lastErr = String(e.message || e);
      logError(`STUDIO_LLM_CLOUD_${purpose}_${tier}_${p} ${lastErr}`);
    }
  }
  return { ok: false, text: '', err: lastErr, provider: null, model: null, tier };
}

async function studioTryOllamaGenerateSingle(model, prompt) {
  try {
    const upstream = await fetchOllamaWithRetry(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
    });
    if (!upstream.ok) {
      let t = '';
      try {
        t = await upstream.text();
      } catch (_) {
        /* */
      }
      const offline = upstream.status === 503 || upstream.status === 502;
      return {
        ok: false,
        text: '',
        err: offline ? 'OLLAMA_OFFLINE' : `upstream_${upstream.status}`,
        detail: t.slice(0, 400),
      };
    }
    const data = await upstream.json();
    const errStr = ollamaErrorTextFromGenerateJson(data);
    if (errStr) {
      return {
        ok: false,
        text: '',
        err: isOllamaOutOfMemoryMessage(errStr) ? 'MODEL_OUT_OF_MEMORY' : errStr,
        detail: '',
      };
    }
    return { ok: true, text: String(data.response || '').trim(), err: null, detail: '' };
  } catch (e) {
    return { ok: false, text: '', err: 'OLLAMA_OFFLINE', detail: String(e.message || e) };
  }
}

/** Одноразовый ответ: Ollama при живом шлюзе, иначе облако (ключи только из env). */
async function studioGenerateSingleResponse(model, prompt) {
  if (ollamaHealthCached.status === 'ok') {
    const o = await studioTryOllamaGenerateSingle(model, prompt);
    if (o.ok) return { ...o, provider: 'ollama' };
    const cloud = await studioLlmCompleteCloud(prompt, STUDIO_CLOUD_MAX_TOKENS, 'json');
    if (cloud.ok) return { ok: true, text: cloud.text, err: null, detail: '', provider: cloud.provider };
    return { ok: false, text: '', err: cloud.err || o.err, detail: o.detail, provider: null };
  }
  const cloud = await studioLlmCompleteCloud(prompt, STUDIO_CLOUD_MAX_TOKENS, 'json');
  if (cloud.ok) return { ok: true, text: cloud.text, err: null, detail: '', provider: cloud.provider };
  return { ok: false, text: '', err: cloud.err || 'LLM_UNAVAILABLE', detail: '', provider: null };
}

/** Связный текст (диалог агента, нарратив): Ollama или облако с моделями stream/chat. */
async function studioGeneratePlainLlmText(model, prompt) {
  if (ollamaHealthCached.status === 'ok') {
    const o = await studioTryOllamaGenerateSingle(model, prompt);
    if (o.ok) return { ok: true, text: o.text, err: null, detail: '', provider: 'ollama' };
    const cloud = await studioLlmCompleteCloud(prompt, STUDIO_CLOUD_MAX_TOKENS, 'chat');
    if (cloud.ok) return { ok: true, text: cloud.text, err: null, detail: '', provider: cloud.provider };
    return { ok: false, text: '', err: cloud.err || o.err, detail: o.detail, provider: null };
  }
  const cloud = await studioLlmCompleteCloud(prompt, STUDIO_CLOUD_MAX_TOKENS, 'chat');
  if (cloud.ok) return { ok: true, text: cloud.text, err: null, detail: '', provider: cloud.provider };
  return { ok: false, text: '', err: cloud.err || 'LLM_UNAVAILABLE', detail: '', provider: null };
}

function studioAgentChatHistoryTranscript(project) {
  normalizeStudioAgentChat(project);
  return project.studioAgentChat
    .map((m) => `${m.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${m.content}`)
    .join('\n\n');
}

function studioEmitCloudDeltas(runId, fullText) {
  const chunk = 100;
  for (let i = 0; i < fullText.length; i += chunk) {
    emitStudioAgentEvent(runId, 'delta', { text: fullText.slice(i, i + chunk) });
  }
}

async function pipeOllamaGenerateToStudioRun(runId, promptText, model, images) {
  let effectivePrompt = promptText;
  if (images && images.length > 0 && ollamaHealthCached.status !== 'ok') {
    effectivePrompt = `${promptText}\n\n[Системное примечание: передано ${images.length} изображени(й); в облачном режиме анализ изображений недоступен — опирайся на текст.]`;
  }

  const tryStreamOllama = ollamaHealthCached.status === 'ok';
  if (tryStreamOllama) {
    const upstreamPayload = { model, prompt: effectivePrompt, stream: true };
    if (images && images.length > 0) upstreamPayload.images = images;

    let upstream;
    try {
      upstream = await fetchOllamaWithRetry(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(upstreamPayload),
      });
    } catch (err) {
      logError(`STUDIO_AGENT_FETCH ${runId} ${err.stack || err.message}`);
      upstream = null;
    }

    const cleanupUpstream = () => upstream && safeCancelFetchBody(upstream.body);

    if (upstream && upstream.ok && upstream.body != null) {
      const parts = [];
      try {
        const nodeReadable = Readable.fromWeb(upstream.body);
        const rl = readline.createInterface({ input: nodeReadable, crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            const run = studioAgentRuns.get(runId);
            if (!run || run.done) break;
            const trimmed = line.trim();
            if (!trimmed) continue;
            let piece = '';
            try {
              const parsed = JSON.parse(trimmed);
              const errStr = ollamaErrorTextFromGenerateJson(parsed);
              if (isOllamaOutOfMemoryMessage(errStr)) {
                emitStudioAgentEvent(runId, 'error', { message: 'MODEL_OUT_OF_MEMORY' });
                break;
              }
              if (parsed.response) piece = String(parsed.response);
            } catch {
              piece = trimmed;
            }
            if (piece) {
              parts.push(piece);
              emitStudioAgentEvent(runId, 'delta', { text: piece });
            }
          }
        } finally {
          rl.close();
          try {
            nodeReadable.destroy();
          } catch (_) {
            /* */
          }
          cleanupUpstream();
        }
      } catch (err) {
        cleanupUpstream();
        logError(`STUDIO_AGENT_PIPE ${runId} ${err.stack || err.message}`);
        emitStudioAgentEvent(runId, 'error', { message: String(err.message || err) });
        return { ok: false, fullText: parts.join('') };
      }
      return { ok: true, fullText: parts.join(''), provider: 'ollama' };
    }

    if (upstream) cleanupUpstream();
  }

  const cloud = await studioLlmCompleteCloud(effectivePrompt, STUDIO_CLOUD_MAX_TOKENS, 'stream');
  if (!cloud.ok) {
    emitStudioAgentEvent(runId, 'error', {
      message: cloud.err || 'LLM_UNAVAILABLE',
    });
    return { ok: false, fullText: '', provider: null };
  }
  studioEmitCloudDeltas(runId, cloud.text);
  return { ok: true, fullText: cloud.text, provider: cloud.provider };
}

async function executeStudioAgentRun(runId) {
  const run = studioAgentRuns.get(runId);
  if (!run) return;
  const { userId, projectId, taskId, mode } = run;

  let taskTitle = '';
  let taskPrompt = '';
  let taskImages = [];
  let taskPlanMd = '';
  let projPlanMd = '';
  let found = false;

  await userTxn(userId, async () => {
    const data = loadUserFile(userId);
    const project = data.studioProjects.find((p) => p.id === projectId);
    if (!project) return;
    normalizeStudioProjectTasks(project);
    const task = findStudioTask(project, taskId);
    if (!task) return;
    found = true;
    taskTitle = task.title;
    taskPrompt = task.prompt;
    taskImages = task.images || [];
    taskPlanMd = typeof task.planMarkdown === 'string' ? task.planMarkdown : '';
    projPlanMd = project.plan && typeof project.plan.markdown === 'string' ? project.plan.markdown : '';
  });

  if (!found) {
    emitStudioAgentEvent(runId, 'error', { message: 'not_found' });
    finishStudioAgentRun(runId);
    await userTxn(userId, async () => {
      const data = loadUserFile(userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return;
      const task = findStudioTask(project, taskId);
      if (task && task.activeRunId === runId) {
        task.activeRunId = null;
        task.status = 'error';
        task.updatedAt = Date.now();
        saveUserFile(userId, data);
      }
    });
    return;
  }

  let model = await resolveModel(DEFAULT_MODEL);
  const upstreamPayloadImages = taskImages.length > 0 ? taskImages : undefined;
  if (upstreamPayloadImages) {
    try {
      model = await resolveVisionModel(DEFAULT_MODEL);
    } catch (_) {
      model = DEFAULT_MODEL;
    }
  }

  const pseudo = { stream: true, model, prompt: 'x' };
  if (upstreamPayloadImages) pseudo.images = upstreamPayloadImages;
  stripImagesIfUnsupported(pseudo, model);
  const imagesEff = pseudo.images;

  if (mode === 'plan') {
    const promptText = buildStudioPlanModePrompt(taskTitle, taskPrompt);
    const { ok, fullText } = await pipeOllamaGenerateToStudioRun(runId, promptText, pseudo.model, imagesEff);
    await userTxn(userId, async () => {
      const data = loadUserFile(userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return;
      normalizeStudioProjectTasks(project);
      const task = findStudioTask(project, taskId);
      if (!task) return;
      if (task.activeRunId !== runId) return;
      task.activeRunId = null;
      task.updatedAt = Date.now();
      if (!ok) {
        task.status = 'error';
        saveUserFile(userId, data);
        return;
      }
      task.planMarkdown = fullText.slice(0, 80_000);
      task.status = 'awaiting_task_plan_approval';
      saveUserFile(userId, data);
      emitStudioAgentEvent(runId, 'plan_ready', {
        task_id: taskId,
        markdown: task.planMarkdown,
      });
    });
    finishStudioAgentRun(runId);
    return;
  }

  const narrativePrompt = buildStudioImplementModePrompt(taskTitle, taskPrompt, taskPlanMd, projPlanMd);
  emitStudioAgentEvent(runId, 'tool_start', { tool: 'llm_explanation' });
  const { ok: narOk, fullText: narrative } = await pipeOllamaGenerateToStudioRun(
    runId,
    narrativePrompt,
    pseudo.model,
    imagesEff,
  );
  emitStudioAgentEvent(runId, 'tool_end', { tool: 'llm_explanation' });

  if (!narOk) {
    emitStudioAgentEvent(runId, 'error', { message: 'ollama_stream_failed' });
    await userTxn(userId, async () => {
      const data = loadUserFile(userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return;
      normalizeStudioProjectTasks(project);
      const task = findStudioTask(project, taskId);
      if (task && task.activeRunId === runId) {
        task.activeRunId = null;
        task.status = 'error';
        task.updatedAt = Date.now();
        saveUserFile(userId, data);
      }
    });
    finishStudioAgentRun(runId);
    return;
  }

  let headRev = null;
  await userTxn(userId, async () => {
    const data = loadUserFile(userId);
    const project = data.studioProjects.find((p) => p.id === projectId);
    if (project && project.studioHeadRevisionId && isUuidLike(String(project.studioHeadRevisionId))) {
      headRev = project.studioHeadRevisionId;
    }
  });

  const ws = ensureStudioWorkspaceScaffold(userId, projectId);
  const files = studioListWorkspaceFiles(ws);
  const fileSummary = files.slice(0, 60).map((f) => f.path).join('\n') || '(пусто)';

  const jsonPrompt = buildStudioJsonOpsPrompt({
    title: taskTitle,
    userPrompt: taskPrompt,
    taskPlan: taskPlanMd,
    projectPlan: projPlanMd,
    narrative,
    headRevisionId: headRev,
    fileSummary,
    maxOps: STUDIO_AGENT_IMPLEMENT_MAX_OPS,
  });

  const codeModel = ALLOWED_SET.has(STUDIO_AGENT_CODE_MODEL)
    ? STUDIO_AGENT_CODE_MODEL
    : await resolveModel('deepseek-coder:latest');

  emitStudioAgentEvent(runId, 'tool_start', { tool: 'studio.patch_workspace' });
  const gen2 = await studioGenerateSingleResponse(codeModel, jsonPrompt);

  if (!gen2.ok) {
    emitStudioAgentEvent(runId, 'error', {
      message: gen2.err || 'llm_json_failed',
      detail: gen2.detail,
    });
    await userTxn(userId, async () => {
      const data = loadUserFile(userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return;
      normalizeStudioProjectTasks(project);
      const task = findStudioTask(project, taskId);
      if (task && task.activeRunId === runId) {
        task.activeRunId = null;
        task.status = 'error';
        task.updatedAt = Date.now();
        saveUserFile(userId, data);
      }
    });
    emitStudioAgentEvent(runId, 'tool_end', { tool: 'studio.patch_workspace' });
    finishStudioAgentRun(runId);
    return;
  }

  const parsed = parseAgentWorkspaceOperations(gen2.text);
  if (!parsed.ok || parsed.operations.length === 0) {
    emitStudioAgentEvent(runId, 'error', { message: parsed.err || 'bad_operations_json' });
    await userTxn(userId, async () => {
      const data = loadUserFile(userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return;
      normalizeStudioProjectTasks(project);
      const task = findStudioTask(project, taskId);
      if (task && task.activeRunId === runId) {
        task.activeRunId = null;
        task.status = 'error';
        task.updatedAt = Date.now();
        saveUserFile(userId, data);
      }
    });
    emitStudioAgentEvent(runId, 'tool_end', { tool: 'studio.patch_workspace' });
    finishStudioAgentRun(runId);
    return;
  }

  const ops = parsed.operations.slice(0, STUDIO_AGENT_IMPLEMENT_MAX_OPS);
  const bodyBase = headRev || parsed.base_revision_id || null;

  const patchOut = await studioApplyWorkspacePatchTxn(userId, projectId, bodyBase, ops);

  if (patchOut.code !== 200) {
    emitStudioAgentEvent(runId, 'error', {
      message: patchOut.err || 'patch_failed',
      code: patchOut.code,
      at: patchOut.at,
      conflicts: patchOut.conflicts,
    });
    await userTxn(userId, async () => {
      const data = loadUserFile(userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return;
      normalizeStudioProjectTasks(project);
      const task = findStudioTask(project, taskId);
      if (task && task.activeRunId === runId) {
        task.activeRunId = null;
        task.status = 'error';
        task.updatedAt = Date.now();
        saveUserFile(userId, data);
      }
    });
    emitStudioAgentEvent(runId, 'tool_end', { tool: 'studio.patch_workspace' });
    finishStudioAgentRun(runId);
    return;
  }

  emitStudioAgentEvent(runId, 'revision', {
    applied: patchOut.applied,
    revision_id: null,
  });

  await userTxn(userId, async () => {
    const data = loadUserFile(userId);
    const project = data.studioProjects.find((p) => p.id === projectId);
    if (!project) return;
    normalizeStudioProjectTasks(project);
    const task = findStudioTask(project, taskId);
    if (task && task.activeRunId === runId) {
      task.activeRunId = null;
      task.status = 'done';
      task.updatedAt = Date.now();
      saveUserFile(userId, data);
    }
  });

  emitStudioAgentEvent(runId, 'tool_end', { tool: 'studio.patch_workspace' });
  finishStudioAgentRun(runId);
}

function maskKey(key) {
  if (!key || typeof key !== 'string') return '(none)';
  if (key.length <= 6) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 4)}***${key.slice(-2)}`;
}

function openaiCompletionId() {
  return `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
}

function promptFromOpenAiMessages(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

/** @type {Map<string, number[]>} */
const hitsByKey = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;

let activeRequests = 0;
const MAX_CONCURRENT = 2;

/** Очередь для SSE streaming (см. POST /api/stream/generate): как в ТЗ — один активный поток. */
const queue = [];
let active = 0;
const STREAM_MAX_CONCURRENT = 1;
/** Максимум ожидающих в очереди stream (при занятом worker → 429). */
const STREAM_QUEUE_MAX_WAITING = 10;

function drainStreamQueue() {
  while (active < STREAM_MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    if (!job) continue;
    if (job.req.aborted || job.res.writableEnded) continue;
    active += 1;
    void processStreamQueuedJob(job).finally(() => {
      active -= 1;
      drainStreamQueue();
    });
  }
}

/**
 * SSE для POST /api/stream/generate: псевдо-поток в форме NDJSON как у Ollama (`{ "response": "..." }`).
 */
async function streamQueueEmitCloudOllamaShaped(res, req, promptText) {
  const cloud = await studioLlmCompleteCloud(promptText, STUDIO_CLOUD_MAX_TOKENS, 'stream');
  if (!cloud.ok) return { ok: false };
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
  }
  const step = 64;
  for (let i = 0; i < cloud.text.length; i += step) {
    if (req.aborted || res.writableEnded) break;
    const piece = cloud.text.slice(i, i + step);
    res.write(`data: ${JSON.stringify({ response: piece })}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }
  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
  return { ok: true };
}

/**
 * Читает поток Ollama (NDJSON по строкам), отдаёт клиенту как SSE: data: …\n\n, в конце data: [DONE].
 */
async function processStreamQueuedJob(job) {
  const { req, res, prompt, model, images } = job;

  if (req.aborted || res.writableEnded) {
    return;
  }

  const upstreamPayload = {
    model,
    prompt,
    stream: true,
  };
  if (images && images.length > 0) upstreamPayload.images = images;

  try {
    if (upstreamPayload.images?.length) {
      upstreamPayload.model = await resolveVisionModel(model);
    } else {
      upstreamPayload.model = await resolveModel(model);
    }
  } catch (e) {
    if (e && (e.code === 'MODEL_NOT_FOUND' || e.message === 'MODEL_NOT_FOUND')) {
      logError(`STREAM_QUEUE_MODEL_MISSING ip=${req.ip} model=${model}`);
      if (!res.headersSent) {
        res.status(503).json({ error: 'MODEL_NOT_INSTALLED' });
      }
      return;
    }
    throw e;
  }

  stripImagesIfUnsupported(upstreamPayload, upstreamPayload.model);

  let promptForCloud = prompt;
  if (images && images.length > 0) {
    promptForCloud = `${prompt}\n\n[Системное примечание: изображения переданы; Ollama недоступна — ответь по тексту запроса.]`;
  }

  if (ollamaHealthCached.status !== 'ok') {
    if (studioLlmFallbackConfigured()) {
      const cr = await streamQueueEmitCloudOllamaShaped(res, req, promptForCloud);
      if (cr.ok) {
        logAccess(`STREAM_QUEUE_CLOUD ip=${req.ip} user=${req.userId} model=${model}`);
        return;
      }
    }
    if (!res.headersSent) {
      res.status(503).json({ error: 'OLLAMA_OFFLINE' });
    }
    return;
  }

  let upstream;
  try {
    upstream = await fetchOllamaWithRetry(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err) {
    logError(`STREAM_QUEUE_FETCH_ERR ip=${req.ip} ${err.stack || err.message}`);
    if (studioLlmFallbackConfigured()) {
      const cr = await streamQueueEmitCloudOllamaShaped(res, req, promptForCloud);
      if (cr.ok) {
        logAccess(`STREAM_QUEUE_CLOUD ip=${req.ip} user=${req.userId} model=${model}`);
        return;
      }
    }
    if (!res.headersSent) {
      res.status(503).json({ error: 'OLLAMA_OFFLINE' });
    }
    return;
  }

  const cleanupUpstream = () => {
    safeCancelFetchBody(upstream.body);
  };

  req.once('close', cleanupUpstream);

  if (!upstream.ok || upstream.body == null) {
    cleanupUpstream();
    let text = '';
    try {
      text = await upstream.text();
    } catch (e) {
      logError(`STREAM_QUEUE_READ_ERR ${e.message}`);
    }
    logError(`STREAM_QUEUE_HTTP_ERR status=${upstream.status} body=${text.slice(0, 600)}`);
    if (!res.headersSent) {
      if (isOllamaOutOfMemoryMessage(text)) {
        console.error('[MODEL] not enough memory');
        res.status(503).json({ error: 'MODEL_OUT_OF_MEMORY' });
        return;
      }
      if (studioLlmFallbackConfigured()) {
        const cr = await streamQueueEmitCloudOllamaShaped(res, req, promptForCloud);
        if (cr.ok) {
          logAccess(`STREAM_QUEUE_CLOUD ip=${req.ip} user=${req.userId} model=${model}`);
          return;
        }
      }
      const offline = upstream.status === 503 || upstream.status === 502;
      if (offline) {
        res.status(503).json({ error: 'OLLAMA_OFFLINE' });
        return;
      }
      res.status(upstream.status).type('application/json').send(text || JSON.stringify({ error: 'Upstream error' }));
    }
    return;
  }

  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();

    const nodeReadable = Readable.fromWeb(upstream.body);
    const rl = readline.createInterface({ input: nodeReadable, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (req.aborted || res.writableEnded) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let passThrough = trimmed;
        try {
          const parsed = JSON.parse(trimmed);
          const errStr = ollamaErrorTextFromGenerateJson(parsed);
          if (isOllamaOutOfMemoryMessage(errStr)) {
            console.error('[MODEL] not enough memory');
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ error: 'MODEL_OUT_OF_MEMORY' })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }
            break;
          }
        } catch {
          /* сырой фрагмент */
        }
        res.write(`data: ${passThrough}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } finally {
      rl.close();
      try {
        nodeReadable.destroy();
      } catch (_) {
        /* ignore */
      }
      cleanupUpstream();
    }

    logAccess(`STREAM_QUEUE_DONE ip=${req.ip} user=${req.userId} model=${model}`);
  } catch (err) {
    cleanupUpstream();
    logError(`STREAM_QUEUE_PIPE_ERR ip=${req.ip} ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Streaming setup failed' });
    } else if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ error: String(err.message) })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function rateLimitForKey(apiKey) {
  const now = Date.now();
  let hits = hitsByKey.get(apiKey) || [];
  hits = hits.filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) return false;
  hits.push(now);
  hitsByKey.set(apiKey, hits);
  return true;
}

function apiKeyMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  let key = req.headers['x-api-key'];

  if (!key && authHeader && authHeader.startsWith('Bearer ')) {
    key = authHeader.replace('Bearer ', '').trim();
  }

  if (!key || typeof key !== 'string' || !API_KEYS.has(key.trim())) {
    logAccess(`ACCESS ip=${req.ip} path=${req.path} model=- status=401 key=${maskKey(key)}`);
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  req.apiKey = key.trim();
  next();
}

function rateLimitMiddleware(req, res, next) {
  if (!rateLimitForKey(req.apiKey)) {
    logAccess(`ACCESS ip=${req.ip} path=${req.path} model=- status=429 key=${maskKey(req.apiKey)} note=rate_limit`);
    return res.status(429).json({ error: 'Too many requests (60/min per key)' });
  }
  next();
}

function stagingDir(userId) {
  return path.join(UPLOADS_DIR, 'staging', userId);
}

/** Временное сохранение файлов до POST message (multipart только здесь, без SSE). */
const uploadStaging = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = stagingDir(req.userId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 24);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const base = path.basename(file.originalname || '').toLowerCase();
    const mimeOk =
      mime === 'image/jpeg' ||
      mime === 'image/png' ||
      mime === 'application/pdf' ||
      mime === 'text/plain';
    const extOk = /\.(jpe?g|png|pdf|txt)$/i.test(base);
    if (mimeOk && extOk) cb(null, true);
    else cb(new Error('unsupported_file_type'));
  },
});

function handleMulterOrUploadError(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'file_too_large', maxMB: 5 });
    }
    return res.status(400).json({ error: String(err.code || err.message) });
  }
  if (err.message === 'unsupported_file_type') {
    return res.status(400).json({ error: 'unsupported_file_type' });
  }
  return next(err);
}

/**
 * Читает файлы, ранее сохранённые POST /api/upload (каталог staging per user).
 * @returns {{ buffer: Buffer, mime: string, filename: string }[]}
 */
function loadStagedFileBuffers(userId, fileIds) {
  const ids = Array.isArray(fileIds)
    ? fileIds
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((x) => isUuidLike(x))
        .slice(0, 8)
    : [];
  /** @type {{ buffer: Buffer, mime: string, filename: string }[]} */
  const out = [];
  const dir = stagingDir(userId);
  for (const id of ids) {
    if (!fs.existsSync(dir)) {
      throw Object.assign(new Error('staging_missing'), { code: 'FILE_MISS' });
    }
    const names = fs.readdirSync(dir);
    const dataName = names.find((n) => n.startsWith(`${id}.`) && !n.endsWith('.meta.json'));
    if (!dataName) {
      throw Object.assign(new Error('file_not_found'), { code: 'FILE_MISS' });
    }
    const metaPath = path.join(dir, `${id}.meta.json`);
    let mime = 'application/octet-stream';
    let originalname = dataName;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        mime = String(meta.mime || mime).toLowerCase();
        originalname = String(meta.originalname || originalname);
      } catch (_) {
        /* ignore */
      }
    }
    out.push({
      buffer: fs.readFileSync(path.join(dir, dataName)),
      mime,
      filename: originalname,
    });
  }
  return out;
}

function cleanupStagedFileSet(userId, fileIds) {
  const ids = Array.isArray(fileIds)
    ? fileIds.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => isUuidLike(x))
    : [];
  const dir = stagingDir(userId);
  if (!fs.existsSync(dir)) return;
  for (const id of ids) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    const dataName = names.find((n) => n.startsWith(`${id}.`) && !n.endsWith('.meta.json'));
    if (dataName) {
      try {
        fs.unlinkSync(path.join(dir, dataName));
      } catch (_) {
        /* ignore */
      }
    }
    const mp = path.join(dir, `${id}.meta.json`);
    if (fs.existsSync(mp)) {
      try {
        fs.unlinkSync(mp);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/** Копирует jpeg/png из staging в постоянное хранилище (история чата / превью). */
function persistStagedImagesToStore(userId, imageFileIds) {
  const ids = Array.isArray(imageFileIds)
    ? imageFileIds.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => isUuidLike(x))
    : [];
  if (!ids.length) return;
  const srcDir = stagingDir(userId);
  const destRoot = path.join(UPLOADS_DIR, 'persisted', userId);
  fs.mkdirSync(destRoot, { recursive: true });
  if (!fs.existsSync(srcDir)) return;
  for (const id of ids) {
    let names;
    try {
      names = fs.readdirSync(srcDir);
    } catch (_) {
      continue;
    }
    const dataName = names.find((n) => n.startsWith(`${id}.`) && !n.endsWith('.meta.json'));
    if (!dataName) continue;
    const metaSrc = path.join(srcDir, `${id}.meta.json`);
    let mime = '';
    if (fs.existsSync(metaSrc)) {
      try {
        mime = String(JSON.parse(fs.readFileSync(metaSrc, 'utf8')).mime || '').toLowerCase();
      } catch (_) {
        /* ignore */
      }
    }
    if (mime !== 'image/jpeg' && mime !== 'image/png') continue;
    const srcFile = path.join(srcDir, dataName);
    const destFile = path.join(destRoot, dataName);
    const metaDest = path.join(destRoot, `${id}.meta.json`);
    try {
      fs.copyFileSync(srcFile, destFile);
      if (fs.existsSync(metaSrc)) {
        fs.copyFileSync(metaSrc, metaDest);
      }
    } catch (e) {
      logError(`PERSIST_IMG_FAIL user=${userId} id=${id} ${e.message}`);
    }
  }
}

/** Комментарии SSE как heartbeat (: \\n\\n), чтобы nginx не рвал долгую генерацию */
function attachSseHeartbeat(res, ms = 5000) {
  let cleared = false;
  const id = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(':\n\n');
    } catch (_) {
      /* ignore */
    }
  }, ms);
  const stop = () => {
    if (cleared) return;
    cleared = true;
    clearInterval(id);
  };
  res.once('close', stop);
  res.once('finish', stop);
  return stop;
}

app.use(userCookieMiddleware);
app.use(express.json({ limit: '50mb' }));

/** Превью сохранённых изображений из истории чата (cookie user_id). */
app.get('/api/attachments/:fileId', (req, res) => {
  try {
    const id = req.params.fileId;
    if (!isUuidLike(id)) {
      res.status(400).json({ error: 'bad_id' });
      return;
    }
    const dir = path.join(UPLOADS_DIR, 'persisted', req.userId);
    if (!fs.existsSync(dir)) {
      res.status(404).end();
      return;
    }
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      res.status(404).end();
      return;
    }
    const dataName = names.find((n) => n.startsWith(`${id}.`) && !n.endsWith('.meta.json'));
    if (!dataName) {
      res.status(404).end();
      return;
    }
    const fp = path.resolve(path.join(dir, dataName));
    if (!fp.startsWith(path.resolve(dir))) {
      res.status(404).end();
      return;
    }
    const lower = dataName.toLowerCase();
    let ct = 'application/octet-stream';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) ct = 'image/jpeg';
    else if (lower.endsWith('.png')) ct = 'image/png';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(fp);
  } catch (e) {
    logError(`API_ATTACHMENT_GET ${req.userId} ${e.message}`);
    res.status(500).end();
  }
});

app.get('/api/chats', (req, res) => {
  try {
    const data = loadUserFile(req.userId);
    res.json({ chats: data.chats });
  } catch (e) {
    logError(`API_CHATS_GET ${req.userId} ${e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.post('/api/chats', async (req, res) => {
  try {
    const titleRaw = req.body && typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const title = titleRaw ? titleRaw.slice(0, 120) : 'Новый чат';
    const chat = {
      id: `chat-${crypto.randomUUID()}`,
      title,
      updatedAt: Date.now(),
      messages: [],
    };
    await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      data.chats.unshift(chat);
      saveUserFile(req.userId, data);
    });
    logAccess(`API_CHAT_CREATE user=${req.userId} id=${chat.id}`);
    res.status(201).json({ chat });
  } catch (e) {
    logError(`API_CHATS_POST ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.delete('/api/chats/:chatId', async (req, res) => {
  const chatId = req.params.chatId;
  try {
    await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      data.chats = data.chats.filter((c) => c.id !== chatId);
      saveUserFile(req.userId, data);
    });
    logAccess(`API_CHAT_DELETE user=${req.userId} id=${chatId}`);
    res.status(204).end();
  } catch (e) {
    logError(`API_CHATS_DELETE ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** ---------- Studio (/lovable): проекты, план, согласование ---------- */

app.get('/api/studio/projects', (req, res) => {
  try {
    const data = loadUserFile(req.userId);
    res.json({
      projects: data.studioProjects.map((p) => enrichStudioProjectForClient(req.userId, p)),
    });
  } catch (e) {
    logError(`STUDIO_PROJECTS_GET ${req.userId} ${e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.post('/api/studio/projects', async (req, res) => {
  try {
    const nameRaw = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const name = nameRaw ? nameRaw.slice(0, 120) : 'Новый проект';
    let slug =
      req.body && typeof req.body.slug === 'string' ? req.body.slug.trim().toLowerCase() : '';
    if (slug && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      res.status(400).json({ error: 'invalid_slug' });
      return;
    }
    const project = {
      id: crypto.randomUUID(),
      name,
      slug: '',
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      plan: defaultStudioPlan(),
      taskStatus: 'idle',
    };
    await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const base = slug || slugifyStudioName(name);
      project.slug = studioUniqueSlug(base, data.studioProjects, null);
      data.studioProjects.push(project);
      saveUserFile(req.userId, data);
    });
    logAccess(`STUDIO_PROJECT_CREATE user=${req.userId} id=${project.id}`);
    res.status(201).json({ project: enrichStudioProjectForClient(req.userId, project) });
  } catch (e) {
    logError(`STUDIO_PROJECTS_POST ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.get('/api/studio/projects/:projectId', (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  try {
    const data = loadUserFile(req.userId);
    const project = data.studioProjects.find((p) => p.id === projectId);
    if (!project) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ project: enrichStudioProjectForClient(req.userId, project) });
  } catch (e) {
    logError(`STUDIO_PROJECT_GET ${req.userId} ${e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.patch('/api/studio/projects/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  try {
    const out = await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return { code: 404 };
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (typeof body.name === 'string') {
        const n = body.name.trim().slice(0, 120);
        if (n) project.name = n;
      }
      if (typeof body.slug === 'string') {
        const s = body.slug.trim().toLowerCase();
        if (s && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) {
          return { code: 400, err: 'invalid_slug' };
        }
        if (s) project.slug = studioUniqueSlug(s, data.studioProjects, projectId);
      }
      if (body.status === 'draft' || body.status === 'active' || body.status === 'archived') {
        project.status = body.status;
      }
      project.updatedAt = Date.now();
      saveUserFile(req.userId, data);
      return { project: JSON.parse(JSON.stringify(project)) };
    });
    if (out.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (out.code === 400) {
      res.status(400).json({ error: out.err || 'bad_request' });
      return;
    }
    res.json({ project: enrichStudioProjectForClient(req.userId, out.project) });
  } catch (e) {
    logError(`STUDIO_PROJECT_PATCH ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.delete('/api/studio/projects/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  try {
    const deleted = await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const before = data.studioProjects.length;
      data.studioProjects = data.studioProjects.filter((p) => p.id !== projectId);
      if (data.studioProjects.length === before) return false;
      saveUserFile(req.userId, data);
      return true;
    });
    if (!deleted) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    logAccess(`STUDIO_PROJECT_DELETE user=${req.userId} id=${projectId}`);
    res.status(204).end();
  } catch (e) {
    logError(`STUDIO_PROJECT_DELETE ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** Фаза 1 (план §4.2): файлы workspace без ревизий — список, чтение, запись (MVP). */
app.get('/api/studio/projects/:projectId/files', (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  try {
    const data = loadUserFile(req.userId);
    if (!data.studioProjects.some((p) => p.id === projectId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ws = ensureStudioWorkspaceScaffold(req.userId, projectId);
    const files = studioListWorkspaceFiles(ws);
    res.json({ files });
  } catch (e) {
    logError(`STUDIO_FILES_LIST ${req.userId} ${e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.get('/api/studio/projects/:projectId/files/content', (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const rel = studioSanitizeRelativePath(req.query.path);
  if (!rel) {
    res.status(400).json({ error: 'bad_path' });
    return;
  }
  try {
    const data = loadUserFile(req.userId);
    if (!data.studioProjects.some((p) => p.id === projectId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ws = ensureStudioWorkspaceScaffold(req.userId, projectId);
    const fp = studioResolveWorkspacePath(ws, rel);
    if (!fp || !fs.existsSync(fp)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const st = fs.statSync(fp);
    if (!st.isFile()) {
      res.status(400).json({ error: 'not_a_file' });
      return;
    }
    if (st.size > STUDIO_FILE_MAX_READ) {
      res.status(413).json({ error: 'file_too_large' });
      return;
    }
    const buf = fs.readFileSync(fp);
    let text;
    try {
      text = buf.toString('utf8');
    } catch {
      res.status(415).json({ error: 'binary_or_decode_error' });
      return;
    }
    res.json({ path: rel, content: text, encoding: 'utf8', size: st.size, mtime: st.mtimeMs });
  } catch (e) {
    logError(`STUDIO_FILE_GET ${req.userId} ${e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.put('/api/studio/projects/:projectId/files/content', (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rel = studioSanitizeRelativePath(body.path);
  if (!rel) {
    res.status(400).json({ error: 'bad_path' });
    return;
  }
  if (typeof body.content !== 'string') {
    res.status(400).json({ error: 'bad_content' });
    return;
  }
  const content = body.content.slice(0, STUDIO_FILE_MAX_WRITE);
  if (Buffer.byteLength(content, 'utf8') > STUDIO_FILE_MAX_WRITE) {
    res.status(413).json({ error: 'file_too_large' });
    return;
  }
  try {
    const data = loadUserFile(req.userId);
    const project = data.studioProjects.find((p) => p.id === projectId);
    if (!project) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ws = ensureStudioWorkspaceScaffold(req.userId, projectId);
    const fp = studioResolveWorkspacePath(ws, rel);
    if (!fp) {
      res.status(400).json({ error: 'bad_path' });
      return;
    }
    const parts = rel.split('/');
    if (parts.length && STUDIO_WORKSPACE_IGNORE.has(parts[0])) {
      res.status(403).json({ error: 'forbidden_path' });
      return;
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
    project.updatedAt = Date.now();
    saveUserFile(req.userId, data);
    logAccess(`STUDIO_FILE_PUT user=${req.userId} project=${projectId} path=${rel}`);
    res.json({ ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') });
  } catch (e) {
    logError(`STUDIO_FILE_PUT ${req.userId} ${e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** Фаза 1 (план §4.2): список снимков workspace. */
app.get('/api/studio/projects/:projectId/revisions', (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  try {
    const data = loadUserFile(req.userId);
    if (!data.studioProjects.some((p) => p.id === projectId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const revDir = studioRevisionDir(req.userId, projectId);
    const metas = studioListRevisionMetas(revDir);
    res.json({
      revisions: metas.map((m) => ({
        id: m.id,
        parent_revision_id: m.parent_revision_id,
        message: m.message,
        createdAt: m.createdAt,
        archiveBytes: m.archiveBytes,
      })),
    });
  } catch (e) {
    logError(`STUDIO_REVISIONS_GET ${req.userId} ${e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** Фаза 1: зафиксировать tar.gz снимок (без parent — корневой). */
app.post('/api/studio/projects/:projectId/revisions', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const parentRaw = body.parent_revision_id;
  const message = typeof body.message === 'string' ? body.message.slice(0, 500) : '';
  if (parentRaw != null && String(parentRaw).trim().length && !isUuidLike(String(parentRaw))) {
    res.status(400).json({ error: 'bad_parent_revision' });
    return;
  }
  try {
    const data = loadUserFile(req.userId);
    if (!data.studioProjects.some((p) => p.id === projectId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const revDir = studioRevisionDir(req.userId, projectId);
    fs.mkdirSync(revDir, { recursive: true });
    const parentId = parentRaw != null && String(parentRaw).trim().length ? String(parentRaw) : null;
    if (parentId) {
      const parentMeta = path.join(revDir, `${parentId}.meta.json`);
      if (!fs.existsSync(parentMeta)) {
        res.status(400).json({ error: 'parent_revision_not_found' });
        return;
      }
    }
    const ws = ensureStudioWorkspaceScaffold(req.userId, projectId);
    const revId = crypto.randomUUID();
    const archiveFile = `${revId}.tar.gz`;
    const archivePath = path.join(revDir, archiveFile);
    try {
      studioTarWorkspaceToFile(ws, archivePath);
    } catch (e) {
      logError(`STUDIO_REVISION_TAR ${e.message}`);
      try {
        fs.unlinkSync(archivePath);
      } catch (_) {
        /* */
      }
      res.status(500).json({ error: 'archive_failed', detail: String(e.message || e) });
      return;
    }
    let st;
    try {
      st = fs.statSync(archivePath);
    } catch {
      res.status(500).json({ error: 'archive_stat_failed' });
      return;
    }
    const meta = {
      id: revId,
      parent_revision_id: parentId,
      message,
      createdAt: Date.now(),
      archiveFile,
      archiveBytes: st.size,
    };
    fs.writeFileSync(path.join(revDir, `${revId}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
    studioPruneOldRevisions(revDir);
    await userTxn(req.userId, async () => {
      const d = loadUserFile(req.userId);
      const p = d.studioProjects.find((x) => x.id === projectId);
      if (!p) return;
      p.studioHeadRevisionId = revId;
      p.updatedAt = Date.now();
      saveUserFile(req.userId, d);
    });
    logAccess(`STUDIO_REVISION_CREATE user=${req.userId} project=${projectId} rev=${revId}`);
    res.status(201).json({ revision_id: revId });
  } catch (e) {
    logError(`STUDIO_REVISION_POST ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/**
 * Транзакция §4.2: применить operations (план проекта обязан быть approved).
 */
async function studioApplyWorkspacePatchTxn(userId, projectId, baseRevisionId, ops) {
  return userTxn(userId, async () => {
    const data = loadUserFile(userId);
    const project = data.studioProjects.find((p) => p.id === projectId);
    if (!project) return { code: 404 };
    if (project.plan.status !== 'approved') return { code: 409, err: 'studio_plan_not_approved' };
    const base = baseRevisionId;
    if (
      base != null &&
      String(base).trim().length > 0 &&
      project.studioHeadRevisionId &&
      String(base) !== project.studioHeadRevisionId
    ) {
      return {
        code: 409,
        err: 'revision_conflict',
        conflicts: [{ type: 'base_revision_id', expected: project.studioHeadRevisionId, got: String(base) }],
      };
    }
    if (!Array.isArray(ops) || ops.length === 0) return { code: 400, err: 'no_operations' };
    if (ops.length > STUDIO_WORKSPACE_PATCH_MAX_OPS) return { code: 400, err: 'too_many_operations' };
    const ws = ensureStudioWorkspaceScaffold(userId, projectId);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || typeof op !== 'object') return { code: 400, err: 'bad_operation', at: i };
      const kind = op.op;
      if (kind === 'write') {
        const rel = studioSanitizeRelativePath(op.path);
        if (!rel) return { code: 400, err: 'bad_path', at: i };
        if (typeof op.content_base64 !== 'string') return { code: 400, err: 'bad_content', at: i };
        let buf;
        try {
          buf = Buffer.from(op.content_base64, 'base64');
        } catch {
          return { code: 400, err: 'bad_base64', at: i };
        }
        if (buf.length > STUDIO_FILE_MAX_WRITE) return { code: 413, err: 'file_too_large', at: i };
        const parts = rel.split('/');
        if (parts.length && STUDIO_WORKSPACE_IGNORE.has(parts[0])) return { code: 403, err: 'forbidden_path', at: i };
        const fp = studioResolveWorkspacePath(ws, rel);
        if (!fp) return { code: 400, err: 'bad_path', at: i };
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, buf);
      } else if (kind === 'delete') {
        const rel = studioSanitizeRelativePath(op.path);
        if (!rel) return { code: 400, err: 'bad_path', at: i };
        const parts = rel.split('/');
        if (parts.length && STUDIO_WORKSPACE_IGNORE.has(parts[0])) return { code: 403, err: 'forbidden_path', at: i };
        const fp = studioResolveWorkspacePath(ws, rel);
        if (fp && fs.existsSync(fp)) fs.rmSync(fp, { force: true, recursive: true });
      } else if (kind === 'mkdir') {
        const rel = studioSanitizeRelativePath(op.path);
        if (!rel) return { code: 400, err: 'bad_path', at: i };
        const parts = rel.split('/');
        if (parts.length && STUDIO_WORKSPACE_IGNORE.has(parts[0])) return { code: 403, err: 'forbidden_path', at: i };
        const fp = studioResolveWorkspacePath(ws, rel);
        if (!fp) return { code: 400, err: 'bad_path', at: i };
        fs.mkdirSync(fp, { recursive: true });
      } else {
        return { code: 400, err: 'unknown_op', at: i, op: kind };
      }
    }
    project.updatedAt = Date.now();
    saveUserFile(userId, data);
    logAccess(`STUDIO_WORKSPACE_PATCH user=${userId} project=${projectId} ops=${ops.length}`);
    return { code: 200, applied: ops.length };
  });
}

async function studioTryRecoverWorkspaceFromBuildLog(userId, projectId, buildLogText) {
  let headRev = null;
  let projectPlan = '';
  await userTxn(userId, async () => {
    const data = loadUserFile(userId);
    const project = data.studioProjects.find((p) => p.id === projectId);
    if (!project) return;
    if (project.studioHeadRevisionId && isUuidLike(String(project.studioHeadRevisionId))) {
      headRev = project.studioHeadRevisionId;
    }
    projectPlan = project.plan && typeof project.plan.markdown === 'string' ? project.plan.markdown : '';
  });

  const ws = ensureStudioWorkspaceScaffold(userId, projectId);
  const files = studioListWorkspaceFiles(ws);
  const fileSummary = files.slice(0, 80).map((f) => f.path).join('\n') || '(пусто)';

  const jsonPrompt = buildStudioBuildRecoveryPrompt({
    headRevisionId: headRev,
    fileSummary,
    projectPlan,
    buildLogTail: buildLogText,
    maxOps: STUDIO_BUILD_RECOVERY_MAX_OPS,
  });

  const codeModel = ALLOWED_SET.has(STUDIO_AGENT_CODE_MODEL)
    ? STUDIO_AGENT_CODE_MODEL
    : await resolveModel('deepseek-coder:latest');

  const gen2 = await studioGenerateSingleResponse(codeModel, jsonPrompt);
  if (!gen2.ok) {
    logAccess(`STUDIO_BUILD_RECOVERY_LLM_FAIL user=${userId} project=${projectId} ${gen2.err || ''}`);
    return { applied: false, note: `LLM: ${gen2.err || 'json_failed'}` };
  }

  const parsed = parseAgentWorkspaceOperations(gen2.text);
  if (!parsed.ok || parsed.operations.length === 0) {
    return { applied: false, note: `Нет операций в ответе: ${parsed.err || 'empty'}` };
  }

  const ops = parsed.operations.slice(0, STUDIO_BUILD_RECOVERY_MAX_OPS);
  const bodyBase = headRev || parsed.base_revision_id || null;
  const patchOut = await studioApplyWorkspacePatchTxn(userId, projectId, bodyBase, ops);
  if (patchOut.code !== 200) {
    logAccess(
      `STUDIO_BUILD_RECOVERY_PATCH_FAIL user=${userId} project=${projectId} ${patchOut.err || patchOut.code}`,
    );
    const extra =
      patchOut.conflicts && patchOut.conflicts.length
        ? ` ${JSON.stringify(patchOut.conflicts)}`
        : '';
    return {
      applied: false,
      note: `Патч отклонён: ${patchOut.err || patchOut.code}${extra}`,
    };
  }

  logAccess(`STUDIO_BUILD_RECOVERY_OK user=${userId} project=${projectId} ops=${patchOut.applied}`);
  return { applied: true, note: `Применено операций: ${patchOut.applied}. Повторная сборка…` };
}

/**
 * Фаза 1 (план §4.2): батч-операций в workspace. Только после согласования плана (§1.6).
 * Ответ как в плане: `{ revision_id }` — новая ревизия не создаётся автоматически; вызовите POST …/revisions.
 */
app.patch('/api/studio/projects/:projectId/workspace', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const ops = body.operations;
  try {
    const out = await studioApplyWorkspacePatchTxn(req.userId, projectId, body.base_revision_id, ops);
    if (out.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (out.code === 409) {
      if (out.err === 'revision_conflict') {
        res.status(409).json({ error: out.err, conflicts: out.conflicts });
        return;
      }
      res.status(409).json({ error: out.err || 'conflict' });
      return;
    }
    if (out.code === 400) {
      res.status(400).json({ error: out.err || 'bad_request', at: out.at, op: out.op });
      return;
    }
    if (out.code === 413) {
      res.status(413).json({ error: out.err || 'file_too_large', at: out.at });
      return;
    }
    res.status(200).json({ revision_id: null, applied: out.applied });
  } catch (e) {
    logError(`STUDIO_WORKSPACE_PATCH ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** §4.3: задачи проекта. */
app.get('/api/studio/projects/:projectId/tasks', (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  try {
    const data = loadUserFile(req.userId);
    const project = data.studioProjects.find((p) => p.id === projectId);
    if (!project) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    normalizeStudioProjectTasks(project);
    res.json({ tasks: studioTasksForClient(project) });
  } catch (e) {
    logError(`STUDIO_TASKS_GET ${e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.post('/api/studio/projects/:projectId/tasks', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const titleRaw = typeof body.title === 'string' ? body.title.trim() : '';
  const promptRaw = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const title = titleRaw.slice(0, 200) || 'Задача';
  if (!promptRaw) {
    res.status(400).json({ error: 'prompt_required' });
    return;
  }
  const images = Array.isArray(body.images)
    ? body.images.filter((x) => typeof x === 'string' && x.length > 0).slice(0, 8)
    : [];
  try {
    const taskId = crypto.randomUUID();
    await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) {
        throw Object.assign(new Error('not_found'), { code: 404 });
      }
      normalizeStudioProjectTasks(project);
      if (project.tasks.length >= STUDIO_TASKS_MAX_PER_PROJECT) {
        throw Object.assign(new Error('tasks_limit'), { code: 400 });
      }
      const task = {
        id: taskId,
        title,
        prompt: promptRaw.slice(0, 20_000),
        images,
        status: 'open',
        planMarkdown: '',
        activeRunId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      project.tasks.push(task);
      project.updatedAt = Date.now();
      saveUserFile(req.userId, data);
    });
    logAccess(`STUDIO_TASK_CREATE user=${req.userId} project=${projectId} task=${taskId}`);
    res.status(201).json({ task: { id: taskId, title, status: 'open' } });
  } catch (e) {
    if (e && e.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (e && e.code === 400) {
      res.status(400).json({ error: 'tasks_limit' });
      return;
    }
    logError(`STUDIO_TASKS_POST ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.post('/api/studio/projects/:projectId/tasks/:taskId/approve-plan', async (req, res) => {
  const projectId = req.params.projectId;
  const taskId = req.params.taskId;
  if (!isUuidLike(projectId) || !isUuidLike(taskId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  try {
    const out = await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return { code: 404 };
      normalizeStudioProjectTasks(project);
      const task = findStudioTask(project, taskId);
      if (!task) return { code: 404 };
      if (task.status !== 'awaiting_task_plan_approval') {
        return { code: 409, err: 'task_plan_not_ready', status: task.status };
      }
      if (taskHasActiveAgentRun(task)) {
        return { code: 409, err: 'task_agent_running' };
      }
      task.status = 'approved';
      task.updatedAt = Date.now();
      project.updatedAt = Date.now();
      saveUserFile(req.userId, data);
      logAccess(`STUDIO_TASK_PLAN_APPROVE user=${req.userId} project=${projectId} task=${taskId}`);
      return { task: JSON.parse(JSON.stringify(task)) };
    });
    if (out.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (out.code === 409) {
      res.status(409).json({ error: out.err, taskStatus: out.status });
      return;
    }
    res.json({
      task: {
        id: out.task.id,
        title: out.task.title,
        status: out.task.status,
        planMarkdown: out.task.planMarkdown,
      },
    });
  } catch (e) {
    logError(`STUDIO_TASK_APPROVE ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** Чат премиум-агента (уточнения, chips, plan_markdown → план на согласование). */
app.post('/api/studio/projects/:projectId/agent/chat', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    res.status(400).json({ error: 'empty_message' });
    return;
  }
  if (!studioLlmUpstreamAvailable()) {
    res.status(503).json({ error: 'LLM_UNAVAILABLE', note: 'ollama_offline_no_cloud_keys' });
    return;
  }
  try {
    const first = await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return { code: 404 };
      normalizeStudioAgentChat(project);
      return {
        code: 200,
        transcript: studioAgentChatHistoryTranscript(project),
      };
    });
    if (first.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const prompt = buildStudioAgentChatPrompt(first.transcript, message.slice(0, 16_000));
    const model = await resolveModel(DEFAULT_MODEL);
    const gen = await studioGeneratePlainLlmText(model, prompt);
    if (!gen.ok) {
      res.status(503).json({ error: gen.err || 'llm_failed', detail: gen.detail });
      return;
    }
    const parsed = parseStudioAgentChatResponse(gen.text);
    const saved = await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const p = data.studioProjects.find((x) => x.id === projectId);
      if (!p) return { code: 404 };
      normalizeStudioAgentChat(p);
      const now = Date.now();
      p.studioAgentChat.push({
        role: 'user',
        content: message.slice(0, 16_000),
        at: now,
      });
      const assistantEntry = {
        role: 'assistant',
        content: parsed.reply.slice(0, 16_000),
        at: now + 1,
      };
      if (parsed.chips && parsed.chips.length) assistantEntry.chips = parsed.chips;
      p.studioAgentChat.push(assistantEntry);
      normalizeStudioAgentChat(p);
      let planUpdated = false;
      if (parsed.plan_markdown && String(parsed.plan_markdown).trim().length >= 120) {
        p.plan = {
          markdown: String(parsed.plan_markdown).trim().slice(0, 50_000),
          status: 'pending_approval',
          updatedAt: Date.now(),
        };
        p.taskStatus = 'awaiting_user_approval';
        planUpdated = true;
      }
      p.updatedAt = Date.now();
      saveUserFile(req.userId, data);
      return {
        code: 200,
        planUpdated,
        enriched: enrichStudioProjectForClient(req.userId, JSON.parse(JSON.stringify(p))),
      };
    });
    if (saved.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    logAccess(`STUDIO_AGENT_CHAT user=${req.userId} project=${projectId} plan=${saved.planUpdated}`);
    res.json({
      reply: parsed.reply,
      chips: parsed.chips,
      plan_updated: saved.planUpdated,
      project: saved.enriched,
    });
  } catch (e) {
    logError(`STUDIO_AGENT_CHAT ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** §4.3: запуск агента (план или реализация после согласований). Ответ: { run_id }; стрим — GET …/agent/stream/:runId */
app.post('/api/studio/projects/:projectId/agent/run', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const taskId = typeof body.task_id === 'string' ? body.task_id.trim() : '';
  const mode = body.mode === 'implement' ? 'implement' : 'plan';
  if (!isUuidLike(taskId)) {
    res.status(400).json({ error: 'bad_task_id' });
    return;
  }
  if (!studioLlmUpstreamAvailable()) {
    res.status(503).json({ error: 'LLM_UNAVAILABLE', note: 'ollama_offline_no_cloud_keys' });
    return;
  }
  if (studioAgentActiveRunCountForUser(req.userId) >= STUDIO_AGENT_MAX_RUNS_PER_USER) {
    res.status(429).json({ error: 'studio_agent_runs_limit' });
    return;
  }
  try {
    const out = await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return { code: 404 };
      normalizeStudioProjectTasks(project);
      const task = findStudioTask(project, taskId);
      if (!task) return { code: 404 };
      if (taskHasActiveAgentRun(task)) {
        return { code: 409, err: 'task_agent_running' };
      }
      if (mode === 'plan') {
        const okStates = new Set(['open', 'error', 'awaiting_task_plan_approval']);
        if (!okStates.has(task.status)) {
          return { code: 409, err: 'bad_task_state_for_plan', taskStatus: task.status };
        }
      } else {
        if (task.status !== 'approved') {
          return { code: 409, err: 'task_not_approved', taskStatus: task.status };
        }
        if (project.plan.status !== 'approved') {
          return { code: 409, err: 'project_plan_not_approved' };
        }
      }
      const runId = crypto.randomUUID();
      studioAgentRuns.set(runId, {
        userId: req.userId,
        projectId,
        taskId,
        mode,
        events: [],
        subscribers: new Set(),
        done: false,
      });
      task.activeRunId = runId;
      task.status = mode === 'plan' ? 'planning' : 'implementing';
      task.updatedAt = Date.now();
      project.updatedAt = Date.now();
      saveUserFile(req.userId, data);
      return { runId };
    });
    if (out.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (out.code === 409) {
      res.status(409).json({ error: out.err, taskStatus: out.taskStatus });
      return;
    }
    logAccess(`STUDIO_AGENT_RUN user=${req.userId} project=${projectId} run=${out.runId} mode=${mode}`);
    res.status(202).json({ run_id: out.runId });
    setImmediate(() => {
      void executeStudioAgentRun(out.runId);
    });
  } catch (e) {
    logError(`STUDIO_AGENT_RUN_POST ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

app.get('/api/studio/projects/:projectId/agent/stream/:runId', (req, res) => {
  const projectId = req.params.projectId;
  const runId = req.params.runId;
  if (!isUuidLike(projectId) || !isUuidLike(runId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const run = studioAgentRuns.get(runId);
  if (!run || run.userId !== req.userId || run.projectId !== projectId) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  for (const ev of run.events) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  if (run.done) {
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  run.subscribers.add(res);
  req.on('close', () => {
    run.subscribers.delete(res);
  });
});

/** Черновик плана (агент или заглушка). status в теле: draft → правка без ожидания апрува; иначе → pending_approval */
app.post('/api/studio/projects/:projectId/plan', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const markdown =
    req.body && typeof req.body.markdown === 'string' ? req.body.markdown.slice(0, 50_000) : '';
  const want =
    req.body && req.body.status === 'draft' ? 'draft' : 'pending_approval';
  if (!markdown.trim()) {
    res.status(400).json({ error: 'empty_plan' });
    return;
  }
  try {
    const out = await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return { code: 404 };
      project.plan = {
        markdown,
        status: want === 'draft' ? 'draft' : 'pending_approval',
        updatedAt: Date.now(),
      };
      project.taskStatus = want === 'draft' ? 'planning' : 'awaiting_user_approval';
      project.updatedAt = Date.now();
      saveUserFile(req.userId, data);
      return { project: JSON.parse(JSON.stringify(project)) };
    });
    if (out.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ project: enrichStudioProjectForClient(req.userId, out.project) });
  } catch (e) {
    logError(`STUDIO_PLAN_POST ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** Согласование плана пользователем — после этого разрешена реализация (оркестратор позже). */
app.post('/api/studio/projects/:projectId/plan/approve', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  try {
    const out = await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return { code: 404 };
      if (project.plan.status !== 'pending_approval') {
        return { code: 409, planStatus: project.plan.status };
      }
      project.plan = {
        ...project.plan,
        status: 'approved',
        updatedAt: Date.now(),
      };
      project.taskStatus = 'implementing';
      project.updatedAt = Date.now();
      saveUserFile(req.userId, data);
      logAccess(`STUDIO_PLAN_APPROVE user=${req.userId} project=${projectId}`);
      return { project: JSON.parse(JSON.stringify(project)) };
    });
    if (out.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (out.code === 409) {
      res.status(409).json({ error: 'plan_not_awaiting_approval', planStatus: out.planStatus });
      return;
    }
    res.json({ project: enrichStudioProjectForClient(req.userId, out.project) });
  } catch (e) {
    logError(`STUDIO_PLAN_APPROVE ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** После approve плана: один LLM-проход (нарратив + JSON ops) и PATCH workspace. */
app.post('/api/studio/projects/:projectId/agent/apply-approved-plan', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  if (!studioLlmUpstreamAvailable()) {
    res.status(503).json({ error: 'LLM_UNAVAILABLE' });
    return;
  }
  try {
    const peek = await userTxn(req.userId, async () => {
      const data = loadUserFile(req.userId);
      const project = data.studioProjects.find((p) => p.id === projectId);
      if (!project) return { code: 404 };
      if (project.plan.status !== 'approved') {
        return { code: 409, err: 'plan_not_approved', planStatus: project.plan.status };
      }
      const headRev =
        project.studioHeadRevisionId && isUuidLike(String(project.studioHeadRevisionId))
          ? project.studioHeadRevisionId
          : null;
      return {
        code: 200,
        headRev,
        projPlanMd: typeof project.plan.markdown === 'string' ? project.plan.markdown : '',
        projectName: typeof project.name === 'string' ? project.name : 'Проект',
      };
    });
    if (peek.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (peek.code === 409) {
      res.status(409).json({ error: peek.err, planStatus: peek.planStatus });
      return;
    }
    let ws;
    try {
      ws = ensureStudioWorkspaceScaffold(req.userId, projectId);
    } catch (e) {
      if (String(e.message || e) === 'studio_template_missing') {
        res.status(500).json({ error: 'studio_template_missing' });
        return;
      }
      throw e;
    }
    const files = studioListWorkspaceFiles(ws);
    const fileSummary = files.slice(0, 60).map((f) => f.path).join('\n') || '(пусто)';
    const model = await resolveModel(DEFAULT_MODEL);
    const narrativePrompt = buildStudioImplementModePrompt(
      peek.projectName,
      'Реализуй согласованный план проекта в workspace: полноценный интерфейс Vite+React+TypeScript премиум-качества, готовый к production-сборке.',
      '',
      peek.projPlanMd,
    );
    const nar = await studioGeneratePlainLlmText(model, narrativePrompt);
    if (!nar.ok) {
      res.status(503).json({ error: nar.err || 'llm_narrative_failed' });
      return;
    }
    const jsonPrompt = buildStudioJsonOpsPrompt({
      title: peek.projectName,
      userPrompt:
        'Соблюдай согласованный план проекта; реализуй UI, состояния, типографику и микровзаимодействия на уровне готового продукта.',
      taskPlan: '',
      projectPlan: peek.projPlanMd,
      narrative: nar.text,
      headRevisionId: peek.headRev,
      fileSummary,
      maxOps: STUDIO_AGENT_IMPLEMENT_MAX_OPS,
    });
    const codeModel = ALLOWED_SET.has(STUDIO_AGENT_CODE_MODEL)
      ? STUDIO_AGENT_CODE_MODEL
      : await resolveModel('deepseek-coder:latest');
    const gen2 = await studioGenerateSingleResponse(codeModel, jsonPrompt);
    if (!gen2.ok) {
      res.status(503).json({ error: gen2.err || 'llm_json_failed', detail: gen2.detail });
      return;
    }
    const parsed = parseAgentWorkspaceOperations(gen2.text);
    if (!parsed.ok || parsed.operations.length === 0) {
      res.status(400).json({ error: parsed.err || 'bad_operations_json' });
      return;
    }
    const ops = parsed.operations.slice(0, STUDIO_AGENT_IMPLEMENT_MAX_OPS);
    const bodyBase = peek.headRev || parsed.base_revision_id || null;
    const patchOut = await studioApplyWorkspacePatchTxn(req.userId, projectId, bodyBase, ops);
    if (patchOut.code === 404) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (patchOut.code === 409) {
      res.status(409).json({
        error: patchOut.err || 'patch_conflict',
        conflicts: patchOut.conflicts,
      });
      return;
    }
    if (patchOut.code === 400) {
      res.status(400).json({ error: patchOut.err || 'bad_request', at: patchOut.at, op: patchOut.op });
      return;
    }
    if (patchOut.code === 413) {
      res.status(413).json({ error: patchOut.err || 'file_too_large', at: patchOut.at });
      return;
    }
    logAccess(
      `STUDIO_APPLY_APPROVED_PLAN user=${req.userId} project=${projectId} applied=${patchOut.applied}`,
    );
    res.status(200).json({ applied: patchOut.applied, revision_id: null });
  } catch (e) {
    logError(`STUDIO_APPLY_APPROVED_PLAN ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/** Фаза 2 (MVP): фоновая сборка static preview из шаблона Vite в workspace; Docker/nginx-map — эволюция. */
app.post('/api/studio/projects/:projectId/studio-build', async (req, res) => {
  const projectId = req.params.projectId;
  if (!isUuidLike(projectId)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const key = studioLockKey(req.userId, projectId);
  if (studioBuildInProgress.has(key)) {
    res.status(409).json({ error: 'build_in_progress' });
    return;
  }
  try {
    const data = loadUserFile(req.userId);
    const project = data.studioProjects.find((p) => p.id === projectId);
    if (!project) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (project.plan.status !== 'approved') {
      res.status(409).json({ error: 'plan_not_approved' });
      return;
    }
    if (studioActiveBuildCountGlobal() >= STUDIO_MAX_BUILDS_GLOBAL) {
      res.status(429).json({ error: 'builds_queue_full_global' });
      return;
    }
    if (studioActiveBuildCountForUser(req.userId) >= STUDIO_MAX_BUILDS_PER_USER) {
      res.status(429).json({ error: 'builds_queue_full_user' });
      return;
    }
    studioBuildInProgress.add(key);
    await userTxn(req.userId, async () => {
      const d = loadUserFile(req.userId);
      const p = d.studioProjects.find((x) => x.id === projectId);
      if (!p) return;
      p.taskStatus = 'building';
      p.updatedAt = Date.now();
      saveUserFile(req.userId, d);
    });
    logAccess(`STUDIO_PREVIEW_BUILD_QUEUED user=${req.userId} project=${projectId}`);
    res.status(202).json({ accepted: true });
    setImmediate(() => {
      void executeStudioPreviewBuild(req.userId, projectId);
    });
  } catch (e) {
    studioBuildInProgress.delete(key);
    logError(`STUDIO_PREVIEW_BUILD_POST ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

/**
 * Публичное превью по подписанному токену (план §5.4 path-based). Без cookie: только GET статики dist.
 * nginx: location /preview/ → proxy_pass на этот же процесс.
 */
app.use('/preview', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).type('text/plain; charset=utf-8').send('Method not allowed');
    return;
  }
  const fullUrl = req.url || '/';
  const qIdx = fullUrl.indexOf('?');
  const pathOnly = qIdx === -1 ? fullUrl : fullUrl.slice(0, qIdx);
  const qs = qIdx === -1 ? '' : fullUrl.slice(qIdx);
  /** Документ без завершающего / (`/preview/token`) ломает разрешение `./assets/` → `/preview/assets/ (белый экран). */
  const bareTokenOnly = pathOnly.match(/^\/([^/]+)$/);
  if (bareTokenOnly) {
    res.redirect(302, `/preview/${bareTokenOnly[1]}/` + qs);
    return;
  }
  const m = pathOnly.match(/^\/([^/]+)(\/.*)?$/);
  if (!m) {
    res.status(404).type('text/plain; charset=utf-8').send('Not found');
    return;
  }
  const token = m[1];
  const rel = m[2] && m[2].length > 0 ? m[2] : '/';
  const decoded = verifyStudioPreviewToken(token);
  if (!decoded) {
    res
      .status(404)
      .type('text/plain; charset=utf-8')
      .send('Ссылка недействительна или срок действия истёк.');
    return;
  }
  const root = path.join(STUDIO_WORKSPACES_ROOT, decoded.userId, decoded.projectId, 'dist');
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    res.status(404).type('text/plain; charset=utf-8').send('Превью не собрано.');
    return;
  }
  req.url = rel + qs;
  express.static(root, { index: false, fallthrough: true })(req, res, (err) => {
    if (err) return next(err);
    if (res.writableEnded || res.headersSent) return undefined;
    if (req.method === 'HEAD') {
      res.status(200).end();
      return undefined;
    }
    return res.sendFile(path.join(root, 'index.html'), (e) => (e ? next(e) : undefined));
  });
});

/** Раздача собранного dist. */
app.use(
  '/api/studio/projects/:projectId/preview',
  (req, res, next) => {
    try {
      const { projectId } = req.params;
      if (!isUuidLike(projectId)) {
        res.status(400).json({ error: 'bad_id' });
        return;
      }
      const data = loadUserFile(req.userId);
      if (!data.studioProjects.some((p) => p.id === projectId)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const root = path.join(STUDIO_WORKSPACES_ROOT, req.userId, projectId, 'dist');
      if (!fs.existsSync(path.join(root, 'index.html'))) {
        res
          .status(404)
          .type('text/plain; charset=utf-8')
          .send('Превью недоступно: выполните «Собрать превью».');
        return;
      }
      req.studioPreviewRoot = root;
      next();
    } catch (e) {
      logError(`STUDIO_PREVIEW_GATE ${e.message}`);
      res.status(500).end();
    }
  },
  (req, res, next) => {
    express.static(req.studioPreviewRoot, { index: 'index.html' })(req, res, next);
  },
);

app.post(
  '/api/upload',
  uploadStaging.array('files', 8),
  handleMulterOrUploadError,
  async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ error: 'no_files' });
      }
      const dir = stagingDir(req.userId);
      const fileIds = [];
      for (const f of files) {
        const destBase = path.basename(f.path || f.filename || '');
        const dot = destBase.lastIndexOf('.');
        const id = dot > 0 ? destBase.slice(0, dot) : destBase;
        if (!isUuidLike(id)) {
          logError(`API_UPLOAD bad_filename ${destBase}`);
          return res.status(500).json({ error: 'upload_internal' });
        }
        fs.writeFileSync(
          path.join(dir, `${id}.meta.json`),
          JSON.stringify({
            mime: String(f.mimetype || 'application/octet-stream').toLowerCase(),
            originalname: path.basename(f.originalname || destBase),
          }),
        );
        fileIds.push(id);
      }
      logAccess(`API_UPLOAD_OK user=${req.userId} n=${fileIds.length}`);
      res.json({ fileIds });
    } catch (e) {
      logError(`API_UPLOAD ${e.stack || e.message}`);
      res.status(500).json({ error: 'upload_failed' });
    }
  },
);

app.post('/api/chats/:chatId/message', async (req, res) => {
  const chatId = req.params.chatId;
  console.log('[CHAT] start request');

  let stopHeartbeat = () => {};
  let activeHeld = false;
  const releaseConcurrency = () => {
    if (!activeHeld) return;
    activeHeld = false;
    activeRequests -= 1;
  };

  /** @type {{ promptFull: string, modelUsed: string, imagesForOllama?: string[], userMsgId: string, asstMsgId: string } | null} */
  let streamMeta = null;

  let sseOpened = false;

  const openSSE = () => {
    if (sseOpened) return;
    sseOpened = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    res.write('event: ready\n');
    res.write('data: {}\n\n');
    console.log('[CHAT] SSE opened');
  };

  /** Все ошибки маршрута — только SSE + [DONE] (совместимо с фронтом: type / status / error). */
  const sseError = (code, message) => {
    stopHeartbeat();
    openSSE();
    try {
      if (!res.writableEnded) {
        res.write('event: error\n');
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            error: message,
            status: code,
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (_) {
      /* ignore */
    }
  };

  try {
    openSSE();
    stopHeartbeat = attachSseHeartbeat(res);

    const body = req.body || {};
    const textIn =
      typeof body.message === 'string'
        ? body.message.trim()
        : typeof body.content === 'string'
          ? body.content.trim()
          : '';
    const fileIdsRaw = Array.isArray(body.fileIds) ? body.fileIds : [];

    const usedFileIds = fileIdsRaw
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter((x) => isUuidLike(x))
      .slice(0, 8);

    if (!textIn && usedFileIds.length === 0) {
      sseError(400, 'empty_message');
      return;
    }
    if (textIn.length > MAX_USER_MESSAGE_CHARS) {
      sseError(400, 'text_too_long');
      return;
    }

    /** @type {{ buffer: Buffer, mime: string, filename: string }[]} */
    let fileBuffers;
    try {
      fileBuffers = loadStagedFileBuffers(req.userId, fileIdsRaw);
    } catch (_) {
      sseError(400, 'invalid_or_missing_files');
      return;
    }

    const docLike = fileBuffers.filter((f) => {
      const m = String(f.mime || '').toLowerCase();
      return m === 'text/plain' || m === 'application/pdf';
    });
    if (docLike.length > MAX_DOCUMENT_FILES_PER_MESSAGE) {
      sseError(400, 'too_many_documents');
      return;
    }

    for (const f of fileBuffers) {
      const mime = String(f.mime || '').toLowerCase();
      if (
        (mime === 'image/jpeg' || mime === 'image/png') &&
        f.buffer.length > MAX_IMAGE_UPLOAD_BYTES
      ) {
        sseError(400, 'image_too_large');
        return;
      }
    }

    const imageBase64List = [];
    /** @type {{ name: string, text: string }[]} */
    const docsPayload = [];

    try {
      for (const f of fileBuffers) {
        const mime = String(f.mime || '').toLowerCase();
        const buf = f.buffer;
        if (mime === 'image/jpeg' || mime === 'image/png') {
          imageBase64List.push(buf.toString('base64'));
        } else if (mime === 'text/plain') {
          const rawTxt = buf.toString('utf8');
          docsPayload.push({
            name: path.basename(f.filename),
            text: truncateChars(rawTxt, MAX_DOC_CHARS_PER_FILE),
          });
        } else if (mime === 'application/pdf') {
          let extracted = roughPdfTextBuffer(buf);
          if (!extracted) {
            sseError(400, 'pdf_text_extract_failed');
            return;
          }
          extracted = truncateChars(extracted, MAX_DOC_CHARS_PER_FILE);
          docsPayload.push({
            name: path.basename(f.filename),
            text: extracted,
          });
        }
      }
    } catch (e) {
      logError(`API_MESSAGE_READ_FILE ${e.stack || e.message}`);
      sseError(400, 'file_read_failed');
      return;
    }

    const hasVision = imageBase64List.length > 0;

    /** @type {{ kind: 'image', id: string, name: string }[]} */
    const persistedImageAttachments = [];
    for (let fi = 0; fi < usedFileIds.length; fi += 1) {
      const fid = usedFileIds[fi];
      const fb = fileBuffers[fi];
      if (!fid || !fb) continue;
      const mime = String(fb.mime || '').toLowerCase();
      if (mime === 'image/jpeg' || mime === 'image/png') {
        persistedImageAttachments.push({
          kind: 'image',
          id: fid,
          name: path.basename(String(fb.filename || 'image.jpg')),
        });
      }
    }

    let userLine =
      textIn ||
      (hasVision ? 'Опиши изображение' : '') ||
      (docsPayload.length ? 'Вот документ' : '');

    let persistedUser = userLine;
    if (docsPayload.length > 0) {
      const docBlock = docsPayload.map((d) => `[${d.name}]\n${d.text}`).join('\n\n');
      persistedUser += `\n\nДокументы:\n${docBlock}`;
    }

    if (ollamaHealthCached.status !== 'ok' && !studioLlmFallbackConfigured()) {
      sseError(503, 'OLLAMA_OFFLINE');
      return;
    }

    if (activeRequests >= MAX_CONCURRENT) {
      sseError(429, 'Too many concurrent requests');
      return;
    }

    activeRequests += 1;
    activeHeld = true;
    res.once('close', releaseConcurrency);

    try {
      streamMeta = await userTxn(req.userId, async () => {
        const data = loadUserFile(req.userId);
        const chat = data.chats.find((c) => c.id === chatId);
        if (!chat) {
          const err = new Error('chat_not_found');
          err.code = 'NOT_FOUND';
          throw err;
        }
        if (!Array.isArray(chat.messages)) chat.messages = [];

        const priorPromptRows = chat.messages.map((m) => ({
          role: m.role,
          content: String(m.content || ''),
        }));

        const historySlice = priorPromptRows.slice(-MAX_HISTORY_MESSAGES);

        const promptFull = buildUnifiedPrompt({
          messages: historySlice,
          userMessage: userLine,
          docs: docsPayload,
          imagesCount: imageBase64List.length,
        });

        if (promptFull.length > MAX_PROMPT_CHARS) {
          const err = new Error('prompt_long');
          err.code = 'PROMPT_LONG';
          throw err;
        }

        if (chat.messages.length === 0) {
          chat.title = (textIn || (hasVision ? 'Изображение' : 'Чат')).slice(0, 42);
        }

        const userMsgId = crypto.randomUUID();
        const asstMsgId = crypto.randomUUID();

        const userMsg = {
          id: userMsgId,
          role: 'user',
          content: persistedUser,
        };
        if (persistedImageAttachments.length > 0) {
          userMsg.attachments = persistedImageAttachments;
        }
        chat.messages.push(userMsg);

        let modelUsed = selectModel({ hasImages: hasVision });
        let imagesForOllama;

        if (hasVision) {
          imagesForOllama = imageBase64List.slice(0, 8);
          const vm = selectModel({ hasImages: true });
          if (!ALLOWED_SET.has(vm) && !ALLOWED_SET.has(LLAVA_MODEL)) {
            const err = new Error('vision_model_not_allowed');
            err.code = 'CONFIG';
            throw err;
          }
        } else if (!ALLOWED_SET.has('llama3:latest')) {
          const err = new Error('llama3_not_allowed');
          err.code = 'CONFIG';
          throw err;
        }

        chat.messages.push({
          id: asstMsgId,
          role: 'assistant',
          content: '',
        });
        chat.updatedAt = Date.now();
        saveUserFile(req.userId, data);

        return {
          promptFull,
          modelUsed,
          imagesForOllama:
            imagesForOllama && imagesForOllama.length ? imagesForOllama : undefined,
          userMsgId,
          asstMsgId,
        };
      });
    } catch (err) {
      releaseConcurrency();

      if (err && err.code === 'NOT_FOUND') {
        sseError(404, 'chat_not_found');
        return;
      }
      if (err && err.code === 'PROMPT_LONG') {
        sseError(400, 'prompt_too_long');
        return;
      }
      if (err && err.code === 'CONFIG') {
        sseError(500, String(err.message));
        return;
      }

      logError(`API_MESSAGE_PREP_ERR ${req.userId} ${err.stack || err.message}`);
      sseError(500, 'storage_error');
      return;
    }

    if (persistedImageAttachments.length > 0) {
      persistStagedImagesToStore(req.userId, persistedImageAttachments.map((a) => a.id));
    }

    console.log('[CHAT] before ollama');

    res.write(
      `data: ${JSON.stringify({
        type: 'meta',
        userMessageId: streamMeta.userMsgId,
        assistantMessageId: streamMeta.asstMsgId,
      })}\n\n`,
    );

    const cloudPromptForChat = () => {
      let p = streamMeta.promptFull;
      if (streamMeta.imagesForOllama?.length) {
        p = `${p}\n\n[Системное примечание: пользователь прикрепил изображение(я); локальная Ollama недоступна — ответь по тексту запроса и истории; не утверждай точное содержимое пикселей изображения.]`;
      }
      return p;
    };

    const streamCloudDeltasToChat = async () => {
      const cloud = await studioLlmCompleteCloud(cloudPromptForChat(), STUDIO_CLOUD_MAX_TOKENS, 'stream');
      if (!cloud.ok) return { ok: false, err: cloud.err };
      const step = 80;
      for (let i = 0; i < cloud.text.length; i += step) {
        if (req.aborted || res.writableEnded) break;
        res.write(`data: ${JSON.stringify({ type: 'delta', delta: cloud.text.slice(i, i + step) })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }
      logAccess(`API_MESSAGE_CLOUD user=${req.userId} chat=${chatId} provider=${cloud.provider}`);
      return { ok: true, text: cloud.text };
    };

    const finalizeChatAssistant = async (accumulated) => {
      let chatSnapshot;
      await userTxn(req.userId, async () => {
        const data = loadUserFile(req.userId);
        const chat = data.chats.find((c) => c.id === chatId);
        if (!chat || !Array.isArray(chat.messages)) return;
        const am = chat.messages.find((m) => m.id === streamMeta.asstMsgId);
        if (am) am.content = accumulated;
        chat.updatedAt = Date.now();
        saveUserFile(req.userId, data);
        chatSnapshot = JSON.parse(JSON.stringify(chat));
      });
      const assistantMessage =
        chatSnapshot &&
        chatSnapshot.messages &&
        chatSnapshot.messages.find((m) => m.id === streamMeta.asstMsgId);
      stopHeartbeat();
      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          chat: chatSnapshot,
          assistantMessage: assistantMessage || null,
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      cleanupStagedFileSet(req.userId, usedFileIds);
      console.log('[CHAT] done');
      logAccess(`API_MESSAGE_STREAM_OK user=${req.userId} chat=${chatId} vision=${hasVision ? 1 : 0}`);
    };

    if (ollamaHealthCached.status !== 'ok') {
      const cr = await streamCloudDeltasToChat();
      if (!cr.ok) {
        try {
          await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
        } catch (_) {
          /* ignore */
        }
        sseError(503, 'LLM_UNAVAILABLE');
        releaseConcurrency();
        return;
      }
      await finalizeChatAssistant(cr.text || '');
      releaseConcurrency();
      return;
    }

    const upstreamPayload = {
      model: streamMeta.modelUsed,
      prompt: streamMeta.promptFull,
      stream: true,
    };
    if (streamMeta.imagesForOllama && streamMeta.imagesForOllama.length > 0) {
      upstreamPayload.images = streamMeta.imagesForOllama;
    }

    if (upstreamPayload.images?.length) {
      upstreamPayload.model = await resolveVisionModel(streamMeta.modelUsed);
    } else {
      upstreamPayload.model = await resolveModel(streamMeta.modelUsed);
    }

    stripImagesIfUnsupported(upstreamPayload, upstreamPayload.model);

    console.log('[OLLAMA] request start');
    console.log('[OLLAMA] waiting response...');

    let upstream;
    /** Прервать чтение тела после заголовков (тот же AbortController, что и для fetch). */
    let upstreamAbort = () => {};
    try {
      const { response, abort } = await fetchOllamaStream(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(upstreamPayload),
      });
      upstream = response;
      upstreamAbort = abort;
      console.log('[CHAT] ollama responded');
    } catch (fetchErr) {
      console.error('[OLLAMA ERROR]', fetchErr);
      logError(`API_MESSAGE_STREAM_FETCH ${req.userId} ${fetchErr.stack || fetchErr.message}`);
      if (isOllamaOutOfMemoryMessage(fetchErr.message)) {
        console.error('[MODEL] not enough memory');
        try {
          await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
        } catch (_) {
          /* ignore */
        }
        sseError(503, 'MODEL_OUT_OF_MEMORY');
        releaseConcurrency();
        return;
      }
      const aborted =
        fetchErr &&
        (fetchErr.name === 'AbortError' ||
          fetchErr.code === 'ABORT_ERR' ||
          (fetchErr.cause && fetchErr.cause.name === 'AbortError'));
      if (aborted) {
        try {
          await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
        } catch (_) {
          /* ignore */
        }
        sseError(504, 'OLLAMA_TIMEOUT');
        releaseConcurrency();
        return;
      }
      const cr = await streamCloudDeltasToChat();
      if (cr.ok) {
        await finalizeChatAssistant(cr.text || '');
        releaseConcurrency();
        return;
      }
      try {
        await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
      } catch (_) {
        /* ignore */
      }
      sseError(503, 'OLLAMA_FAILED');
      releaseConcurrency();
      return;
    }

    const cleanupUpstream = () => {
      safeCancelFetchBody(upstream.body);
      try {
        upstreamAbort();
      } catch (_) {
        /* ignore */
      }
    };

    req.once('close', cleanupUpstream);

    if (!upstream.ok || upstream.body == null) {
      let text = '';
      try {
        text = await upstream.text();
      } catch (_) {
        /* ignore */
      }
      logError(`API_MESSAGE_STREAM_HTTP status=${upstream.status} body=${text.slice(0, 600)}`);
      if (isOllamaOutOfMemoryMessage(text)) {
        console.error('[MODEL] not enough memory');
        await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
        sseError(503, 'MODEL_OUT_OF_MEMORY');
        cleanupUpstream();
        releaseConcurrency();
        return;
      }
      const cr = await streamCloudDeltasToChat();
      if (cr.ok) {
        cleanupUpstream();
        await finalizeChatAssistant(cr.text || '');
        releaseConcurrency();
        return;
      }
      await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
      const offline = upstream.status === 503 || upstream.status === 502;
      sseError(offline ? 503 : upstream.status, offline ? 'OLLAMA_OFFLINE' : 'upstream_error');
      cleanupUpstream();
      releaseConcurrency();
      return;
    }

    console.log('[CHAT] ollama response started');
    console.log('[OLLAMA] waiting first chunk...');

    let chatStreamHardStop = false;

    let firstChunkReceived = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let firstChunkTimer;

    firstChunkTimer = setTimeout(() => {
      if (firstChunkReceived) return;
      console.error('[OLLAMA] first chunk timeout');
      try {
        upstreamAbort();
      } catch (_) {
        /* ignore */
      }
      safeCancelFetchBody(upstream.body);
      void rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId).finally(() => {
        sseError(504, 'OLLAMA_NO_RESPONSE');
        releaseConcurrency();
      });
    }, OLLAMA_FIRST_CHUNK_TIMEOUT_MS);

    const clearFirstChunkTimer = () => {
      if (firstChunkTimer !== undefined) {
        clearTimeout(firstChunkTimer);
        firstChunkTimer = undefined;
      }
    };

    const nodeReadable = Readable.fromWeb(upstream.body);
    const rl = readline.createInterface({ input: nodeReadable, crlfDelay: Infinity });

    console.log('[CHAT] streaming...');

    let accumulated = '';
    try {
      for await (const line of rl) {
        if (req.aborted || res.writableEnded) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          clearFirstChunkTimer();
          console.log('[OLLAMA] first chunk received');
        }
        let obj;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const errTxt = ollamaErrorTextFromGenerateJson(obj);
        if (errTxt && isOllamaOutOfMemoryMessage(errTxt)) {
          console.error('[MODEL] not enough memory');
          await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
          sseError(503, 'MODEL_OUT_OF_MEMORY');
          chatStreamHardStop = true;
          break;
        }
        const piece = typeof obj.response === 'string' ? obj.response : '';
        accumulated += piece;
        if (piece) {
          res.write(`data: ${JSON.stringify({ type: 'delta', delta: piece })}\n\n`);
        }
        if (typeof res.flush === 'function') res.flush();
      }
    } finally {
      clearFirstChunkTimer();
      rl.close();
      try {
        nodeReadable.destroy();
      } catch (_) {
        /* ignore */
      }
      cleanupUpstream();
    }

    if (chatStreamHardStop) {
      releaseConcurrency();
      return;
    }

    await finalizeChatAssistant(accumulated);
    releaseConcurrency();
  } catch (pipeErr) {
    try {
      if (streamMeta?.asstMsgId) {
        await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
      }
    } catch (_) {
      /* ignore */
    }
    const pipeMsg = String(pipeErr?.message || '');
    if (isOllamaOutOfMemoryMessage(pipeMsg)) {
      console.error('[MODEL] not enough memory');
      sseError(503, 'MODEL_OUT_OF_MEMORY');
    } else {
      console.error('[CHAT]', pipeErr);
      logError(`API_MESSAGE_STREAM_PIPE ${req.userId} ${pipeErr.stack || pipeErr.message}`);
      sseError(502, 'INTERNAL_ERROR');
    }
    releaseConcurrency();
  }
});

app.post('/api/stream/generate', (req, res) => {
  const body = req.body || {};
  const promptRaw = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!promptRaw) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  if (promptRaw.length > MAX_UNIFIED_PROMPT_CHARS) {
    return res.status(400).json({ error: 'prompt too long' });
  }

  let model =
    typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;

  const rawImages = Array.isArray(body.images)
    ? body.images.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8)
    : [];
  const images = rawImages.length > 0 ? rawImages : undefined;
  if (images) {
    model = VISION_CHAT_MODEL;
  }

  if (!ALLOWED_SET.has(model)) {
    return res.status(400).json({ error: 'model is not allowed', allowed: ALLOWED_MODELS });
  }

  if (ollamaHealthCached.status !== 'ok' && !studioLlmFallbackConfigured()) {
    return res.status(503).json({ error: 'OLLAMA_OFFLINE' });
  }

  if (active >= STREAM_MAX_CONCURRENT && queue.length >= STREAM_QUEUE_MAX_WAITING) {
    logAccess(`STREAM_QUEUE_FULL ip=${req.ip} user=${req.userId}`);
    return res.status(429).json({ error: 'Сервер занят, попробуйте позже' });
  }

  const job = { req, res, prompt: promptRaw, model, images };
  req.once('close', () => {
    const idx = queue.indexOf(job);
    if (idx !== -1) queue.splice(idx, 1);
  });
  queue.push(job);
  drainStreamQueue();
});

app.get('/api/health/ollama', (_req, res) => {
  res.json({
    status: ollamaHealthCached.status,
    cloudFallbackConfigured: studioLlmFallbackConfigured(),
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'ollama-api-gateway' });
});

app.post('/chat', apiKeyMiddleware, rateLimitMiddleware, async (req, res) => {
  const t0 = Date.now();
  const body = req.body || {};

  const promptRaw = body.prompt;
  if (typeof promptRaw !== 'string') {
    logAccess(`ACCESS ip=${req.ip} path=/chat model=- status=400 key=${maskKey(req.apiKey)} note=bad_prompt_type`);
    return res.status(400).json({ error: 'prompt is required (string)' });
  }
  const prompt = promptRaw.trim();
  if (!prompt) {
    logAccess(`ACCESS ip=${req.ip} path=/chat model=- status=400 key=${maskKey(req.apiKey)} note=empty_prompt`);
    return res.status(400).json({ error: 'prompt must not be empty' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    logAccess(`ACCESS ip=${req.ip} path=/chat model=- status=400 key=${maskKey(req.apiKey)} note=prompt_too_long len=${prompt.length}`);
    return res.status(400).json({ error: `prompt exceeds ${MAX_PROMPT_CHARS} characters` });
  }

  const model =
    typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;

  if (!ALLOWED_SET.has(model)) {
    logAccess(`ACCESS ip=${req.ip} path=/chat model=${model} status=400 key=${maskKey(req.apiKey)} note=model_not_allowed`);
    return res.status(400).json({ error: 'model is not allowed', allowed: ALLOWED_MODELS });
  }

  if (activeRequests >= MAX_CONCURRENT) {
    logAccess(`ACCESS ip=${req.ip} path=/chat model=${model} status=429 key=${maskKey(req.apiKey)} note=concurrency`);
    return res.status(429).json({ error: 'Too many concurrent requests', max: MAX_CONCURRENT });
  }

  activeRequests += 1;
  let concurrencyReleased = false;
  const releaseConcurrency = () => {
    if (concurrencyReleased) return;
    concurrencyReleased = true;
    activeRequests -= 1;
  };

  const onClientGone = () => releaseConcurrency();
  res.once('close', onClientGone);

  logAccess(
    `ACCESS ip=${req.ip} path=/chat model=${model} status=start key=${maskKey(req.apiKey)} prompt_len=${prompt.length}`,
  );

  const upstreamPayload = {
    model,
    prompt,
    stream: true,
  };

  let useModel = model;
  try {
    useModel = await resolveModel(model);
  } catch (e) {
    if (e && (e.code === 'MODEL_NOT_FOUND' || e.message === 'MODEL_NOT_FOUND')) {
      releaseConcurrency();
      logAccess(`ACCESS ip=${req.ip} path=/chat model=${model} status=503 key=${maskKey(req.apiKey)} note=model_not_installed ms=${Date.now() - t0}`);
      return res.status(503).json({ error: 'MODEL_NOT_INSTALLED' });
    }
    throw e;
  }
  upstreamPayload.model = useModel;

  stripImagesIfUnsupported(upstreamPayload, useModel);

  let upstream;
  try {
    upstream = await fetchOllamaWithRetry(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err) {
    releaseConcurrency();
    logError(`OLLAMA_FETCH_ERR ip=${req.ip} model=${model} ${err.stack || err.message}`);
    logAccess(`ACCESS ip=${req.ip} path=/chat model=${model} status=503 key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`);
    if (isOllamaOutOfMemoryMessage(err.message)) {
      console.error('[MODEL] not enough memory');
      return res.status(503).json({ error: 'MODEL_OUT_OF_MEMORY' });
    }
    return res.status(503).json({ error: 'OLLAMA_OFFLINE' });
  }

  if (!upstream.ok || upstream.body == null) {
    releaseConcurrency();
    let text = '';
    try {
      text = await upstream.text();
    } catch (e) {
      logError(`OLLAMA_READ_ERR ip=${req.ip} model=${model} ${e.message}`);
    }
    logError(`OLLAMA_HTTP_ERR ip=${req.ip} model=${model} status=${upstream.status} body=${text.slice(0, 800)}`);
    logAccess(`ACCESS ip=${req.ip} path=/chat model=${model} status=${upstream.status} key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`);
    if (isOllamaOutOfMemoryMessage(text)) {
      console.error('[MODEL] not enough memory');
      return res.status(503).json({ error: 'MODEL_OUT_OF_MEMORY' });
    }
    const offline = upstream.status === 503 || upstream.status === 502;
    if (offline) {
      return res.status(503).json({ error: 'OLLAMA_OFFLINE' });
    }
    return res.status(upstream.status).type('application/json').send(text || JSON.stringify({ error: 'Upstream error' }));
  }

  const ct = upstream.headers.get('content-type');
  if (ct) res.setHeader('Content-Type', ct);

  res.status(upstream.status);

  const cleanupUpstream = () => {
    safeCancelFetchBody(upstream.body);
  };

  req.on('close', cleanupUpstream);

  try {
    const nodeReadable = Readable.fromWeb(upstream.body);
    nodeReadable.on('end', () => {
      logAccess(`STREAM_END model=${model}`);
    });
    nodeReadable.on('error', (err) => {
      logError(`STREAM_UP_ERR ip=${req.ip} model=${model} ${err.message}`);
      cleanupUpstream();
      releaseConcurrency();
      if (!res.writableEnded) res.destroy(err);
    });
    res.on('close', () => {
      nodeReadable.destroy();
      cleanupUpstream();
    });
    nodeReadable.pipe(res);
    res.on('finish', () => {
      const code = res.statusCode ?? upstream.status;
      logAccess(`ACCESS ip=${req.ip} path=/chat model=${model} status=${code} key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`);
    });
  } catch (err) {
    releaseConcurrency();
    logError(`STREAM_SETUP_ERR ip=${req.ip} model=${model} ${err.stack || err.message}`);
    cleanupUpstream();
    if (!res.headersSent) res.status(502).json({ error: 'Streaming setup failed' });
  }
});

app.post('/v1/chat/completions', apiKeyMiddleware, rateLimitMiddleware, async (req, res) => {
  const t0 = Date.now();
  const body = req.body || {};

  logAccess(
    `OPENAI_ROUTE_USED ip=${req.ip} key=${maskKey(req.apiKey)} stream=${Boolean(body.stream)}`,
  );

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    logAccess(
      `ACCESS ip=${req.ip} path=/v1/chat/completions model=- status=400 key=${maskKey(req.apiKey)} note=bad_messages`,
    );
    return res.status(400).json({
      error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' },
    });
  }
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (
      !m ||
      typeof m !== 'object' ||
      typeof m.role !== 'string' ||
      typeof m.content !== 'string'
    ) {
      logAccess(
        `ACCESS ip=${req.ip} path=/v1/chat/completions model=- status=400 key=${maskKey(req.apiKey)} note=bad_message_item idx=${i}`,
      );
      return res.status(400).json({
        error: {
          message: 'each message must have string fields role and content',
          type: 'invalid_request_error',
        },
      });
    }
  }

  const prompt = promptFromOpenAiMessages(messages).trim();
  if (!prompt) {
    logAccess(
      `ACCESS ip=${req.ip} path=/v1/chat/completions model=- status=400 key=${maskKey(req.apiKey)} note=empty_prompt`,
    );
    return res.status(400).json({
      error: { message: 'assembled prompt is empty', type: 'invalid_request_error' },
    });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    logAccess(
      `ACCESS ip=${req.ip} path=/v1/chat/completions model=- status=400 key=${maskKey(req.apiKey)} note=prompt_too_long len=${prompt.length}`,
    );
    return res.status(400).json({
      error: {
        message: `prompt exceeds ${MAX_PROMPT_CHARS} characters`,
        type: 'invalid_request_error',
      },
    });
  }

  const model =
    typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;

  if (!ALLOWED_SET.has(model)) {
    logAccess(
      `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=400 key=${maskKey(req.apiKey)} note=model_not_allowed`,
    );
    return res.status(400).json({
      error: { message: 'model is not allowed', type: 'invalid_request_error', allowed: ALLOWED_MODELS },
    });
  }

  if (activeRequests >= MAX_CONCURRENT) {
    logAccess(
      `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=429 key=${maskKey(req.apiKey)} note=concurrency`,
    );
    return res.status(429).json({
      error: { message: 'Too many concurrent requests', type: 'rate_limit_error', max: MAX_CONCURRENT },
    });
  }

  const streamMode = Boolean(body.stream);

  activeRequests += 1;
  let concurrencyReleased = false;
  const releaseConcurrency = () => {
    if (concurrencyReleased) return;
    concurrencyReleased = true;
    activeRequests -= 1;
  };

  const onClientGone = () => releaseConcurrency();
  res.once('close', onClientGone);

  logAccess(
    `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=start stream=${streamMode} key=${maskKey(req.apiKey)} prompt_len=${prompt.length}`,
  );

  const upstreamPayload = {
    model,
    prompt,
    stream: streamMode,
  };

  const rawImages = body.images;
  if (Array.isArray(rawImages) && rawImages.length > 0) {
    const imgs = rawImages.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8);
    if (imgs.length > 0) upstreamPayload.images = imgs;
  }

  let useModel =
    upstreamPayload.images?.length > 0
      ? await resolveVisionModel(model)
      : await resolveModel(model);
  upstreamPayload.model = useModel;

  stripImagesIfUnsupported(upstreamPayload, useModel);

  let upstream;
  try {
    upstream = await fetchOllamaWithRetry(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err) {
    releaseConcurrency();
    logError(
      `OPENAI_OLLAMA_FETCH_ERR ip=${req.ip} model=${model} ${err.stack || err.message}`,
    );
    logAccess(
      `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=503 key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`,
    );
    if (isOllamaOutOfMemoryMessage(err.message)) {
      console.error('[MODEL] not enough memory');
      return res.status(503).json({
        error: { message: 'MODEL_OUT_OF_MEMORY', type: 'upstream_error' },
      });
    }
    return res.status(503).json({
      error: { message: 'OLLAMA_OFFLINE', type: 'upstream_error' },
    });
  }

  const cleanupUpstream = () => {
    safeCancelFetchBody(upstream.body);
  };

  req.on('close', cleanupUpstream);

  if (!upstream.ok || upstream.body == null) {
    releaseConcurrency();
    let text = '';
    try {
      text = await upstream.text();
    } catch (e) {
      logError(`OPENAI_OLLAMA_READ_ERR ip=${req.ip} model=${model} ${e.message}`);
    }
    logError(
      `OPENAI_OLLAMA_HTTP_ERR ip=${req.ip} model=${model} status=${upstream.status} body=${text.slice(0, 800)}`,
    );
    logAccess(
      `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=${upstream.status} key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`,
    );
    if (isOllamaOutOfMemoryMessage(text)) {
      console.error('[MODEL] not enough memory');
      return res.status(503).json({
        error: { message: 'MODEL_OUT_OF_MEMORY', type: 'upstream_error' },
      });
    }
    const offline = upstream.status === 503 || upstream.status === 502;
    if (offline) {
      return res.status(503).json({
        error: { message: 'OLLAMA_OFFLINE', type: 'upstream_error' },
      });
    }
    return res.status(upstream.status).json({
      error: {
        message: 'Upstream error',
        type: 'upstream_error',
        detail: text.slice(0, 500),
      },
    });
  }

  const completionId = openaiCompletionId();
  const created = Math.floor(Date.now() / 1000);

  if (!streamMode) {
    try {
      const rawText = await upstream.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        releaseConcurrency();
        logError(`OPENAI_PARSE_ERR ip=${req.ip} model=${model} ${e.message} raw=${rawText.slice(0, 400)}`);
        logAccess(
          `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=502 key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`,
        );
        return res.status(502).json({
          error: { message: 'Invalid upstream JSON', type: 'upstream_error' },
        });
      }
      const memErr = ollamaErrorTextFromGenerateJson(data);
      if (
        isOllamaOutOfMemoryMessage(memErr) ||
        isOllamaOutOfMemoryMessage(rawText)
      ) {
        releaseConcurrency();
        console.error('[MODEL] not enough memory');
        logAccess(
          `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=503 key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`,
        );
        return res.status(503).json({
          error: { message: 'MODEL_OUT_OF_MEMORY', type: 'upstream_error' },
        });
      }
      releaseConcurrency();
      const content = typeof data.response === 'string' ? data.response : '';
      logAccess(
        `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=200 key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`,
      );
      return res.status(200).json({
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      });
    } catch (err) {
      releaseConcurrency();
      logError(`OPENAI_NONSTREAM_ERR ip=${req.ip} model=${model} ${err.stack || err.message}`);
      logAccess(
        `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=502 key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`,
      );
      return res.status(502).json({
        error: { message: 'Failed to read upstream response', type: 'upstream_error' },
      });
    }
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const nodeReadable = Readable.fromWeb(upstream.body);
    nodeReadable.on('error', (err) => {
      logError(`OPENAI_STREAM_UP_ERR ip=${req.ip} model=${model} ${err.message}`);
      cleanupUpstream();
      releaseConcurrency();
      if (isOllamaOutOfMemoryMessage(err.message)) {
        console.error('[MODEL] not enough memory');
      }
      if (!res.writableEnded) res.end();
    });

    const rl = readline.createInterface({ input: nodeReadable, crlfDelay: Infinity });

    let firstDelta = true;

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        const errStr = ollamaErrorTextFromGenerateJson(parsed);
        if (errStr && isOllamaOutOfMemoryMessage(errStr)) {
          console.error('[MODEL] not enough memory');
          releaseConcurrency();
          res.write(
            `data: ${JSON.stringify({
              error: { message: 'MODEL_OUT_OF_MEMORY', type: 'upstream_error' },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          break;
        }

        const piece = typeof parsed.response === 'string' ? parsed.response : '';
        const delta = {};
        if (firstDelta) {
          delta.role = 'assistant';
          firstDelta = false;
        }
        if (piece) delta.content = piece;

        if (Object.keys(delta).length > 0) {
          const chunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        if (parsed.done) {
          const finalChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          break;
        }
      }
    } finally {
      rl.close();
      nodeReadable.destroy();
      cleanupUpstream();
      releaseConcurrency();
      logAccess(
        `ACCESS ip=${req.ip} path=/v1/chat/completions model=${model} status=200 stream=1 key=${maskKey(req.apiKey)} ms=${Date.now() - t0}`,
      );
      if (!res.writableEnded) res.end();
    }
  } catch (err) {
    releaseConcurrency();
    logError(`OPENAI_STREAM_SETUP_ERR ip=${req.ip} model=${model} ${err.stack || err.message}`);
    cleanupUpstream();
    if (!res.headersSent) {
      res.status(502).json({
        error: { message: 'Streaming setup failed', type: 'upstream_error' },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, '127.0.0.1', () => {
  void refreshOllamaHealthCache();
  setInterval(() => {
    void refreshOllamaHealthCache();
  }, OLLAMA_HEALTH_REFRESH_MS);
  console.log(`ollama-api-gateway listening on 127.0.0.1:${PORT} -> ${OLLAMA_URL}`);
  if (API_KEYS.size === 0) console.warn('WARNING: API_KEYS is empty — all requests will 401');
});
