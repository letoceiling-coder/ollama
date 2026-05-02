import { ChatStreamError } from './chats';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
const AUTH_HEADER = import.meta.env.VITE_API_AUTH ?? 'Bearer key1';

export interface CompletionSuccess {
  choices: Array<{ message?: { content?: string } }>;
}

/**
 * Только явные сетевые сбои клиента (нет ответа / обрыв).
 * Не путать с HTTP 502/503 — у них есть статус от прокси/сервера.
 */
export function isOfflineError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  if (err instanceof TypeError) {
    return (
      msg.includes('Failed to fetch') ||
      msg.includes('Load failed') ||
      msg.includes('NetworkError') ||
      /fetch failed/i.test(msg)
    );
  }
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return err.name === 'NetworkError';
  }
  return false;
}

/** Статус из POST чата: `message_<code>` или `ChatStreamError`. */
export function httpStatusFromChatError(err: unknown): number | undefined {
  if (err instanceof ChatStreamError) return err.httpStatus;
  if (err instanceof Error) {
    const m = /^message_(\d+)$/.exec(err.message);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export async function postChatCompletion(payload: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  images?: string[];
}): Promise<{ ok: boolean; status: number; json?: CompletionSuccess; bodyText?: string }> {
  const headers: Record<string, string> = {
    Authorization: AUTH_HEADER,
    'Content-Type': 'application/json',
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw e;
  }

  const bodyText = await res.text();
  let json: CompletionSuccess | undefined;
  try {
    json = JSON.parse(bodyText) as CompletionSuccess;
  } catch {
    /* non-json error pages */
  }

  return { ok: res.ok, status: res.status, json, bodyText };
}

export function extractAssistantContent(data: CompletionSuccess | undefined): string {
  const c = data?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}
