import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatSession, UiAttachment } from '../types/chat';
import {
  ChatStreamError,
  createChatRemote,
  deleteChatRemote,
  fetchChatsList,
  postChatMessageRemote,
  uploadFilesRemote,
} from '../api/chats';
import { fetchOllamaHealth } from '../api/health';
import { httpStatusFromChatError, isOfflineError } from '../api/client';
import { uid } from '../utils/files';
import { ChatInput } from './ChatInput';
import { MessageList } from './MessageList';
import { Sidebar } from './Sidebar';

const OFFLINE_MSG = '⚠️ Модель сейчас недоступна (сервер оффлайн)';
const MSG_FILE_BAD = 'Файл слишком большой или неподдерживаемый';
const MSG_SERVER_503 = 'Сервер временно недоступен';
const MSG_OVERLOADED = '⚠️ Сервер перегружен, попробуйте ещё раз';
const MSG_STREAM_INCOMPLETE =
  '⚠️ Ответ не дошёл до конца (обрыв или ошибка шлюза). Попробуйте ещё раз.';
const MSG_SEND_FALLBACK = 'Не удалось отправить сообщение. Попробуйте позже.';

/** Тексты для `error` из SSE POST /api/chats/.../message (не путать с сетевым «оффлайн»). */
const CHAT_SSE_ERROR_BANNER: Record<string, string> = {
  MODEL_OUT_OF_MEMORY: '⚠️ Недостаточно памяти',
  MODEL_NOT_INSTALLED: '⚠️ Модель не установлена',
  OLLAMA_NO_RESPONSE: '⚠️ Модель долго отвечает',
  OLLAMA_OFFLINE: '⚠️ Ollama недоступна',
  OLLAMA_TIMEOUT: '⚠️ Превышено время ожидания',
  OLLAMA_FAILED: '⚠️ Ошибка генерации',
  upstream_error: '⚠️ Ошибка ответа модели',
  INTERNAL_ERROR: '⚠️ Внутренняя ошибка',
};

const MAX_STAGED_DOCS = 2;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

interface StagedAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

