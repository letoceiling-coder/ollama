export type StudioPlanStatus = 'none' | 'draft' | 'pending_approval' | 'approved';

export type StudioTaskStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_user_approval'
  | 'implementing'
  | 'building'
  | 'ready_for_review'
  | 'done'
  | 'failed';

export interface StudioPlan {
  markdown: string;
  status: StudioPlanStatus;
  updatedAt: number;
}

export interface StudioProject {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  plan: StudioPlan;
  taskStatus: StudioTaskStatus;
  lastBuild?: StudioLastBuild;
  /** Подписанная ссылка /preview/.../ для iframe и шаринга (TTL на сервере). */
  previewSharePath?: string | null;
  /** Последняя зафиксированная ревизия (POST …/revisions); для PATCH workspace base_revision_id. */
  headRevisionId?: string | null;
}

export interface StudioLastBuild {
  at: number;
  ok: boolean;
  exitCode: number;
  /** Как выполнялась сборка: контейнер или хост (см. STUDIO_BUILD_EXECUTOR). */
  executor?: 'docker' | 'host';
  log: string;
}

/** Запись в workspace (план §4.2). */
export interface StudioWorkspaceFileEntry {
  path: string;
  type: 'file';
  size: number;
  mtime: number;
}

export interface StudioFileContent {
  path: string;
  content: string;
  encoding: 'utf8';
  size: number;
  mtime: number;
}

export interface StudioRevisionSummary {
  id: string;
  parent_revision_id: string | null;
  message: string;
  createdAt: number;
  archiveBytes: number;
}

/** §4.3 задача агента */
export type StudioAgentTaskStatus =
  | 'open'
  | 'planning'
  | 'awaiting_task_plan_approval'
  | 'approved'
  | 'implementing'
  | 'done'
  | 'error';

export interface StudioTask {
  id: string;
  title: string;
  prompt: string;
  imagesCount: number;
  status: StudioAgentTaskStatus;
  planMarkdown: string;
  activeRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** События SSE …/agent/stream/:runId */
export type StudioAgentSse =
  | { type: 'delta'; payload: { text?: string } }
  | { type: 'plan_ready'; payload: { task_id?: string; markdown?: string } }
  | { type: 'tool_start' | 'tool_end'; payload: Record<string, unknown> }
  | { type: 'revision' | 'preview_url'; payload: Record<string, unknown> }
  | { type: 'error'; payload: { message?: string; detail?: string } }
  | { type: 'done'; payload: Record<string, unknown> };
