import type {
  StudioFileContent,
  StudioProject,
  StudioRevisionSummary,
  StudioTask,
  StudioWorkspaceFileEntry,
} from './studioTypes';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const body = await r.json();
      detail = (body as { error?: string }).error || JSON.stringify(body);
    } catch {
      /* ignore */
    }
    throw new Error(`${r.status}: ${detail}`);
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

export async function getStudioProjects(): Promise<StudioProject[]> {
  const d = await jsonFetch<{ projects: StudioProject[] }>('/api/studio/projects');
  return d.projects;
}

export async function getStudioProject(projectId: string): Promise<StudioProject> {
  const d = await jsonFetch<{ project: StudioProject }>(
    `/api/studio/projects/${encodeURIComponent(projectId)}`,
  );
  return d.project;
}

export async function createStudioProject(body: {
  name: string;
  slug?: string;
}): Promise<StudioProject> {
  const d = await jsonFetch<{ project: StudioProject }>('/api/studio/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return d.project;
}

/** Сохранить план: по умолчанию на согласование; `draft` — только правка без кнопки «Согласовать». */
export async function postStudioPlan(
  projectId: string,
  markdown: string,
  mode: 'pending_approval' | 'draft' = 'pending_approval',
): Promise<StudioProject> {
  const d = await jsonFetch<{ project: StudioProject }>(
    `/api/studio/projects/${encodeURIComponent(projectId)}/plan`,
    {
      method: 'POST',
      body: JSON.stringify({
        markdown,
        status: mode === 'draft' ? 'draft' : undefined,
      }),
    },
  );
  return d.project;
}

export async function approveStudioPlan(projectId: string): Promise<StudioProject> {
  const d = await jsonFetch<{ project: StudioProject }>(
    `/api/studio/projects/${encodeURIComponent(projectId)}/plan/approve`,
    { method: 'POST', body: '{}' },
  );
  return d.project;
}

/** Диалог агента: уточнения, chips, при готовности — план на согласование. */
export async function postStudioAgentChat(
  projectId: string,
  body: { message: string },
): Promise<{ reply: string; chips: string[]; plan_updated: boolean; project: StudioProject }> {
  return jsonFetch(`/api/studio/projects/${encodeURIComponent(projectId)}/agent/chat`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** После согласования плана — LLM PATCH workspace (Vite scaffold). */
export async function postStudioApplyApprovedPlan(
  projectId: string,
): Promise<{ applied: number; revision_id: string | null }> {
  return jsonFetch(`/api/studio/projects/${encodeURIComponent(projectId)}/agent/apply-approved-plan`, {
    method: 'POST',
    body: '{}',
  });
}

/** Фаза 2: очередь сборки static preview (202 Accepted). */
export async function postStudioPreviewBuild(projectId: string): Promise<{ accepted: boolean }> {
  const r = await fetch(
    `/api/studio/projects/${encodeURIComponent(projectId)}/studio-build`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  if (r.status === 202) {
    return (await r.json()) as { accepted: boolean };
  }
  let detail = r.statusText;
  try {
    const body = await r.json();
    detail = (body as { error?: string }).error || JSON.stringify(body);
  } catch {
    /* ignore */
  }
  throw new Error(`${r.status}: ${detail}`);
}

export function studioPreviewUrl(projectId: string): string {
  return `/api/studio/projects/${encodeURIComponent(projectId)}/preview/`;
}

/** Фаза 1 (план §4.2): список файлов workspace. */
export async function getStudioWorkspaceFiles(projectId: string): Promise<StudioWorkspaceFileEntry[]> {
  const d = await jsonFetch<{ files: StudioWorkspaceFileEntry[] }>(
    `/api/studio/projects/${encodeURIComponent(projectId)}/files`,
  );
  return d.files;
}

export async function getStudioFileContent(projectId: string, filePath: string): Promise<StudioFileContent> {
  const q = new URLSearchParams({ path: filePath });
  return jsonFetch<StudioFileContent>(
    `/api/studio/projects/${encodeURIComponent(projectId)}/files/content?${q}`,
  );
}

export async function putStudioFileContent(
  projectId: string,
  filePath: string,
  content: string,
): Promise<{ ok: boolean; path: string; bytes: number }> {
  return jsonFetch(`/api/studio/projects/${encodeURIComponent(projectId)}/files/content`, {
    method: 'PUT',
    body: JSON.stringify({ path: filePath, content }),
  });
}

export async function getStudioRevisions(projectId: string): Promise<StudioRevisionSummary[]> {
  const d = await jsonFetch<{ revisions: StudioRevisionSummary[] }>(
    `/api/studio/projects/${encodeURIComponent(projectId)}/revisions`,
  );
  return d.revisions;
}

export async function postStudioRevision(
  projectId: string,
  body: { message?: string; parent_revision_id?: string | null } = {},
): Promise<{ revision_id: string }> {
  return jsonFetch(`/api/studio/projects/${encodeURIComponent(projectId)}/revisions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** План §4.2: батч-операций (после approve плана). */
export async function patchStudioWorkspace(
  projectId: string,
  payload: {
    base_revision_id?: string | null;
    operations: Array<
      | { op: 'write'; path: string; content_base64: string }
      | { op: 'delete'; path: string }
      | { op: 'mkdir'; path: string }
    >;
  },
): Promise<{ revision_id: string | null; applied: number }> {
  return jsonFetch(`/api/studio/projects/${encodeURIComponent(projectId)}/workspace`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/** §4.3 задачи */
export async function getStudioTasks(projectId: string): Promise<StudioTask[]> {
  const d = await jsonFetch<{ tasks: StudioTask[] }>(
    `/api/studio/projects/${encodeURIComponent(projectId)}/tasks`,
  );
  return d.tasks;
}

export async function postStudioTask(
  projectId: string,
  body: { title?: string; prompt: string; images?: string[] },
): Promise<{ task: { id: string; title: string; status: string } }> {
  return jsonFetch(`/api/studio/projects/${encodeURIComponent(projectId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function approveStudioTaskPlan(
  projectId: string,
  taskId: string,
): Promise<{ task: Pick<StudioTask, 'id' | 'title' | 'status' | 'planMarkdown'> }> {
  return jsonFetch(
    `/api/studio/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/approve-plan`,
    { method: 'POST', body: '{}' },
  );
}

/** 202 Accepted — затем EventSource на `studioAgentStreamUrl`. */
export async function postStudioAgentRun(
  projectId: string,
  body: { task_id: string; mode: 'plan' | 'implement' },
): Promise<{ run_id: string }> {
  const r = await fetch(`/api/studio/projects/${encodeURIComponent(projectId)}/agent/run`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 202) {
    return r.json() as Promise<{ run_id: string }>;
  }
  let detail = r.statusText;
  try {
    const b = await r.json();
    detail = (b as { error?: string }).error || JSON.stringify(b);
  } catch {
    /* */
  }
  throw new Error(`${r.status}: ${detail}`);
}

export function studioAgentStreamUrl(projectId: string, runId: string): string {
  return `/api/studio/projects/${encodeURIComponent(projectId)}/agent/stream/${encodeURIComponent(runId)}`;
}
