'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const readline = require('readline');
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
fs.mkdirSync(DATA_USERS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

  let upstream;
  try {
    upstream = await fetchOllamaWithRetry(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err) {
    logError(`STREAM_QUEUE_FETCH_ERR ip=${req.ip} ${err.stack || err.message}`);
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
    res.json({ projects: data.studioProjects });
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
    res.status(201).json({ project });
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
    res.json({ project });
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
    res.json({ project: out.project });
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
    res.json({ project: out.project });
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
    res.json({ project: out.project });
  } catch (e) {
    logError(`STUDIO_PLAN_APPROVE ${e.stack || e.message}`);
    res.status(500).json({ error: 'storage_error' });
  }
});

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

    if (ollamaHealthCached.status !== 'ok') {
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
      try {
        await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
      } catch (_) {
        /* ignore */
      }
      if (isOllamaOutOfMemoryMessage(fetchErr.message)) {
        console.error('[MODEL] not enough memory');
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
        sseError(504, 'OLLAMA_TIMEOUT');
      } else {
        sseError(503, 'OLLAMA_FAILED');
      }
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
      await rollbackAssistantMessage(req.userId, chatId, streamMeta.asstMsgId);
      if (isOllamaOutOfMemoryMessage(text)) {
        console.error('[MODEL] not enough memory');
        sseError(503, 'MODEL_OUT_OF_MEMORY');
        cleanupUpstream();
        releaseConcurrency();
        return;
      }
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

    /** @type {Record<string, unknown> | undefined} */
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

  if (ollamaHealthCached.status !== 'ok') {
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
  res.json({ status: ollamaHealthCached.status });
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
