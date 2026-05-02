import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  approveStudioPlan,
  createStudioProject,
  getStudioFileContent,
  getStudioProject,
  getStudioProjects,
  getStudioWorkspaceFiles,
  postStudioPlan,
  postStudioPreviewBuild,
  putStudioFileContent,
  studioPreviewUrl,
} from '../api/studioClient';
import type { StudioProject } from '../api/studioTypes';
import { buildPlanOutlineFromUserPrompt } from '../studio/planOutline';

/** Запланированные возможности — roadmap UI */
const AGENT_TOOLCHAIN = [
  'scaffold · npm create vite@latest',
  'deps · npm ci / lockfile',
  'preview · static build + URL',
  'lint/test · CI hooks',
  'container · Docker',
] as const;

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
</style></head><body><div class="card"><p><span class="dot"></span>Превью после сборки</p><small>После согласования плана здесь появится iframe на собранный билд из runner (фаза 2).</small></div></body></html>`;

const QK = {
  projects: ['studio', 'projects'] as const,
  project: (id: string) => ['studio', 'project', id] as const,
};

function statusLabel(s: StudioProject['taskStatus']): string {
  const map: Record<string, string> = {
    idle: 'Ожидание',
    planning: 'Планирование',
    awaiting_user_approval: 'Ждёт согласования',
    implementing: 'Реализация',
    building: 'Сборка',
    ready_for_review: 'Проверка',
    done: 'Готово',
    failed: 'Ошибка',
  };
  return map[s] || s;
}

export function LovableStudio() {
  const queryClient = useQueryClient();
  const [previewKey, setPreviewKey] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([
    {
      id: 'w',
      role: 'agent',
      content:
        'Опишите сайт или приложение. Я составлю **план** и отправлю его на ваше согласование. После «Согласовать и запустить» будет запущена реализация и сборка (runner подключается на следующей фазе).',
    },
  ]);
  const [draft, setDraft] = useState('');
  const [flowError, setFlowError] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: QK.projects,
    queryFn: getStudioProjects,
  });

  const createProjectMu = useMutation({
    mutationFn: () => createStudioProject({ name: 'Мой проект · студия' }),
    onSuccess: (proj) => {
      setProjectId(proj.id);
      void queryClient.invalidateQueries({ queryKey: QK.projects });
    },
  });

  useEffect(() => {
    if (!projectsQuery.isSuccess) return;
    if (projectsQuery.data.length === 0 && !createProjectMu.isPending && !createProjectMu.isSuccess && !createProjectMu.isError) {
      createProjectMu.mutate();
    }
    if (projectsQuery.data.length > 0 && !projectId) {
      setProjectId(projectsQuery.data[0].id);
    }
  }, [projectsQuery.isSuccess, projectsQuery.data, projectId, createProjectMu]);

  const projectQuery = useQuery({
    queryKey: projectId ? QK.project(projectId) : ['studio', 'project', 'none'],
    queryFn: () => getStudioProject(projectId!),
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.taskStatus === 'building' ? 1500 : false),
  });

  const project = projectQuery.data;

  const postPlanMu = useMutation({
    mutationFn: ({ id, md }: { id: string; md: string }) => postStudioPlan(id, md, 'pending_approval'),
    onSuccess: (_, { md }) => {
      void queryClient.invalidateQueries({ queryKey: QK.projects });
      if (projectId) void queryClient.invalidateQueries({ queryKey: QK.project(projectId) });
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'agent',
          content:
            'План сохранён и отправлен на **согласование**. Проверьте блок слева и нажмите «Согласовать и запустить», когда готовы.\n\n---\n' +
            md.slice(0, 1200) +
            (md.length > 1200 ? '\n…' : ''),
        },
      ]);
    },
    onError: (e: Error) => setFlowError(e.message),
  });

  const approveMu = useMutation({
    mutationFn: (id: string) => approveStudioPlan(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QK.projects });
      if (projectId) void queryClient.invalidateQueries({ queryKey: QK.project(projectId) });
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'agent',
          content:
            'План **согласован**. Нажмите **Собрать превью** слева: шаблон Vite в workspace, `npm ci` и `npm run build`; готовый билд откроется в превью.',
        },
      ]);
    },
    onError: (e: Error) => setFlowError(e.message),
  });

  const buildMu = useMutation({
    mutationFn: (id: string) => postStudioPreviewBuild(id),
    onSuccess: () => {
      setFlowError(null);
      void queryClient.invalidateQueries({ queryKey: QK.projects });
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: QK.project(projectId) });
        void queryClient.invalidateQueries({ queryKey: ['studio', 'files', projectId] });
      }
      setPreviewKey((k) => k + 1);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'agent',
          content:
            'Сборка запущена. Дождитесь статуса «Проверка» — тогда превью подгрузится в iframe.',
        },
      ]);
    },
    onError: (e: Error) => setFlowError(e.message),
  });

  const previewSrcDoc = useMemo(() => DEMO_PREVIEW_HTML, []);

  const sendDraft = useCallback(() => {
    setFlowError(null);
    const text = draft.trim();
    if (!text || !projectId) return;
    const md = buildPlanOutlineFromUserPrompt(text);
    const uid = () => crypto.randomUUID();
    setMessages((prev) => [...prev, { id: uid(), role: 'user', content: text }]);
    setDraft('');
    postPlanMu.mutate({ id: projectId, md });
  }, [draft, projectId, postPlanMu]);

  const [editorDraft, setEditorDraft] = useState('');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const filesQuery = useQuery({
    queryKey: ['studio', 'files', projectId],
    queryFn: () => getStudioWorkspaceFiles(projectId!),
    enabled: !!projectId,
  });

  const fileContentQuery = useQuery({
    queryKey: ['studio', 'file', projectId, selectedFilePath],
    queryFn: () => getStudioFileContent(projectId!, selectedFilePath!),
    enabled: !!projectId && !!selectedFilePath,
  });

  useEffect(() => {
    setEditorDraft('');
  }, [selectedFilePath]);

  useEffect(() => {
    if (fileContentQuery.data?.content !== undefined) {
      setEditorDraft(fileContentQuery.data.content);
    }
  }, [fileContentQuery.data?.path, fileContentQuery.data?.mtime]);

  const saveFileMu = useMutation({
    mutationFn: () => putStudioFileContent(projectId!, selectedFilePath!, editorDraft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['studio', 'files', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['studio', 'file', projectId, selectedFilePath] });
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'agent',
          content: `Файл **${selectedFilePath}** сохранён в workspace.`,
        },
      ]);
    },
    onError: (e: Error) => setFlowError(e.message),
  });

  const busy =
    postPlanMu.isPending ||
    approveMu.isPending ||
    createProjectMu.isPending ||
    buildMu.isPending ||
    saveFileMu.isPending;

  const iframeRealSrc =
    project?.taskStatus === 'ready_for_review' && projectId
      ? project.previewSharePath || studioPreviewUrl(projectId)
      : null;

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
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
              План → согласование → сборка
            </p>
          </div>
          {project ? (
            <span className="hidden max-w-[10rem] truncate rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-100 sm:inline">
              {statusLabel(project.taskStatus)}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-300 transition hover:border-white/20 hover:text-white disabled:opacity-40"
            onClick={() => setPreviewKey((k) => k + 1)}
            disabled={!project}
          >
            Обновить превью
          </button>
        </div>
      </header>

      {flowError ? (
        <div className="border-b border-red-500/30 bg-red-950/40 px-4 py-2 text-center text-xs text-red-200">
          {flowError}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => setFlowError(null)}
          >
            закрыть
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex max-h-[42vh] shrink-0 flex-col border-b border-white/[0.06] bg-black/20 lg:h-auto lg:max-h-none lg:w-[300px] lg:border-b-0 lg:border-r">
          <div className="border-b border-white/[0.06] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Проект (API)
            </p>
            {projectsQuery.isLoading ? (
              <p className="mt-2 text-sm text-zinc-400">Загрузка…</p>
            ) : projectsQuery.isError ? (
              <p className="mt-2 text-sm text-red-300">Не удалось загрузить проекты</p>
            ) : project ? (
              <>
                <p className="mt-2 truncate text-sm font-medium text-zinc-100">{project.name}</p>
                <p className="mt-1 font-mono text-[11px] text-zinc-500">
                  {project.slug} · {project.id.slice(0, 8)}…
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-zinc-400">Создаём проект…</p>
            )}
          </div>

          <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              План
            </p>
            {project && project.plan.markdown && project.plan.status !== 'none' ? (
              <div className="mt-2 rounded-lg border border-white/10 bg-black/35 p-3 text-[12px] text-zinc-300">
                <p className="mb-2 text-[10px] uppercase text-zinc-500">
                  Статус плана: {project.plan.status}
                </p>
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-[11px] leading-relaxed">
                  {project.plan.markdown}
                </pre>
                {project.plan.status === 'pending_approval' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => projectId && approveMu.mutate(projectId)}
                    className="mt-3 w-full rounded-lg border border-accent/40 bg-accent/25 py-2 text-sm font-medium text-white transition hover:bg-accent/35 disabled:opacity-40"
                  >
                    Согласовать и запустить
                  </button>
                ) : null}
                {project.plan.status === 'approved' ? (
                  <div className="mt-3 space-y-2">
                    <p className="text-[11px] text-emerald-200/90">Согласовано. Запустите сборку превью.</p>
                    {project.taskStatus === 'failed' && project.lastBuild?.log ? (
                      <details className="rounded border border-red-500/30 bg-red-950/30 p-2 text-[10px] text-red-100">
                        <summary className="cursor-pointer font-medium">Лог ошибки сборки</summary>
                        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-zinc-300">
                          {project.lastBuild.log.slice(-4000)}
                        </pre>
                      </details>
                    ) : null}
                    {(project.taskStatus === 'implementing' ||
                      project.taskStatus === 'building' ||
                      project.taskStatus === 'failed' ||
                      project.taskStatus === 'ready_for_review') ? (
                      <button
                        type="button"
                        disabled={busy || project.taskStatus === 'building'}
                        onClick={() => projectId && buildMu.mutate(projectId)}
                        className="w-full rounded-lg border border-sky-500/40 bg-sky-500/15 py-2 text-sm font-medium text-sky-100 transition hover:bg-sky-500/25 disabled:opacity-40"
                      >
                        {project.taskStatus === 'building'
                          ? 'Сборка…'
                          : project.taskStatus === 'ready_for_review'
                            ? 'Пересобрать превью'
                            : 'Собрать превью'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-[12px] text-zinc-500">
                Отправьте описание в чат справа — появится черновой план и кнопка согласования.
              </p>
            )}

            <p className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Файлы workspace
            </p>
            {!projectId ? (
              <p className="mt-2 text-[12px] text-zinc-500">Ожидаем проект…</p>
            ) : filesQuery.isLoading ? (
              <p className="mt-2 text-[12px] text-zinc-400">Загрузка списка…</p>
            ) : filesQuery.isError ? (
              <p className="mt-2 text-[12px] text-red-300">Не удалось загрузить файлы</p>
            ) : (
              <div className="mt-2 space-y-2">
                <ul className="scrollbar-thin max-h-36 list-none space-y-0.5 overflow-y-auto font-mono text-[11px] text-zinc-400">
                  {filesQuery.data?.length ? (
                    filesQuery.data.map((f) => (
                      <li key={f.path}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setSelectedFilePath(f.path);
                            setFlowError(null);
                          }}
                          className={`w-full truncate rounded-md px-2 py-1 text-left transition ${
                            selectedFilePath === f.path
                              ? 'bg-accent/20 text-emerald-100 ring-1 ring-accent/30'
                              : 'bg-white/[0.04] hover:bg-white/[0.07]'
                          } disabled:opacity-40`}
                        >
                          {f.path}
                          <span className="ml-1 text-zinc-600">({f.size} B)</span>
                        </button>
                      </li>
                    ))
                  ) : (
                    <li className="px-2 text-zinc-500">Нет файлов (шаблон появится после первого открытия проекта)</li>
                  )}
                </ul>
                {selectedFilePath ? (
                  <div className="rounded-lg border border-white/10 bg-black/35 p-2">
                    <p className="mb-1 truncate font-mono text-[10px] text-zinc-500">{selectedFilePath}</p>
                    {fileContentQuery.isLoading ? (
                      <p className="text-[11px] text-zinc-500">Чтение…</p>
                    ) : fileContentQuery.isError ? (
                      <p className="text-[11px] text-red-300">Ошибка чтения</p>
                    ) : (
                      <>
                        <textarea
                          value={editorDraft}
                          onChange={(e) => setEditorDraft(e.target.value)}
                          disabled={busy}
                          spellCheck={false}
                          className="scrollbar-thin mt-1 max-h-48 min-h-[8rem] w-full resize-y rounded-md border border-white/10 bg-black/50 px-2 py-1.5 font-mono text-[11px] text-zinc-200 focus:border-accent/40 disabled:opacity-45"
                          rows={10}
                        />
                        <button
                          type="button"
                          disabled={busy || fileContentQuery.isFetching}
                          onClick={() => saveFileMu.mutate()}
                          className="mt-2 w-full rounded-md border border-emerald-500/40 bg-emerald-500/15 py-1.5 text-[12px] font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-40"
                        >
                          Сохранить файл
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-600">Выберите файл для просмотра и правки.</p>
                )}
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-white/[0.06] lg:border-b-0">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] bg-black/15 px-3 py-2 md:px-4">
            <span className="text-[11px] text-zinc-500">Превью</span>
            <code className="truncate rounded-md bg-black/40 px-2 py-1 font-mono text-[11px] text-emerald-200/90 ring-1 ring-white/10">
              {iframeRealSrc || '—'}
            </code>
          </div>
          <div className="relative min-h-[240px] flex-1 bg-zinc-950/80 p-3 md:p-4">
            <iframe
              key={`${previewKey}-${iframeRealSrc ?? 'demo'}`}
              title="Превью проекта"
              className="h-full min-h-[220px] w-full rounded-xl border border-white/10 bg-black shadow-inner shadow-black/40"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups-to-escape-sandbox"
              src={iframeRealSrc ?? undefined}
              srcDoc={iframeRealSrc ? undefined : previewSrcDoc}
            />
          </div>
          <div className="shrink-0 border-t border-white/[0.06] bg-black/25 px-3 py-3 md:px-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Инструменты агента (roadmap)
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
              Запрос · план
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {['Лендинг SaaS', 'Портфолио', 'Dashboard'].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() =>
                    setDraft((d) => (d ? `${d}\n${s}` : `Сделай ${s.toLowerCase()} на React + Vite + Tailwind.`))
                  }
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
              placeholder="Опишите проект: цели, секции, стиль…"
              rows={3}
              disabled={!projectId || busy}
              className="w-full resize-none rounded-xl border border-white/10 bg-black/45 px-3 py-2.5 text-[13px] text-zinc-100 placeholder:text-zinc-600 ring-1 ring-black/30 focus:border-accent/40 focus:ring-accent/20 disabled:opacity-45"
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
              disabled={!projectId || busy}
              className="mt-2 w-full rounded-xl border border-accent/35 bg-accent/20 py-2.5 text-sm font-medium text-white shadow-lg shadow-black/25 transition hover:bg-accent/30 active:scale-[0.99] disabled:opacity-40"
            >
              {postPlanMu.isPending ? 'Отправка плана…' : 'Составить план и отправить на согласование'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
