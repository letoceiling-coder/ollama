import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatMessage } from '../types/chat';
import { MessageItem } from './MessageItem';

/** Порог «у низа»: если ниже — считаем, что пользователь смотрит конец чата (автоскролл вкл.). */
const BOTTOM_SLACK_PX = 100;

interface MessageListProps {
  messages: ChatMessage[];
  loading: boolean;
  /** Смена чата — прокрутка в конец и сброс режима «листал вверх». */
  scrollKey?: string;
}

function scrollRootToBottom(root: HTMLDivElement) {
  root.scrollTop = root.scrollHeight;
}

export function MessageList({ messages, loading, scrollKey }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const prevScrollKeyRef = useRef(scrollKey);

  const pinnedToBottom = (): boolean => {
    const root = scrollRef.current;
    if (!root) return true;
    const slack = BOTTOM_SLACK_PX;
    return root.scrollHeight - root.scrollTop - root.clientHeight <= slack;
  };

  const updateStickFromScroll = () => {
    if (loading) return;
    stickRef.current = pinnedToBottom();
  };

  useLayoutEffect(() => {
    if (scrollKey !== undefined && scrollKey !== prevScrollKeyRef.current) {
      prevScrollKeyRef.current = scrollKey;
      stickRef.current = true;
      const root = scrollRef.current;
      if (root) scrollRootToBottom(root);
    }
  }, [scrollKey]);

  /** Пока идёт ответ — всегда держим низ в кадре (стрим + картинки + markdown). */
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    if (loading || stickRef.current) {
      scrollRootToBottom(root);
    }
  }, [messages, loading]);

  useEffect(() => {
    const root = scrollRef.current;
    const inner = contentRef.current;
    if (!root || !inner) return;

    const ro = new ResizeObserver(() => {
      if (loading || stickRef.current) {
        scrollRootToBottom(root);
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [loading]);

  const last = messages[messages.length - 1];
  const assistantTyping =
    loading && last?.role === 'assistant' && last.content === '';

  return (
    <div
      ref={scrollRef}
      onScroll={updateStickFromScroll}
      className="scrollbar-thin flex flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 md:px-10"
    >
      <div ref={contentRef} className="mx-auto w-full max-w-3xl pb-36 pt-8">
        {messages.length === 0 && (
          <div className="animate-fade-in py-16 text-center">
            <h1 className="bg-gradient-to-r from-zinc-100 via-white to-zinc-400 bg-clip-text text-3xl font-semibold tracking-tight text-transparent md:text-4xl">
              Чем могу помочь?
            </h1>
            <p className="mt-3 text-sm text-zinc-500">
              Текст ·{' '}
              <span className="text-zinc-400">{import.meta.env.VITE_TEXT_MODEL ?? 'llama3:latest'}</span>
              {' · vision · '}
              <span className="text-zinc-400">{import.meta.env.VITE_VISION_MODEL ?? 'qwen2.5vl:7b'}</span>
            </p>
          </div>
        )}

        {messages.map((m) => (
          <MessageItem
            key={m.id}
            role={m.role}
            content={m.content}
            attachments={m.attachments}
            showTypingDots={assistantTyping && m.id === last?.id}
          />
        ))}
      </div>
    </div>
  );
}
