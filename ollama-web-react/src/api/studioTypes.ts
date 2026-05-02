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
}

export interface StudioLastBuild {
  at: number;
  ok: boolean;
  exitCode: number;
  /** Как выполнялась сборка: контейнер или хост (см. STUDIO_BUILD_EXECUTOR). */
  executor?: 'docker' | 'host';
  log: string;
}
