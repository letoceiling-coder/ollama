import type { StudioProject } from './studioTypes';

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
