import { Link } from 'react-router-dom';
import type { ChatSession } from '../types/chat';

interface SidebarProps {
  sessions: ChatSession[];
  activeId: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
}

export function Sidebar({
  sessions,
  activeId,
  disabled,
  onSelect,
  onNewChat,
  onDeleteChat,
}: SidebarProps) {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-white/[0.06] bg-black/25 backdrop-blur-xl">
      <div className="p-4">
        <button
          type="button"
          disabled={disabled}
          onClick={onNewChat}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-medium text-zinc-100 shadow-lg shadow-black/20 transition hover:border-accent/40 hover:bg-accent/15 hover:text-white active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40"
        >
          <span className="text-lg leading-none">+</span>
          Новый чат
        </button>
      </div>

      <nav className="scrollbar-thin flex flex-1 flex-col gap-1 overflow-y-auto px-2 pb-4">
        <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Чаты
        </p>
        {sorted.map((s) => {
          const sel = s.id === activeId;
          return (
            <div
              key={s.id}
              className={`group relative flex items-stretch rounded-xl transition-all duration-200 ${
                sel ? 'bg-white/[0.09] shadow-inner shadow-black/30' : 'hover:bg-white/[0.05]'
              }`}
            >
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(s.id)}
                className={`min-w-0 flex-1 px-3 py-2.5 text-left transition-colors ${
                  sel ? 'text-white' : 'text-zinc-400 hover:text-zinc-100'
                } disabled:pointer-events-none disabled:opacity-40`}
              >
                <span className="block truncate text-sm font-medium">{s.title}</span>
                <span className="mt-0.5 block text-[11px] text-zinc-500 group-hover:text-zinc-400">
                  {new Date(s.updatedAt).toLocaleString('ru-RU', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </button>
              <button
                type="button"
                disabled={disabled}
                title="Удалить чат"
                aria-label="Удалить чат"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDeleteChat(s.id);
                }}
                className="shrink-0 px-2 text-zinc-500 opacity-70 transition hover:bg-white/[0.08] hover:text-red-300 hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
              >
                ✕
              </button>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-white/[0.06] p-4">
        <Link
          to="/lovable"
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5 text-xs font-medium text-emerald-100 transition hover:border-emerald-400/45 hover:bg-emerald-500/18"
        >
          Студия сайтов
          <span className="text-[10px] font-normal text-emerald-200/70">/lovable</span>
        </Link>
        <div className="rounded-xl bg-white/[0.04] px-3 py-2 text-[11px] text-zinc-500 backdrop-blur-sm">
          История на сервере · cookie user_id
        </div>
      </div>
    </aside>
  );
}