export function ChatLayout() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState('');
  const [chatsLoading, setChatsLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [ollamaHealth, setOllamaHealth] = useState<'ok' | 'offline' | null>(null);
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  const active = useMemo(() => sessions.find((s) => s.id === activeId), [sessions, activeId]);

  useEffect(() => {
    return () => {
      stagedRef.current.forEach((s) => {
        if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setChatsLoading(true);
      setBanner(null);
      try {
        let list = await fetchChatsList();
        if (cancelled) return;
        if (list.length === 0) {
          const created = await createChatRemote('Новый чат');
          if (cancelled) return;
          list = [created];
        }
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        setSessions(list);
        setActiveId((prev) => (prev && list.some((s) => s.id === prev) ? prev : list[0]!.id));
      } catch (e) {
        if (!cancelled) {
          setBanner(isOfflineError(e) ? OFFLINE_MSG : 'Не удалось загрузить чаты');
          setSessions([]);
          setActiveId('');
        }
      } finally {
        if (!cancelled) setChatsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const status = await fetchOllamaHealth();
      if (!cancelled) setOllamaHealth(status);
    };
    void tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const refreshSessions = async () => {
    const list = await fetchChatsList();
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    setSessions(list);
    return list;
  };

  const newChat = async () => {
    if (chatsLoading || loading) return;
    setBanner(null);
    try {
      const created = await createChatRemote('Новый чат');
      await refreshSessions();
      setActiveId(created.id);
    } catch (e) {
      setBanner(isOfflineError(e) ? OFFLINE_MSG : 'Не удалось создать чат');
    }
  };

  const removeChat = async (chatId: string) => {
    if (chatsLoading || loading) return;
    setBanner(null);
    try {
      await deleteChatRemote(chatId);
      let list = await fetchChatsList();
      if (list.length === 0) {
        const created = await createChatRemote('Новый чат');
        list = [created];
      }
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      setSessions(list);
      setActiveId((prev) => {
        if (prev === chatId || !list.some((s) => s.id === prev)) {
          return list[0]!.id;
        }
        return prev;
      });
    } catch (e) {
      setBanner(isOfflineError(e) ? OFFLINE_MSG : 'Не удалось удалить чат');
    }
  };

  const stageFiles = (incoming: FileList | File[] | null) => {
    const batch = incoming ? Array.from(incoming) : [];
    if (batch.length === 0) return;

    let bannerMsg: string | null = null;
    let addedAny = false;

    setStaged((prev) => {
      let docCount = prev.filter(
        (p) =>
          !/^image\/(jpeg|png)$/i.test(p.file.type) &&
          (p.file.type === 'text/plain' ||
            p.file.type === 'application/pdf' ||
            /\.(txt|pdf)$/i.test(p.file.name)),
      ).length;

      const next = [...prev];

      for (const file of batch) {
        const isImg = /^image\/(jpeg|png)$/i.test(file.type);
        const isDoc =
          file.type === 'text/plain' ||
          file.type === 'application/pdf' ||
          /\.(txt|pdf)$/i.test(file.name);

        if (isImg) {
          if (file.size > MAX_IMAGE_BYTES) {
            bannerMsg = MSG_FILE_BAD;
            continue;
          }
        } else if (isDoc) {
          if (docCount >= MAX_STAGED_DOCS) {
            bannerMsg = MSG_FILE_BAD;
            continue;
          }
          docCount += 1;
        } else {
          bannerMsg = MSG_FILE_BAD;
          continue;
        }

        const id = uid();
        const previewUrl = isImg ? URL.createObjectURL(file) : undefined;
        next.push({ id, file, previewUrl });
        addedAny = true;
      }
      return next;
    });

    if (bannerMsg) setBanner(bannerMsg);
    else if (addedAny) setBanner(null);
  };

  const removeStaged = (id: string) => {
    setStaged((prev) => {
      const x = prev.find((p) => p.id === id);
      if (x?.previewUrl) URL.revokeObjectURL(x.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const sendMessage = async (textRaw: string) => {
    if (!active || loading || chatsLoading) return;
    const text = textRaw.trim();
    if (!text && staged.length === 0) return;

    setBanner(null);

    const sessionId = active.id;

    const snapshotStaged = [...staged];
    const blobUrlsToRevoke = snapshotStaged.map((s) => s.previewUrl).filter((u): u is string => Boolean(u));

    const uiAttachments: UiAttachment[] = snapshotStaged.map((s) => {
      const isImg = /^image\/(jpeg|png)$/i.test(s.file.type);
      return {
        id: s.id,
        kind: isImg ? 'image' : 'file',
        name: s.file.name,
        previewUrl: s.previewUrl,
      };
    });

    let displayContent = text;
    if (!displayContent) {
      if (uiAttachments.some((a) => a.kind === 'image')) displayContent = 'Опиши изображение';
      else if (uiAttachments.length) displayContent = 'Вот документ';
    }

    const optimisticUser: ChatMessage = {
      id: uid(),
      role: 'user',
      content: displayContent,
      attachments: uiAttachments.length ? uiAttachments : undefined,
    };
    const optimisticAssistant: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
    };

    setStaged([]);

    /** Изображения уже JPEG File после выбора в ChatInput (compress + new File). */
    const filesToSend = snapshotStaged.map((s) => s.file);

    setLoading(true);

    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              updatedAt: Date.now(),
              messages: [...s.messages, optimisticUser, optimisticAssistant],
            }
          : s,
      ),
    );

    try {
      let fileIds: string[] = [];
      if (filesToSend.length > 0) {
        fileIds = await uploadFilesRemote(filesToSend);
      }

      const { chat } = await postChatMessageRemote(sessionId, text, fileIds, {
        onReady: ({ userMessageId, assistantMessageId }) => {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const msgs = [...s.messages];
              const uIdx = msgs.length - 2;
              const aIdx = msgs.length - 1;
              if (msgs[uIdx]?.role === 'user')
                msgs[uIdx] = { ...msgs[uIdx], id: userMessageId };
              if (msgs[aIdx]?.role === 'assistant')
                msgs[aIdx] = { ...msgs[aIdx], id: assistantMessageId };
              return { ...s, messages: msgs };
            }),
          );
        },
        onDelta: (_delta, accumulated) => {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === 'assistant')
                msgs[msgs.length - 1] = { ...last, content: accumulated };
              return { ...s, messages: msgs };
            }),
          );
        },
      });

      setSessions((prev) => prev.map((s) => (s.id === sessionId ? chat : s)));
    } catch (e) {
      const uploadMatch =
        e instanceof Error ? /^upload_(\d+)$/.exec(e.message) : null;
      const uploadCode = uploadMatch ? Number(uploadMatch[1]) : 0;

      const chatHttp = httpStatusFromChatError(e);

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                messages: s.messages.filter(
                  (m) => m.id !== optimisticUser.id && m.id !== optimisticAssistant.id,
                ),
              }
            : s,
        ),
      );

      if (e instanceof Error && e.message === 'upload_bad_response') {
        setBanner(MSG_FILE_BAD);
      } else if (
        e instanceof ChatStreamError &&
        e.sseError &&
        CHAT_SSE_ERROR_BANNER[e.sseError]
      ) {
        setBanner(CHAT_SSE_ERROR_BANNER[e.sseError]);
      } else if (uploadCode === 400) {
        setBanner(MSG_FILE_BAD);
      } else if (uploadCode === 503) {
        setBanner(MSG_SERVER_503);
      } else if (uploadCode === 429) {
        setBanner('Слишком много запросов');
      } else if (uploadCode > 0) {
        setBanner(MSG_OVERLOADED);
      } else if (chatHttp === 400) {
        setBanner(MSG_FILE_BAD);
      } else if (chatHttp === 503) {
        setBanner(MSG_SERVER_503);
      } else if (chatHttp === 502 || chatHttp === 504) {
        setBanner(MSG_OVERLOADED);
      } else if (chatHttp === 429) {
        setBanner('Слишком много запросов');
      } else if (chatHttp !== undefined && chatHttp >= 500) {
        setBanner(MSG_OVERLOADED);
      } else if (
        e instanceof Error &&
        e.message === 'message_stream_incomplete'
      ) {
        setBanner(MSG_STREAM_INCOMPLETE);
      } else if (isOfflineError(e)) {
        setBanner(OFFLINE_MSG);
      } else {
        setBanner(MSG_SEND_FALLBACK);
      }
    } finally {
      blobUrlsToRevoke.forEach((url) => URL.revokeObjectURL(url));
      setLoading(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 bg-[radial-gradient(ellipse_at_top,_rgba(16,163,127,0.12),transparent_55%),radial-gradient(ellipse_at_bottom,_rgba(120,80,220,0.08),transparent_50%)]">
      {chatsLoading && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm">
          <div className="rounded-xl border border-white/10 bg-black/60 px-6 py-4 text-sm text-zinc-300">
            Загрузка чатов…
          </div>
        </div>
      )}

      <Sidebar
        sessions={sessions}
        activeId={activeId}
        disabled={chatsLoading || loading}
        onSelect={setActiveId}
        onNewChat={() => void newChat()}
        onDeleteChat={(id) => void removeChat(id)}
      />

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className="pointer-events-none absolute right-4 top-3 z-[15] select-none text-xs tabular-nums text-zinc-400 md:right-6"
          title="Состояние Ollama: шлюз опрашивает OLLAMA_URL (на проде через туннель с домашней машины)"
          aria-live="polite"
        >
          {ollamaHealth === null ? (
            <span>Ollama …</span>
          ) : ollamaHealth === 'ok' ? (
            <span title="Модели доступны через шлюз">🟢 online</span>
          ) : (
            <span
              title="Нет ответа от Ollama по OLLAMA_URL (на VPS чаще всего нужен SSH-туннель с ПК, где запущен ollama serve — см. docs/SERVER_AND_REPO.md). Сайт и чат работают, генерация — после восстановления туннеля."
              className="cursor-help border-b border-dotted border-zinc-500"
            >
              🔴 offline
            </span>
          )}
        </div>

        {banner && (
          <div className="animate-fade-in shrink-0 px-6 pt-4">
            <div className="mx-auto max-w-3xl rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-center text-sm text-amber-100 backdrop-blur-md">
              {banner}
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {active ? (
            <MessageList messages={active.messages} loading={loading} scrollKey={active.id} />
          ) : (
            !chatsLoading && (
              <div className="flex flex-1 items-center justify-center text-zinc-500">
                Нет активного чата
              </div>
            )
          )}
        </div>

        {active && staged.length > 0 && (
          <div className="pointer-events-none absolute bottom-[118px] left-0 right-0 z-[11] flex justify-center px-4 md:px-10">
            <div className="pointer-events-auto flex max-w-3xl flex-wrap gap-2 rounded-xl border border-white/10 bg-black/55 px-3 py-2 backdrop-blur-xl">
              {staged.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => removeStaged(s.id)}
                  className="flex items-center gap-2 rounded-lg bg-white/[0.06] px-2 py-1 text-xs text-zinc-200 transition hover:bg-white/[0.12]"
                  title="Убрать"
                >
                  {s.previewUrl ? (
                    <img src={s.previewUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
                  ) : (
                    <span>📄</span>
                  )}
                  <span className="max-w-[140px] truncate">{s.file.name}</span>
                  <span className="text-zinc-500">✕</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {active && (
          <ChatInput
            disabled={loading || chatsLoading}
            loading={loading}
            hasAttachments={staged.length > 0}
            onSend={sendMessage}
            onFilesSelected={stageFiles}
            onAttachmentError={(msg) => setBanner(msg)}
          />
        )}

        {loading && active && (
          <div className="pointer-events-none absolute left-0 right-0 top-[52px] z-[9] flex justify-center px-4 md:top-[72px]">
            <span className="rounded-full border border-white/10 bg-black/50 px-4 py-1.5 text-xs font-medium text-zinc-400 backdrop-blur-md">
              Ассистент печатает…
            </span>
          </div>
        )}
      </main>
    </div>
  );
}
