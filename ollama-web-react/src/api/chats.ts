import type { ChatSession } from '../types/chat';

const BASE = import.meta.env.VITE_API_BASE ?? '';

function attachmentPublicUrl(fileId: string): string {
  const p = `/api/attachments/${encodeURIComponent(fileId)}`;
  return BASE ? `${BASE.replace(/\/$/, '')}${p}` : p;
}

function isPersistedAttachmentId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

export interface ApiChatRow {
  id: string;
  title: string;
  updatedAt?: number;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    attachments?: Array<{ kind?: string; id?: string; name?: string }>;
  }>;
}

export interface ChatMessageStreamHandlers {
  onReady?: (ids: { userMessageId: string; assistantMessageId: string }) => void;
  onDelta?: (delta: string, accumulated: string) => void;
}

/** Ошибка из SSE чата: HTTP-статус + строка `error` из payload (если есть). */
export class ChatStreamError extends Error {
  readonly httpStatus: number;
  readonly sseError?: string;

  constructor(httpStatus: number, sseError?: string) {
    super(`message_${httpStatus}`);
    this.name = 'ChatStreamError';
    this.httpStatus = httpStatus;
    this.sseError = sseError;
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
  });
}

export function normalizeChat(raw: ApiChatRow): ChatSession {
  return {
    id: raw.id,
    title: raw.title || 'Чат',
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    messages: (raw.messages || []).map((m) => {
      const rawAtt = (m as { attachments?: unknown }).attachments;
      let attachments = undefined as ChatSession['messages'][0]['attachments'];
      if (Array.isArray(rawAtt)) {
        attachments = rawAtt
          .filter(
            (a): a is { kind?: string; id?: string; name?: string } =>
              Boolean(a && typeof a === 'object' && typeof (a as { id?: string }).id === 'string'),
          )
          .filter((a) => isPersistedAttachmentId(String(a.id)))
          .map((a) => {
            const id = String(a.id);
            const kind = a.kind === 'image' ? 'image' : 'file';
            const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'файл';
            const imageLike = kind === 'image' || !a.kind;
            return {
              id,
              kind: imageLike ? 'image' : 'file',
              name,
              previewUrl: imageLike ? attachmentPublicUrl(id) : undefined,
            };
          });
        if (attachments.length === 0) attachments = undefined;
      }
      return {
        id: m.id,
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : '',
        attachments,
      };
    }),
  };
}

export async function fetchChatsList(): Promise<ChatSession[]> {
  const res = await apiFetch('/api/chats');
  if (!res.ok) throw new Error(`chats_${res.status}`);
  const data = (await res.json()) as { chats?: ApiChatRow[] };
  const rows = Array.isArray(data.chats) ? data.chats : [];
  return rows.map(normalizeChat);
}

export async function createChatRemote(title?: string): Promise<ChatSession> {
  const res = await apiFetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) throw new Error(`create_${res.status}`);
  const data = (await res.json()) as { chat?: ApiChatRow };
  if (!data.chat) throw new Error('create_bad_response');
  return normalizeChat(data.chat);
}

