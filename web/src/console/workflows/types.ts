export const WORKFLOW_AUTO_ACTIONS = {
  viewWorkflowTab: "console.workflows.tab.workflow.view",
  viewScheduleTab: "console.workflows.tab.schedule.view",
  selectWorkflow: "console.workflows.workflow.select",
  toggleWorkflow: "console.workflows.workflow.toggle",
  runWorkflow: "console.workflows.workflow.run",
  simulateWorkflow: "console.workflows.workflow.simulate",
  stagePublish: "console.workflows.workflow.publish.stage",
  approvePublish: "console.workflows.workflow.publish.approve",
  withdrawPublish: "console.workflows.workflow.publish.withdraw",
  selectSchedule: "console.workflows.schedule.select",
  createSchedule: "console.workflows.schedule.create",
  toggleSchedule: "console.workflows.schedule.toggle",
  runSchedule: "console.workflows.schedule.run",
  editSchedule: "console.workflows.schedule.edit",
  saveSchedule: "console.workflows.schedule.save",
  deleteSchedule: "console.workflows.schedule.delete",
} as const;

export type WorkflowAutoTab = "workflow" | "schedule";
export type WorkflowBlockKind = "trigger" | "condition" | "branch" | "action";
export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";
export type WorkflowResult = "ok" | "warn" | "error";

export interface WorkflowCanvasBlock {
  id: string;
  kind: WorkflowBlockKind;
  title: string;
  detail?: string;
  chips?: string[];
  outputs?: WorkflowCanvasBlockOutput[];
}

export interface WorkflowCanvasBlockOutput {
  label: string;
  port?: string;
}

export interface WorkflowRunEvent {
  id: string;
  code?: string;
  at: string;
  actor: string;
  status: WorkflowRunStatus;
  label: string;
  error?: string;
  generatedObjects?: string[];
  retryable?: boolean;
  retryCount?: number;
}

export interface PendingRevisionSummary {
  version: number;
  stagedBy: string;
  stagedById?: string;
  status: "pending_review" | "withdrawable";
}

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  version: number;
  runs: number;
  lastRun: string;
  lastResult: WorkflowResult;
  blocks: WorkflowCanvasBlock[];
  runLog: WorkflowRunEvent[];
  pendingRevision?: PendingRevisionSummary;
}

export interface ScheduleSummary {
  id: string;
  workflowId?: string;
  name: string;
  active: boolean;
  cron: string;
  cronLabel: string;
  nextRun: string;
  lastRun: string;
  lastResult: WorkflowResult;
  runLog: WorkflowRunEvent[];
}

export interface ScheduleDraft {
  name: string;
  cron: string;
  cronLabel: string;
  active: boolean;
}

export interface WorkflowAutoModel {
  workflows: WorkflowSummary[];
  schedules: ScheduleSummary[];
}
