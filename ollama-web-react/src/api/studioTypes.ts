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
}