export async function deleteChatRemote(id: string): Promise<void> {
  const res = await apiFetch(`/api/chats/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) throw new Error(`delete_${res.status}`);
}

/** Multipart только здесь; SSE открывается отдельным POST сообщения с fileIds. */
export async function uploadFilesRemote(files: File[]): Promise<string[]> {
  if (!files.length) return [];
  const fd = new FormData();
  for (const f of files) {
    fd.append('files', f);
  }
  const res = await apiFetch('/api/upload', {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) throw new Error(`upload_${res.status}`);
  const data = (await res.json()) as { fileIds?: string[] };
  if (!Array.isArray(data.fileIds)) throw new Error('upload_bad_response');
  return data.fileIds;
}

function parseSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  let idx = rest.indexOf('\n\n');
  while (idx !== -1) {
    blocks.push(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
    idx = rest.indexOf('\n\n');
  }
  return { blocks, rest };
}

function parseSseEventBlock(block: string): { event?: string; dataRaw: string } {
  let ev: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) ev = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  return { event: ev, dataRaw: dataLines.join('\n') };
}

export async function postChatMessageRemote(
  chatId: string,
  content: string,
  fileIds: string[],
  handlers?: ChatMessageStreamHandlers,
): Promise<{ chat: ChatSession; assistantMessage: { id: string; role: string; content: string } | null }> {
  const res = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, fileIds }),
  });

  const ct = res.headers.get('content-type') || '';

  if (!res.ok && !ct.includes('text/event-stream')) {
    const bodyText = await res.text();
    const err = new Error(`message_${res.status}`);
    (err as Error & { body?: string }).body = bodyText;
    throw err;
  }

  if (!res.body) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`message_${res.status}`);
    (err as Error & { body?: string }).body = bodyText;
    throw err;
  }

  if (!ct.includes('text/event-stream')) {
    const bodyText = await res.text();
    let json: {
      chat?: ApiChatRow;
      assistantMessage?: { id: string; role: string; content: string };
    } = {};
    try {
      json = JSON.parse(bodyText) as typeof json;
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      const err = new Error(`message_${res.status}`);
      (err as Error & { body?: string }).body = bodyText;
      throw err;
    }
    if (!json.chat) throw new Error('message_bad_response');
    return {
      chat: normalizeChat(json.chat),
      assistantMessage: json.assistantMessage ?? null,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalChat: ChatSession | null = null;
  let finalAssistant: { id: string; role: string; content: string } | null = null;

  let streamAccumulated = '';

  const handleDataLine = (rawJson: string) => {
    if (rawJson === '[DONE]') return;
    let obj: {
      type?: string;
      status?: number;
      error?: string;
      delta?: string;
      chat?: ApiChatRow;
      assistantMessage?: { id: string; role: string; content: string };
      userMessageId?: string;
      assistantMessageId?: string;
    };
    try {
      obj = JSON.parse(rawJson) as typeof obj;
    } catch {
      return;
    }
    if (obj.type === 'error') {
      const st = typeof obj.status === 'number' ? obj.status : 502;
      const errCode = typeof obj.error === 'string' ? obj.error : undefined;
      throw new ChatStreamError(st, errCode);
    }
    if (obj.type === 'meta' || obj.type === 'ready') {
      handlers?.onReady?.({
        userMessageId: String(obj.userMessageId ?? ''),
        assistantMessageId: String(obj.assistantMessageId ?? ''),
      });
    }
    if (obj.type === 'delta' && typeof obj.delta === 'string') {
      streamAccumulated += obj.delta;
      handlers?.onDelta?.(obj.delta, streamAccumulated);
    }
    if (obj.type === 'done' && obj.chat) {
      finalChat = normalizeChat(obj.chat);
      finalAssistant = obj.assistantMessage ?? null;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { blocks, rest } = parseSseBlocks(buffer);
      buffer = rest;
      for (const block of blocks) {
        const { event, dataRaw } = parseSseEventBlock(block);
        if (event === 'ready' && (dataRaw === '{}' || dataRaw === '')) continue;
        if (!dataRaw.trim()) continue;
        handleDataLine(dataRaw);
      }
    }
    if (buffer.trim()) {
      const { blocks } = parseSseBlocks(`${buffer}\n\n`);
      for (const block of blocks) {
        const { event, dataRaw } = parseSseEventBlock(block);
        if (event === 'ready' && (dataRaw === '{}' || dataRaw === '')) continue;
        if (!dataRaw.trim()) continue;
        handleDataLine(dataRaw);
      }
    }
  } catch (e) {
    if (e instanceof ChatStreamError) throw e;
    if (e instanceof Error && /^message_\d+$/.test(e.message)) throw e;
    throw e;
  }

  if (!finalChat) throw new Error('message_stream_incomplete');

  return {
    chat: finalChat,
    assistantMessage: finalAssistant,
  };
}
