import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

/** Запланированные возможности автоматизации — бэкенд агента подключится позже. */
const AGENT_TOOLCHAIN = [
  'scaffold · npm create vite@latest',
  'deps · npm ci / lockfile',
  'preview · ephemeral dev URL',
  'lint/test · CI hooks',
  'container · Dockerfile + compose',
  'smoke · Playwright / curl health',
] as const;

interface AgentTask {
  id: string;
  title: string;
  done: boolean;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'agent';
  content: string;
}

const DEMO_PREVIEW_HTML = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Превью</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,sans-serif;background:linear-gradient(145deg,#0b1220 0%,#132038 45%,#0d2818 100%);color:#cbd5e1}
.card{max-width:22rem;text-align:center;padding:2rem 1.75rem;border-radius:1rem;border:1px solid rgba(148,163,184,.25);background:rgba(15,23,42,.65);box-shadow:0 24px 80px rgba(0,0,0,.35)}
.dot{width:.65rem;height:.65rem;border-radius:999px;background:#34d399;display:inline-block;margin-right:.35rem;vertical-align:middle;animation:p 1.4s ease-in-out infinite}
@keyframes p{0%,100%{opacity:.35}50%{opacity:1}}
small{display:block;margin-top:.75rem;font-size:.72rem;color:#64748b;line-height:1.45}
</style></head><body><div class="card"><p><span class="dot"></span>Демо-превью</p><small>Позже здесь будет iframe на поднятый агентом dev-сервер или статический билд из CI.</small></div></body></html>`;

export function LovableStudio() {
  const [previewKey, setPreviewKey] = useState(0);
  const [tasks, setTasks] = useState<AgentTask[]>([
    { id: '1', title: 'Инициализировать репозиторий и Vite + React + TS', done: false },
    { id: '2', title: 'Подключить Tailwind и базовые UI-компоненты', done: false },
    { id: '3', title: 'Выдать URL превью (изолированная песочница)', done: false },
  ]);
  const [messages, setMessages] = useState<ChatTurn[]>([
    {
      id: 'w',
      role: 'agent',
      content:
        'Опишите сайт или приложение одним сообщением — я разложу это на задачи, предложу стек и подготовлю превью. Позже этот канал будет связан с оркестратором агента на сервере.',
    },
  ]);
  const [draft, setDraft] = useState('');

  const previewSrcDoc = useMemo(() => DEMO_PREVIEW_HTML, []);

  const toggleTask = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    );
  }, []);

  const sendDraft = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const uid = () =>
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', content: text },
      {
        id: uid(),
        role: 'agent',
        content:
          'Черновой интерфейс: сообщение записано локально. Следующий шаг — API проекта (`POST /api/studio/...`) и runner для превью, чтобы агент реально поднимал `vite dev` или статический билд.',
      },
    ]);
    setDraft('');
  }, [draft]);

  return (
    <div className="flex h-full min-h-[100dvh] flex-col bg-[radial-gradient(ellipse_at_top,_rgba(16,163,127,0.14),transparent_55%),radial-gradient(ellipse_at_bottom,_rgba(120,80,220,0.1),transparent_52%)]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] bg-black/30 px-4 py-3 backdrop-blur-xl md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/"
            className="shrink-0 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-accent/35 hover:bg-accent/15 hover:text-white"
          >
            ← Чат
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight text-white md:text-base">
              Студия сайтов
            </h1>
            <p className="truncate text-[11px] text-zinc-500 md:text-xs">
              Контекстное редактирование · превью · задачи для агента
            </p>
          </div>
          <span className="hidden shrink-0 rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-100 sm:inline">
            MVP
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-300 transition hover:border-white/20 hover:text-white"
            onClick={() => setPreviewKey((k) => k + 1)}
          >
            Обновить превью
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex max-h-[38vh] shrink-0 flex-col border-b border-white/[0.06] bg-black/20 lg:h-auto lg:max-h-none lg:w-[280px] lg:border-b-0 lg:border-r">
          <div className="border-b border-white/[0.06] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Проект
            </p>
            <p className="mt-2 truncate text-sm font-medium text-zinc-100">
              new-site · Vite React TS
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">Ветка main · локальный черновик</p>
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Файлы (заглушка)
            </p>
            <ul className="mt-3 space-y-1.5 font-mono text-[12px] text-zinc-400">
              <li className="rounded-md bg-white/[0.04] px-2 py-1">src/App.tsx</li>
              <li className="rounded-md px-2 py-1">src/index.css</li>
              <li className="rounded-md px-2 py-1">index.html</li>
              <li className="rounded-md px-2 py-1">package.json</li>
            </ul>

            <p className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Задачи агента
            </p>
            <ul className="mt-3 space-y-2">
              {tasks.map((t) => (
                <li key={t.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 transition hover:border-white/10 hover:bg-white/[0.04]">
                    <input
                      type="checkbox"
                      checked={t.done}
                      onChange={() => toggleTask(t.id)}
                      className="mt-0.5 accent-emerald-500"
                    />
                    <span
                      className={`text-[13px] leading-snug ${t.done ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}
                    >
                      {t.title}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-white/[0.06] lg:border-b-0">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] bg-black/15 px-3 py-2 md:px-4">
            <span className="text-[11px] text-zinc-500">Превью</span>
            <code className="truncate rounded-md bg-black/40 px-2 py-1 font-mono text-[11px] text-emerald-200/90 ring-1 ring-white/10">
              https://preview.<span className="text-zinc-500">…</span>/session‑xxxx
            </code>
          </div>
          <div className="relative min-h-[240px] flex-1 bg-zinc-950/80 p-3 md:p-4">
            <iframe
              key={previewKey}
              title="Превью проекта"
              className="h-full min-h-[220px] w-full rounded-xl border border-white/10 bg-black shadow-inner shadow-black/40"
              sandbox="allow-scripts allow-forms allow-popups-to-escape-sandbox"
              srcDoc={previewSrcDoc}
            />
          </div>
          <div className="shrink-0 border-t border-white/[0.06] bg-black/25 px-3 py-3 md:px-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Инструменты для агентов (дорожная карта)
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {AGENT_TOOLCHAIN.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-white/[0.08] bg-white/[0.05] px-2.5 py-1 font-mono text-[10px] text-zinc-400"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        </section>

        <aside className="flex max-h-[46vh] min-h-[200px] shrink-0 flex-col bg-black/25 lg:h-auto lg:max-h-none lg:w-[min(100%,380px)] lg:border-l lg:border-white/[0.06]">
          <div className="border-b border-white/[0.06] px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Контекст · запрос к агенту
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {['Лендинг SaaS', 'Портфолио', 'Dashboard админки'].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setDraft((d) => (d ? `${d}\n${s}` : `Сделай ${s.toLowerCase()} на React + Vite + Tailwind.`))}
                  className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-[11px] text-emerald-100 transition hover:bg-accent/20"
                >
                  + {s}
                </button>
              ))}
            </div>
          </div>

          <div className="scrollbar-thin flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-xl px-3 py-2.5 text-[13px] leading-relaxed ring-1 ${
                  m.role === 'user'
                    ? 'ml-6 bg-violet-600/25 text-zinc-100 ring-violet-500/25'
                    : 'mr-4 bg-white/[0.06] text-zinc-200 ring-white/[0.06]'
                }`}
              >
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  {m.role === 'user' ? 'Вы' : 'Агент'}
                </span>
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            ))}
          </div>

          <div className="border-t border-white/[0.06] p-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Опишите проект: цели, секции, стиль, интеграции…"
              rows={3}
              className="w-full resize-none rounded-xl border border-white/10 bg-black/45 px-3 py-2.5 text-[13px] text-zinc-100 placeholder:text-zinc-600 ring-1 ring-black/30 focus:border-accent/40 focus:ring-accent/20"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendDraft();
                }
              }}
            />
            <button
              type="button"
              onClick={sendDraft}
              className="mt-2 w-full rounded-xl border border-accent/35 bg-accent/20 py-2.5 text-sm font-medium text-white shadow-lg shadow-black/25 transition hover:bg-accent/30 active:scale-[0.99]"
            >
              Отправить агенту
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
