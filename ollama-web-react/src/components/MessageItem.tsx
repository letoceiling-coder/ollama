import type { UiAttachment } from '../types/chat';
import { AssistantMarkdown } from './AssistantMarkdown';

interface MessageItemProps {
  role: 'user' | 'assistant';
  content: string;
  attachments?: UiAttachment[];
  showTypingDots?: boolean;
}

export function MessageItem({ role, content, attachments, showTypingDots }: MessageItemProps) {
  const isUser = role === 'user';

  return (
    <div
      className={`animate-fade-in flex gap-3 py-5 ${isUser ? 'flex-row-reverse' : ''}`}
      style={{ animationDelay: '0ms' }}
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-semibold shadow-lg ring-1 ring-white/10 transition hover:scale-[1.03] ${
          isUser
            ? 'bg-gradient-to-br from-violet-500/90 to-fuchsia-600/90 text-white'
            : 'bg-gradient-to-br from-emerald-600/85 to-teal-700/85 text-white'
        }`}
      >
        {isUser ? 'Вы' : 'AI'}
      </div>

      <div className={`flex max-w-[min(720px,85%)] flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}>
        {attachments && attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) =>
              a.kind === 'image' && a.previewUrl ? (
                <img
                  key={a.id}
                  src={a.previewUrl}
                  alt={a.name}
                  className="max-h-40 rounded-xl border border-white/10 object-cover shadow-md ring-1 ring-white/5 transition hover:ring-accent/30"
                />
              ) : (
                <span
                  key={a.id}
                  className="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1 text-[11px] text-zinc-300 backdrop-blur-sm"
                >
                  📄 {a.name}
                </span>
              ),
            )}
          </div>
        )}

        <div
          className={`rounded-xl px-4 py-3 text-[15px] leading-relaxed shadow-lg ring-1 transition hover:ring-white/10 ${
            isUser
              ? 'bg-white/[0.08] text-zinc-100 ring-white/[0.07]'
              : 'border border-white/[0.05] bg-black/35 text-zinc-100 ring-black/40 backdrop-blur-md'
          }`}
        >
          {showTypingDots && !content ? (
            <span className="inline-flex gap-1 text-zinc-400">
              <span className="animate-shimmer inline-block h-2 w-2 rounded-full bg-zinc-500" />
              <span className="animate-shimmer inline-block h-2 w-2 rounded-full bg-zinc-500 [animation-delay:150ms]" />
              <span className="animate-shimmer inline-block h-2 w-2 rounded-full bg-zinc-500 [animation-delay:300ms]" />
            </span>
          ) : isUser ? (
            <p className="whitespace-pre-wrap break-words">{content}</p>
          ) : (
            <AssistantMarkdown content={content} />
          )}
        </div>
      </div>
    </div>
  );
}
